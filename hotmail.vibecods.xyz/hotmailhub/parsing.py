"""Mailbox line/CSV/JSON parsing and serialisation.

Supported lines (auto-detected, one mailbox per line):
    email:password:refresh_token:client_id        Hotmail/Outlook OAuth2 (also with | ; or tab)
    email;password                                 IMAP, host guessed from the domain
    email;password;imap.host[:port][;login]        IMAP with explicit host / shared inbox login
    email:password                                 IMAP
"#disabled <line>" keeps compatibility with the old mails.txt panel.
"""
from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass, field

UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
EMAIL_RE = re.compile(r"^[^\s@;:|,<>\"']+@[^\s@;:|,<>\"']+\.[^\s@;:|,<>\"']{2,}$")
DISABLED_PREFIX = "#disabled"


class ParseError(ValueError):
    pass


@dataclass
class Record:
    email: str
    password: str = ""
    refresh_token: str = ""
    client_id: str = ""
    imap_host: str = ""
    imap_port: int = 0
    login: str = ""
    note: str = ""
    tags: list[str] = field(default_factory=list)
    status: str = ""

    @property
    def oauth(self) -> bool:
        return bool(self.refresh_token and self.client_id)


@dataclass
class ParsedItem:
    line: int
    record: Record | None
    error: str = ""
    preview: str = ""


def clean_tags(value) -> list[str]:
    if isinstance(value, str):
        value = re.split(r"[,;\s]+", value)
    seen: list[str] = []
    for tag in value or []:
        tag = str(tag).strip().lower()[:32]
        if tag and tag not in seen:
            seen.append(tag)
    return seen[:20]


def _split_host(value: str) -> tuple[str, int]:
    host, _, port = value.strip().partition(":")
    if port:
        if not port.isdigit() or not 0 < int(port) < 65536:
            raise ParseError("некоректний порт IMAP")
        return host.strip().lower(), int(port)
    return host.strip().lower(), 0


def _check_email(email: str) -> str:
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise ParseError("некоректний email")
    return email


def parse_line(raw: str) -> Record:
    text = raw.strip().lstrip("\ufeff")
    status = ""
    if text.lower().startswith(DISABLED_PREFIX):
        text, status = text[len(DISABLED_PREFIX):].strip(), "disabled"
    if not text or text.startswith("#"):
        raise ParseError("порожній рядок")

    for sep in (";", "|", "\t"):
        if sep in text:
            break
    else:
        sep = ":"
    parts = [part.strip() for part in text.split(sep)]

    if len(parts) >= 4 and UUID_RE.match(parts[-1]):
        email = _check_email(parts[0])
        refresh_token, client_id = parts[-2], parts[-1]
        if not refresh_token:
            raise ParseError("порожній refresh_token")
        return Record(email, sep.join(parts[1:-2]), refresh_token, client_id, status=status)

    if len(parts) < 2 or not parts[1]:
        raise ParseError("очікується email;пароль або email:пароль:refresh_token:client_id")
    email = _check_email(parts[0])
    if sep == ":":
        if len(parts) != 2:
            raise ParseError("очікується email:пароль або email:пароль:refresh_token:client_id (UUID)")
        return Record(email, parts[1], status=status)
    if len(parts) > 4:
        raise ParseError("забагато полів; для OAuth останнім має бути client_id (UUID)")
    host, port = ("", 0)
    if len(parts) >= 3 and parts[2]:
        if parts[2].startswith("M.") or len(parts[2]) > 60:
            raise ParseError("для OAuth потрібен client_id (UUID) останнім полем")
        host, port = _split_host(parts[2])
    login = ""
    if len(parts) == 4 and parts[3]:
        login = _check_email(parts[3])
    return Record(email, parts[1], imap_host=host, imap_port=port, login=login, status=status)


def format_line(email, password="", refresh_token="", client_id="", imap_host="", imap_port=0, login="") -> str:
    if refresh_token and client_id:
        return f"{email}:{password}:{refresh_token}:{client_id}"
    parts = [email, password]
    if imap_host or login:
        parts.append(imap_host + (f":{imap_port}" if imap_port else ""))
        if login:
            parts.append(login)
    return ";".join(parts)


def preview(raw: str) -> str:
    """Safe one-line description of a raw line: never echoes passwords or tokens."""
    match = re.match(r"\s*(?:#disabled\s+)?([^\s;:|\t]+@[^\s;:|\t]+)", raw, re.I)
    if match:
        return match.group(1)[:80]
    return raw.strip()[:10] + "…"


