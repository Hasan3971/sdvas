"""Mailbox access over IMAP: password login or Microsoft XOAUTH2 (refresh_token + client_id).

Provider contract (also implemented by the fake provider in tests):
    check(account)  -> CheckResult           raises AuthError / TemporaryError
    open(account)   -> session               session.recent(limit) -> [FetchedMessage]; session.close()
"""
from __future__ import annotations

import email
import email.policy
import email.utils
import imaplib
import json
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from .codes import html_to_text
from .util import now

IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access"
LEGACY_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access"
FATAL_OAUTH = {"invalid_grant", "invalid_scope", "interaction_required", "consent_required",
               "invalid_client", "unauthorized_client", "invalid_request"}
_MS = ("outlook.office365.com", 993)
IMAP_PRESETS: dict[str, tuple[str, int]] = {
    d: _MS for d in (
        "outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.de", "outlook.fr", "outlook.es",
        "outlook.it", "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es",
        "live.co.uk", "live.fr", "live.nl", "live.it", "live.de",
    )
}
MS_DOMAINS = frozenset(IMAP_PRESETS)
IMAP_PRESETS.update({
    "gmail.com": ("imap.gmail.com", 993), "googlemail.com": ("imap.gmail.com", 993),
    "yahoo.com": ("imap.mail.yahoo.com", 993), "ymail.com": ("imap.mail.yahoo.com", 993),
    "icloud.com": ("imap.mail.me.com", 993), "me.com": ("imap.mail.me.com", 993),
    "aol.com": ("imap.aol.com", 993), "zoho.com": ("imap.zoho.com", 993),
    "gmx.de": ("imap.gmx.net", 993), "gmx.net": ("imap.gmx.net", 993), "gmx.at": ("imap.gmx.net", 993),
    "gmx.com": ("imap.gmx.com", 993), "web.de": ("imap.web.de", 993),
    "rambler.ru": ("imap.rambler.ru", 993), "lenta.ru": ("imap.rambler.ru", 993),
    "ro.ru": ("imap.rambler.ru", 993), "autorambler.ru": ("imap.rambler.ru", 993),
    "yandex.ru": ("imap.yandex.ru", 993), "ya.ru": ("imap.yandex.ru", 993),
    "yandex.ua": ("imap.yandex.ru", 993), "yandex.com": ("imap.yandex.com", 993),
    "mail.ru": ("imap.mail.ru", 993), "bk.ru": ("imap.mail.ru", 993),
    "inbox.ru": ("imap.mail.ru", 993), "list.ru": ("imap.mail.ru", 993),
    "ukr.net": ("imap.ukr.net", 993), "meta.ua": ("imap.meta.ua", 993),
    "seznam.cz": ("imap.seznam.cz", 993), "wp.pl": ("imap.wp.pl", 993),
    "o2.pl": ("poczta.o2.pl", 993), "onet.pl": ("imap.poczta.onet.pl", 993),
})
JUNK_NAMES = ("Junk", "Junk Email", "Spam", "Bulk Mail", "INBOX.Junk", "INBOX.Spam")


class MailError(Exception):
    kind = "error"


class AuthError(MailError):
    """Credentials rejected for good (bad password, revoked token)."""
    kind = "auth"


class TemporaryError(MailError):
    """Network, throttling or server trouble: worth retrying."""
    kind = "temp"


@dataclass
class Account:
    id: int
    email: str
    password: str = ""
    refresh_token: str = ""
    client_id: str = ""
    imap_host: str = ""
    imap_port: int = 0
    login: str = ""

    @property
    def oauth(self) -> bool:
        return bool(self.refresh_token and self.client_id)

    @property
    def domain(self) -> str:
        return self.email.rsplit("@", 1)[-1].lower()


@dataclass
class FetchedMessage:
    uid_key: str
    folder: str
    sender: str
    recipient: str
    subject: str
    received_at: int
    body: str


@dataclass
class CheckResult:
    messages: int
    ms: int


