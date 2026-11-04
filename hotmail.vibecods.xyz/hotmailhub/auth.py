"""Admin password, signed session cookies, API keys and failed-attempt limiter."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .util import now

SCOPES = ("read", "code", "write", "secrets", "admin")
PRESETS = {
    "bas": ("read", "code", "write"),
    "readonly": ("read",),
    "admin": SCOPES,
}
PBKDF2_ROUNDS = 240_000


def hash_password(password: str, rounds: int = PBKDF2_ROUNDS) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, rounds)
    return f"pbkdf2_sha256${rounds}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, rounds, salt, digest = stored.split("$")
        if scheme != "pbkdf2_sha256":
            return False
        calc = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds))
        return hmac.compare_digest(calc.hex(), digest)
    except (ValueError, TypeError):
        return False


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


@dataclass(frozen=True)
class Identity:
    kind: str  # "session" | "key"
    name: str
    scopes: frozenset
    csrf: str = ""
    key_id: int | None = None

    def can(self, scope: str) -> bool:
        return "admin" in self.scopes or scope in self.scopes


class Limiter:
    """Blocks an address after repeated failures (login or bad API key)."""

    def __init__(self, limit: int = 10, window: int = 600) -> None:
        self.limit, self.window = limit, window
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _recent(self, ip: str) -> list[float]:
        cutoff = time.monotonic() - self.window
        hits = [h for h in self._hits.get(ip, []) if h > cutoff]
        self._hits[ip] = hits
        return hits

    def retry_after(self, ip: str) -> int:
        with self._lock:
            hits = self._recent(ip)
            if len(hits) < self.limit:
                return 0
            return max(1, int(hits[0] + self.window - time.monotonic()))

    def fail(self, ip: str) -> None:
        with self._lock:
            self._recent(ip).append(time.monotonic())

    def reset(self, ip: str) -> None:
        with self._lock:
            self._hits.pop(ip, None)


class Auth:
    def __init__(self, db, data_dir, session_ttl: int) -> None:
        self.db = db
        self.session_ttl = session_ttl
        self.limiter = Limiter()
        self.key_limiter = Limiter(limit=30)
        self._secret = self._load_secret(Path(data_dir) / "secret.key")

    @staticmethod
    def _load_secret(path: Path) -> bytes:
        if path.exists():
            return bytes.fromhex(path.read_text().strip())
        value = os.urandom(32)
        path.write_text(value.hex())
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return value

    # --- admin password -------------------------------------------------
    def _stored(self) -> str:
        row = self.db.one("SELECT value FROM settings WHERE key='admin_password_hash'")
        return row["value"] if row else ""

    def has_password(self) -> bool:
        return bool(self._stored())

    def set_password(self, password: str) -> None:
        if len(password) < 8:
            raise ValueError("пароль має містити щонайменше 8 символів")
        self.db.execute(
            "INSERT INTO settings(key,value) VALUES('admin_password_hash',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (hash_password(password),))

    def check_password(self, password: str) -> bool:
        stored = self._stored()
        return bool(stored) and verify_password(password, stored)

    # --- sessions ------------------------------------------------------
    def _sign(self, body: str) -> str:
        return _b64(hmac.new(self._secret, body.encode(), hashlib.sha256).digest())

    def _pwv(self) -> str:
        return hashlib.sha256(self._stored().encode()).hexdigest()[:10]

    def make_session(self) -> tuple[str, str, int]:
        csrf = secrets.token_urlsafe(18)
        payload = {"exp": now() + self.session_ttl, "csrf": csrf, "pwv": self._pwv()}
        body = _b64(json.dumps(payload, separators=(",", ":")).encode())
        return f"{body}.{self._sign(body)}", csrf, self.session_ttl

    def read_session(self, token: str) -> Identity | None:
        try:
            body, signature = token.split(".", 1)
            if not hmac.compare_digest(signature, self._sign(body)):
                return None
            payload = json.loads(_unb64(body))
        except (ValueError, TypeError):
            return None
        if payload.get("exp", 0) < now() or payload.get("pwv") != self._pwv():
            return None
        return Identity("session", "admin", frozenset(SCOPES), csrf=str(payload.get("csrf", "")))

    # --- API keys -------------------------------------------------------
    @staticmethod
    def _hash_key(plain: str) -> str:
        return hashlib.sha256(plain.encode()).hexdigest()

    @staticmethod
    def normalise_scopes(scopes) -> list[str]:
        if isinstance(scopes, str):
            scopes = PRESETS.get(scopes) or [s for s in scopes.replace(",", " ").split() if s]
        clean = [s for s in SCOPES if s in set(scopes or [])]
        if not clean:
            raise ValueError("потрібен принаймні один дозвіл: " + ", ".join(SCOPES))
        return clean

    def create_key(self, name: str, scopes) -> tuple[dict, str]:
        name = (name or "").strip()[:60]
        if not name:
            raise ValueError("вкажіть назву ключа")
        clean = self.normalise_scopes(scopes)
        plain = "hm_" + secrets.token_urlsafe(24)
        cursor = self.db.execute(
            "INSERT INTO api_keys(name,prefix,key_hash,scopes,created_at) VALUES(?,?,?,?,?)",
            (name, plain[:8], self._hash_key(plain), ",".join(clean), now()))
        return self.key_dict(self.db.one("SELECT * FROM api_keys WHERE id=?", (cursor.lastrowid,))), plain

    def find_key(self, plain: str) -> Identity | None:
        if not plain or len(plain) > 200:
            return None
        row = self.db.one("SELECT * FROM api_keys WHERE key_hash=? AND revoked_at IS NULL", (self._hash_key(plain),))
        if row is None:
            return None
        if not row["last_used_at"] or now() - row["last_used_at"] > 60:
            self.db.execute("UPDATE api_keys SET last_used_at=? WHERE id=?", (now(), row["id"]))
        return Identity("key", row["name"], frozenset(row["scopes"].split(",")), key_id=row["id"])

    def list_keys(self) -> list[dict]:
        return [self.key_dict(r) for r in self.db.query("SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY id")]

    def revoke_key(self, key_id: int) -> bool:
        cursor = self.db.execute("UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (now(), key_id))
        return cursor.rowcount > 0

    @staticmethod
    def key_dict(row) -> dict:
        from .util import iso
        return {"id": row["id"], "name": row["name"], "prefix": row["prefix"], "scopes": row["scopes"].split(","),
                "created_at": iso(row["created_at"]), "last_used_at": iso(row["last_used_at"])}