_CSV_ALIASES = {
    "email": "email", "mail": "email", "address": "email", "e-mail": "email",
    "password": "password", "pass": "password", "pwd": "password",
    "refresh_token": "refresh_token", "refresh": "refresh_token", "rt": "refresh_token", "token": "refresh_token",
    "client_id": "client_id", "clientid": "client_id", "cid": "client_id",
    "imap_host": "imap_host", "host": "imap_host", "imap": "imap_host",
    "imap_port": "imap_port", "port": "imap_port",
    "login": "login", "username": "login",
    "note": "note", "comment": "note", "notes": "note",
    "tags": "tags", "tag": "tags", "group": "tags",
    "status": "status", "state": "status",
}
STATUSES = ("available", "leased", "used", "burned", "invalid", "disabled")


def record_from_mapping(data: dict) -> Record:
    item = {str(k).strip().lower(): v for k, v in data.items()}
    if "email" in item:
        mapped = {_CSV_ALIASES.get(k, k): v for k, v in item.items()}
    else:
        mapped = {("email" if k == "login" else _CSV_ALIASES.get(k, k)): v for k, v in item.items()}
    email = _check_email(str(mapped.get("email") or ""))
    refresh_token = str(mapped.get("refresh_token") or "").strip()
    client_id = str(mapped.get("client_id") or "").strip()
    if bool(refresh_token) != bool(client_id):
        raise ParseError("для OAuth потрібні і refresh_token, і client_id")
    host, port = _split_host(str(mapped.get("imap_host") or "")) if mapped.get("imap_host") else ("", 0)
    if mapped.get("imap_port") not in (None, ""):
        try:
            port = int(mapped["imap_port"])
        except (TypeError, ValueError) as exc:
            raise ParseError("некоректний порт IMAP") from exc
    login = str(mapped.get("login") or "").strip().lower()
    if login and "@" not in login:
        raise ParseError("login для IMAP має містити @")
    status = str(mapped.get("status") or "").strip().lower()
    if status and status not in STATUSES:
        raise ParseError(f"невідомий статус: {status}")
    password = str(mapped.get("password") or "")
    if not password and not refresh_token:
        raise ParseError("порожній пароль")
    return Record(email, password, refresh_token, client_id, host, port, login,
                  note=str(mapped.get("note") or "")[:500], tags=clean_tags(mapped.get("tags")), status=status)


def detect_format(text: str, filename: str = "") -> str:
    stripped = text.lstrip("\ufeff").lstrip()
    if stripped[:1] in "[{":
        return "json"
    first = next((ln for ln in stripped.splitlines() if ln.strip() and not ln.lstrip().startswith("#")), "")
    name = filename.lower()
    if name.endswith(".json"):
        return "json"
    if name.endswith(".csv") or ("@" not in first and re.search(r"(?i)\be-?mail\b|\baddress\b", first) and re.search(r"[,;\t]", first)):
        return "csv"
    return "lines"


def parse_text(text: str, filename: str = "") -> list[ParsedItem]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    kind = detect_format(text, filename)
    items: list[ParsedItem] = []
    if kind == "json":
        try:
            data = json.loads(text.lstrip("\ufeff"))
        except json.JSONDecodeError as exc:
            return [ParsedItem(1, None, f"некоректний JSON: {exc.msg}")]
        if isinstance(data, dict):
            data = data.get("mailboxes") or data.get("items") or [data]
        for index, entry in enumerate(data if isinstance(data, list) else [], 1):
            try:
                record = parse_line(entry) if isinstance(entry, str) else record_from_mapping(entry)
                items.append(ParsedItem(index, record, preview=record.email))
            except (ParseError, AttributeError, TypeError) as exc:
                label = preview(entry) if isinstance(entry, str) else str(entry.get("email", "")) if isinstance(entry, dict) else ""
                items.append(ParsedItem(index, None, str(exc), label))
        return items
    if kind == "csv":
        body = "\n".join(ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#"))
        try:
            dialect = csv.Sniffer().sniff(body.splitlines()[0], delimiters=",;\t")
        except (csv.Error, IndexError):
            dialect = csv.excel
        for index, row in enumerate(csv.DictReader(io.StringIO(body), dialect=dialect), 2):
            try:
                record = record_from_mapping({k: v for k, v in row.items() if k})
                items.append(ParsedItem(index, record, preview=record.email))
            except ParseError as exc:
                items.append(ParsedItem(index, None, str(exc), str(row.get("email", ""))[:80]))
        return items
    for number, raw in enumerate(text.splitlines(), 1):
        stripped = raw.strip()
        if not stripped or (stripped.startswith("#") and not stripped.lower().startswith(DISABLED_PREFIX)):
            continue
        try:
            record = parse_line(stripped)
            items.append(ParsedItem(number, record, preview=record.email))
        except ParseError as exc:
            items.append(ParsedItem(number, None, str(exc), preview(stripped)))
    return items


def decode_bytes(data: bytes) -> str:
    """Windows files come as UTF-8, UTF-8 with BOM, UTF-16 or cp1251."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", errors="replace")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1251", errors="replace")