def resolve_endpoint(acct: Account) -> tuple[str, int]:
    if acct.imap_host:
        return acct.imap_host, acct.imap_port or 993
    if acct.oauth:
        return _MS
    preset = IMAP_PRESETS.get(acct.domain)
    if preset:
        return preset[0], acct.imap_port or preset[1]
    return f"imap.{acct.domain}", acct.imap_port or 993


def provider_label(email_address: str, oauth: bool, imap_host: str = "") -> str:
    domain = email_address.rsplit("@", 1)[-1].lower()
    if domain in MS_DOMAINS or (oauth and not imap_host):
        return "Outlook · OAuth2" if oauth else "Outlook"
    host = imap_host or IMAP_PRESETS.get(domain, ("imap." + domain, 993))[0]
    return host


def _quote(folder: str) -> str:
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


_MONTHS = {m: i for i, m in enumerate(
    ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"), 1)}
_INTERNALDATE = re.compile(rb'INTERNALDATE "\s?(\d{1,2})-(\w{3})-(\d{4}) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)"')


def parse_internaldate(header) -> int | None:
    match = _INTERNALDATE.search(header if isinstance(header, bytes) else str(header).encode())
    if not match:
        return None
    day, mon, year, hh, mm, ss, sign, oh, om = match.groups()
    month = _MONTHS.get(mon.decode().title())
    if not month:
        return None
    offset = timedelta(hours=int(oh), minutes=int(om)) * (1 if sign == b"+" else -1)
    stamp = datetime(int(year), month, int(day), int(hh), int(mm), int(ss), tzinfo=timezone(offset))
    return int(stamp.timestamp())


def _header(message, name: str) -> str:
    try:
        return re.sub(r"\s+", " ", str(message.get(name, "") or "")).strip()
    except Exception:  # malformed headers must not break the fetch
        return ""


def _body_text(message) -> str:
    plain: list[str] = []
    markup: list[str] = []
    for part in message.walk():
        kind = part.get_content_type()
        if part.is_multipart() or kind not in ("text/plain", "text/html"):
            continue
        if part.get_content_disposition() == "attachment":
            continue
        try:
            content = part.get_content()
        except Exception:
            payload = part.get_payload(decode=True) or b""
            content = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
        (plain if kind == "text/plain" else markup).append(str(content))
    text = "\n".join(plain).strip()
    if len(text) < 20 and markup:
        text = (text + "\n" + html_to_text("\n".join(markup))).strip()
    return text[:30000]


def parse_message(raw: bytes, internal: int | None, folder: str, key: str) -> FetchedMessage:
    message = email.message_from_bytes(raw, policy=email.policy.default)
    received = internal
    if received is None:
        try:
            received = int(email.utils.parsedate_to_datetime(_header(message, "Date")).timestamp())
        except (TypeError, ValueError, OverflowError):
            received = now()
    recipient = ", ".join(x for x in (_header(message, "Delivered-To"), _header(message, "To")) if x)
    return FetchedMessage(key, folder, _header(message, "From")[:200], recipient[:300],
                          _header(message, "Subject")[:300], received, _body_text(message))


class OAuthClient:
    def __init__(self, token_url: str, timeout: int, post=None, on_rotate=None) -> None:
        self.token_url = token_url
        self.timeout = timeout
        self.on_rotate = on_rotate
        self._post = post or self._http_post
        self._cache: dict[str, tuple[str, float]] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _http_post(self, form: dict) -> dict:
        request = urllib.request.Request(
            self.token_url, data=urllib.parse.urlencode(form).encode(), method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json",
                     "User-Agent": "HotmailHub/2"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8", "replace"))
            except ValueError:
                payload = {}
            code = str(payload.get("error", ""))
            detail = str(payload.get("error_description", "")).split("\r\n")[0].split("\n")[0][:170]
            if exc.code == 429 or exc.code >= 500:
                raise TemporaryError(f"OAuth HTTP {exc.code}") from exc
            raise AuthError(f"OAuth {code or exc.code}: {detail}".strip(": ")) from exc
        except (urllib.error.URLError, OSError, TimeoutError, ValueError) as exc:
            raise TemporaryError(f"OAuth недоступний: {type(exc).__name__}") from exc

    def access_token(self, acct: Account, force: bool = False) -> str:
        key = f"{acct.email}|{acct.client_id}"
        with self._guard:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:
            cached = self._cache.get(key)
            if cached and not force and cached[1] > time.monotonic() + 60:
                return cached[0]
            payload = self._refresh(acct)
            token = str(payload.get("access_token", ""))
            if not token:
                raise AuthError("OAuth: у відповіді немає access_token")
            lifetime = int(payload.get("expires_in") or 3600)
            self._cache[key] = (token, time.monotonic() + max(120, lifetime - 120))
            rotated = str(payload.get("refresh_token", ""))
            if rotated and rotated != acct.refresh_token:
                previous, acct.refresh_token = acct.refresh_token, rotated
                if self.on_rotate:
                    self.on_rotate(acct.id, previous, rotated)
            return token

    def _refresh(self, acct: Account) -> dict:
        first_error: AuthError | None = None
        for scope in (IMAP_SCOPE, LEGACY_SCOPE):
            try:
                return self._post({"client_id": acct.client_id, "grant_type": "refresh_token",
                                   "refresh_token": acct.refresh_token, "scope": scope})
            except AuthError as exc:
                first_error = first_error or exc
        raise first_error  # type: ignore[misc]


class ImapSession:
    def __init__(self, provider: "LiveProvider", acct: Account, conn) -> None:
        self.provider, self.acct, self.conn = provider, acct, conn
        self.cache: dict[str, FetchedMessage] = {}
        self._folders: list[str] | None = None

    def _folder_list(self) -> list[str]:
        if self._folders is None:
            junk = self.provider.junk_folder(self.acct, self.conn)
            self._folders = ["INBOX"] + ([junk] if junk else [])
        return self._folders

    def recent(self, limit: int = 10) -> list[FetchedMessage]:
        found: list[FetchedMessage] = []
        try:
            self.conn.noop()
            for folder in self._folder_list():
                found.extend(self._fetch_folder(folder, limit if folder == "INBOX" else max(3, limit // 2)))
        except (imaplib.IMAP4.error, OSError) as exc:
            raise TemporaryError(f"IMAP: {str(exc)[:120]}") from exc
        found.sort(key=lambda item: item.received_at, reverse=True)
        return found

    def _fetch_folder(self, folder: str, limit: int) -> list[FetchedMessage]:
        status, _ = self.conn.select(_quote(folder), readonly=True)
        if status != "OK":
            return []
        validity = ""
        try:
            _kind, values = self.conn.response("UIDVALIDITY")
            validity = (values[0] or b"").decode() if values and values[0] else ""
        except Exception:
            pass
        status, data = self.conn.uid("SEARCH", None, "ALL")
        if status != "OK" or not data or not data[0]:
            return []
        result: list[FetchedMessage] = []
        for uid in reversed(data[0].split()[-limit:]):
            key = f"{folder}:{validity}:{uid.decode()}"
            message = self.cache.get(key) or self._fetch_one(uid, folder, key)
            if message is not None:
                self.cache[key] = message
                result.append(message)
        return result

    def _fetch_one(self, uid: bytes, folder: str, key: str) -> FetchedMessage | None:
        status, data = self.conn.uid("FETCH", uid, "(INTERNALDATE BODY.PEEK[]<0.300000>)")
        if status != "OK" or not data:
            return None
        for item in data:
            if isinstance(item, tuple) and len(item) > 1 and isinstance(item[1], (bytes, bytearray)):
                try:
                    return parse_message(bytes(item[1]), parse_internaldate(item[0]), folder, key)
                except Exception:
                    return None
        return None

    def close(self) -> None:
        self.provider.close_connection(self.conn)


class LiveProvider:
    def __init__(self, token_url: str, timeout: int = 20, max_connections: int = 12,
                 on_rotate=None, imap_factory=None, http_post=None) -> None:
        self.timeout = timeout
        self.oauth = OAuthClient(token_url, timeout, post=http_post, on_rotate=on_rotate)
        self._imap_factory = imap_factory or self._default_factory
        self._slots = threading.BoundedSemaphore(max_connections)
        self._junk: dict[str, str] = {}
        self._context = ssl.create_default_context()

    def _default_factory(self, host: str, port: int):
        return imaplib.IMAP4_SSL(host, port, timeout=self.timeout, ssl_context=self._context)

    def close_connection(self, conn) -> None:
        for action in ("close", "logout"):
            try:
                getattr(conn, action)()
            except Exception:
                pass
        self._slots.release()

    def _connect(self, acct: Account):
        if acct.domain in MS_DOMAINS and not acct.oauth and not acct.imap_host:
            raise AuthError("Outlook/Hotmail працює лише через OAuth2: потрібні refresh_token і client_id")
        if not self._slots.acquire(timeout=30):
            raise TemporaryError("забагато одночасних підключень до пошти")
        conn = None
        try:
            host, port = resolve_endpoint(acct)
            try:
                conn = self._imap_factory(host, port)
            except (OSError, imaplib.IMAP4.error) as exc:
                raise TemporaryError(f"IMAP {host}: {type(exc).__name__}") from exc
            self._login(conn, acct)
            return conn
        except BaseException:
            if conn is not None:
                try:
                    conn.logout()
                except Exception:
                    pass
            self._slots.release()
            raise

    def _login(self, conn, acct: Account) -> None:
        try:
            if not acct.oauth:
                conn.login(acct.login or acct.email, acct.password)
                return
            for attempt in (False, True):
                token = self.oauth.access_token(acct, force=attempt)
                payload = f"user={acct.email}\x01auth=Bearer {token}\x01\x01".encode()
                try:
                    conn.authenticate("XOAUTH2", lambda _challenge, data=payload: data)
                    return
                except imaplib.IMAP4.error:
                    if attempt:
                        raise
        except imaplib.IMAP4.error as exc:
            text = str(exc).strip(" ()'\"b")[:140]
            raise AuthError(f"IMAP: {text or 'вхід відхилено'}") from exc
        except OSError as exc:
            raise TemporaryError(f"IMAP: {type(exc).__name__}") from exc

    def junk_folder(self, acct: Account, conn) -> str:
        if acct.email in self._junk:
            return self._junk[acct.email]
        name = ""
        try:
            status, lines = conn.list()
            names: list[str] = []
            for line in lines or []:
                text = line.decode("utf-8", "replace") if isinstance(line, bytes) else str(line)
                match = re.match(r'\((?P<flags>[^)]*)\)\s+(?:"[^"]*"|NIL)\s+(?P<name>.+)$', text)
                if not match:
                    continue
                folder = match.group("name").strip().strip('"')
                names.append(folder)
                if "\\junk" in match.group("flags").lower() and not name:
                    name = folder
            if not name:
                lowered = {n.lower(): n for n in names}
                name = next((lowered[c.lower()] for c in JUNK_NAMES if c.lower() in lowered), "")
        except (imaplib.IMAP4.error, OSError):
            return ""
        self._junk[acct.email] = name
        return name

    def check(self, acct: Account) -> CheckResult:
        started = time.monotonic()
        conn = self._connect(acct)
        try:
            try:
                status, data = conn.select('"INBOX"', readonly=True)
            except (imaplib.IMAP4.error, OSError) as exc:
                raise TemporaryError(f"IMAP: {str(exc)[:100]}") from exc
            if status != "OK":
                raise TemporaryError("IMAP: не вдалося відкрити INBOX")
            count = int(data[0]) if data and data[0] else 0
        finally:
            self.close_connection(conn)
        return CheckResult(count, int((time.monotonic() - started) * 1000))

    def open(self, acct: Account) -> ImapSession:
        return ImapSession(self, acct, self._connect(acct))
