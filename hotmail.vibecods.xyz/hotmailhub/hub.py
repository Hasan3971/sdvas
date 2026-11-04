"""Business logic: mailbox pool, import/export, leases, code waiting, background workers."""
from __future__ import annotations

import csv
import io
import json
import logging
import re
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from . import parsing
from .auth import Auth
from .codes import DEFAULT_MARKERS, DEFAULT_PATTERNS, compile_patterns, find_codes, marker_match
from .config import Config
from .db import DB
from .jobs import Jobs
from .parsing import STATUSES, ParsedItem, clean_tags, format_line
from .providers import Account, AuthError, LiveProvider, TemporaryError, provider_label
from .util import iso, mask_email, now, to_int, truthy
from .webhooks import Webhooks

log = logging.getLogger("hub")

SETTING_DEFAULTS = {
    "lease_ttl": 900,
    "poll_interval": 4,
    "default_wait": 120,
    "code_markers": DEFAULT_MARKERS,
    "code_patterns": DEFAULT_PATTERNS,
    "auto_invalidate": True,
    "watch_leased": True,
    "watch_interval": 15,
    "messages_keep": 40,
}
SETTING_BOUNDS = {"lease_ttl": (30, 86400), "poll_interval": (1, 60), "default_wait": (0, 900),
                  "watch_interval": (5, 600), "messages_keep": (5, 500)}
SORTS = {
    "email": "email COLLATE NOCASE", "status": "status", "updated_at": "updated_at", "created_at": "created_at",
    "last_code_at": "COALESCE(last_code_at,0)", "checked_at": "COALESCE(checked_at,0)", "uses": "uses", "id": "id",
}
EXPORT_FORMATS = {"txt": "text/plain", "csv": "text/csv", "json": "application/json"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


class Hub:
    def __init__(self, config: Config, provider=None) -> None:
        self.config = config
        self.db = DB(config.db_path)
        self.auth = Auth(self.db, config.data_dir, config.session_ttl)
        self.webhooks = Webhooks(self.db)
        self.jobs = Jobs()
        self.provider = provider or LiveProvider(config.token_url, config.provider_timeout, config.max_connections,
                                                 on_rotate=self._on_rotate)
        self._stop = threading.Event()
        self._waiting: dict[str, int] = {}
        self._wait_lock = threading.Lock()
        self._settings_cache: tuple[float, dict] | None = None
        self._event_counter = 0

    # ------------------------------------------------------------------ settings
    def settings(self) -> dict:
        cached = self._settings_cache
        if cached and time.monotonic() - cached[0] < 3:
            return cached[1]
        merged = dict(SETTING_DEFAULTS)
        for row in self.db.query("SELECT key,value FROM settings"):
            if row["key"] in merged:
                try:
                    merged[row["key"]] = json.loads(row["value"])
                except ValueError:
                    pass
        self._settings_cache = (time.monotonic(), merged)
        return merged

    def update_settings(self, patch: dict, actor: str = "") -> dict:
        clean: dict = {}
        for key, value in patch.items():
            if key not in SETTING_DEFAULTS:
                raise ApiError(400, "unknown_setting", f"невідомий параметр: {key}")
            default = SETTING_DEFAULTS[key]
            if isinstance(default, bool):
                value = truthy(value)
            elif isinstance(default, int):
                low, high = SETTING_BOUNDS[key]
                value = to_int(value, default, low, high)
            elif key == "code_patterns":
                if isinstance(value, str):
                    value = [line.strip() for line in value.splitlines() if line.strip()]
                if not isinstance(value, list) or not value or len(value) > 10:
                    raise ApiError(400, "bad_patterns", "потрібен список із 1–10 регулярних виразів")
                try:
                    compile_patterns([str(p) for p in value])
                except Exception as exc:
                    raise ApiError(400, "bad_patterns", f"некоректний регулярний вираз: {exc}") from exc
                value = [str(p) for p in value]
            else:
                value = str(value)[:500]
            clean[key] = value
        with self.db.tx() as conn:
            for key, value in clean.items():
                conn.execute("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                             (key, json.dumps(value, ensure_ascii=False)))
        self._settings_cache = None
        self.event("settings.updated", ",".join(clean), actor=actor)
        return self.settings()

    # ------------------------------------------------------------------ events
    def event(self, kind: str, subject: str = "", detail: str = "", actor: str = "") -> None:
        self.db.execute("INSERT INTO events(at,kind,subject,detail,actor) VALUES(?,?,?,?,?)",
                        (now(), kind, subject[:200], detail[:400], actor[:60]))
        self._event_counter += 1
        if self._event_counter % 200 == 0:
            self.db.execute("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 5000)")

    def events(self, limit: int = 100, before: int | None = None, kind: str = "") -> list[dict]:
        sql, params = "SELECT * FROM events WHERE 1=1", []
        if before:
            sql += " AND id<?"
            params.append(before)
        if kind:
            sql += " AND kind LIKE ?"
            params.append(kind.replace("*", "%"))
        rows = self.db.query(sql + " ORDER BY id DESC LIMIT ?", (*params, to_int(limit, 100, 1, 500)))
        return [{"id": r["id"], "at": iso(r["at"]), "kind": r["kind"], "subject": r["subject"],
                 "detail": r["detail"], "actor": r["actor"]} for r in rows]

    # ------------------------------------------------------------------ mailbox rows
    def _row(self, email: str):
        row = self.db.one("SELECT * FROM mailboxes WHERE email=?", (email.strip().lower(),))
        if row is None:
            raise ApiError(404, "not_found", f"скриньку {email} не знайдено")
        return row

    @staticmethod
    def _acct(row) -> Account:
        return Account(row["id"], row["email"], row["password"], row["refresh_token"], row["client_id"],
                       row["imap_host"], row["imap_port"], row["login"])

    def _on_rotate(self, account_id: int, old: str, new: str) -> None:
        self.db.execute("UPDATE mailboxes SET refresh_token=?, updated_at=? WHERE id=? AND refresh_token=?",
                        (new, now(), account_id, old))

    def mailbox_dict(self, row, secrets: bool = False) -> dict:
        oauth = bool(row["refresh_token"] and row["client_id"])
        leased = row["status"] == "leased"
        data = {
            "id": row["id"], "email": row["email"], "type": "oauth2" if oauth else "imap",
            "provider": provider_label(row["email"], oauth, row["imap_host"]),
            "status": row["status"], "imap_host": row["imap_host"], "imap_port": row["imap_port"],
            "login": row["login"], "note": row["note"], "tags": [t for t in row["tags"].split(",") if t],
            "has_password": bool(row["password"]),
            "health": {"ok": None if row["check_ok"] is None else bool(row["check_ok"]),
                       "checked_at": iso(row["checked_at"]), "error": row["check_error"],
                       "messages": row["inbox_count"]},
            "last_code": {"code": row["last_code"], "at": iso(row["last_code_at"]), "subject": row["last_code_subject"]}
            if row["last_code"] else None,
            "lease": {"owner": row["lease_owner"], "since": iso(row["leased_at"]), "until": iso(row["lease_until"])}
            if leased else None,
            "uses": row["uses"], "created_at": iso(row["created_at"]), "updated_at": iso(row["updated_at"]),
        }
        if secrets:
            data.update(password=row["password"], refresh_token=row["refresh_token"], client_id=row["client_id"],
                        line=format_line(row["email"], row["password"], row["refresh_token"], row["client_id"],
                                         row["imap_host"], row["imap_port"], row["login"]))
        return data

    # ------------------------------------------------------------------ queries
    def _filters(self, q="", status="", type_="", tag="", health="", emails=None) -> tuple[str, list]:
        where, params = ["1=1"], []
        statuses = [s for s in (status or "").split(",") if s in STATUSES]
        if statuses:
            where.append(f"status IN ({','.join('?' * len(statuses))})")
            params += statuses
        if q:
            like = "%" + q.strip().lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            where.append("(LOWER(email) LIKE ? ESCAPE '\\' OR LOWER(note) LIKE ? ESCAPE '\\' OR LOWER(tags) LIKE ? ESCAPE '\\')")
            params += [like, like, like]
        if type_ == "oauth2":
            where.append("refresh_token<>'' AND client_id<>''")
        elif type_ == "imap":
            where.append("(refresh_token='' OR client_id='')")
        if tag:
            where.append("(',' || tags || ',') LIKE ?")
            params.append(f"%,{tag.strip().lower()},%")
        if health == "ok":
            where.append("check_ok=1")
        elif health == "error":
            where.append("check_ok=0")
        elif health == "unknown":
            where.append("check_ok IS NULL")
        if emails is not None:
            emails = [e.strip().lower() for e in emails]
            where.append(f"email IN ({','.join('?' * len(emails)) or 'NULL'})")
            params += emails
        return " AND ".join(where), params

    def list_mailboxes(self, sort="updated_at", order="desc", limit=50, offset=0, secrets=False, **filters) -> dict:
        self.reap()
        where, params = self._filters(**filters)
        column = SORTS.get(sort, SORTS["updated_at"])
        direction = "ASC" if str(order).lower() == "asc" else "DESC"
        total = self.db.one(f"SELECT COUNT(*) n FROM mailboxes WHERE {where}", params)["n"]
        limit, offset = to_int(limit, 50, 1, 1000), to_int(offset, 0, 0)
        rows = self.db.query(f"SELECT * FROM mailboxes WHERE {where} ORDER BY {column} {direction}, id ASC LIMIT ? OFFSET ?",
                             (*params, limit, offset))
        return {"items": [self.mailbox_dict(r, secrets) for r in rows], "total": total, "limit": limit, "offset": offset}

    def emails_matching(self, **filters) -> list[str]:
        where, params = self._filters(**filters)
        return [r["email"] for r in self.db.query(f"SELECT email FROM mailboxes WHERE {where} ORDER BY id", params)]

    def get_mailbox(self, email: str, secrets: bool = False) -> dict:
        self.reap()
        return self.mailbox_dict(self._row(email), secrets)

    def stats(self) -> dict:
        self.reap()
        counts = {s: 0 for s in STATUSES}
        for row in self.db.query("SELECT status, COUNT(*) n FROM mailboxes GROUP BY status"):
            counts[row["status"]] = row["n"]
        one = self.db.one(
            "SELECT COUNT(*) total, SUM(refresh_token<>'' AND client_id<>'') oauth, SUM(check_ok=1) ok, "
            "SUM(check_ok=0) bad, SUM(check_ok IS NULL) unknown FROM mailboxes")
        day = self.db.one("SELECT COUNT(*) n FROM events WHERE kind='code.delivered' AND at>?", (now() - 86400,))["n"]
        return {"total": one["total"] or 0, "by_status": counts,
                "types": {"oauth2": one["oauth"] or 0, "imap": (one["total"] or 0) - (one["oauth"] or 0)},
                "health": {"ok": one["ok"] or 0, "error": one["bad"] or 0, "unknown": one["unknown"] or 0},
                "codes_24h": day, "available": counts["available"]}

    # ------------------------------------------------------------------ create / import
    @staticmethod
    def _values(rec, status: str, ts: int, tags: list[str], note: str) -> tuple:
        return (rec.email, rec.password, rec.refresh_token, rec.client_id, rec.imap_host, rec.imap_port, rec.login,
                status, note, ",".join(tags), ts, ts)

    def import_items(self, items: list[ParsedItem], mode: str = "skip", status: str = "", tags=None, note: str = "",
                     dry_run: bool = False, actor: str = "") -> dict:
        if mode not in ("skip", "update"):
            raise ApiError(400, "bad_mode", "mode має бути skip або update")
        if status and status not in STATUSES:
            raise ApiError(400, "bad_status", f"невідомий статус: {status}")
        extra_tags = clean_tags(tags or [])
        counts = {"added": 0, "updated": 0, "skipped": 0, "duplicate_in_file": 0, "invalid": 0}
        results: list[dict] = []
        seen: set[str] = set()
        touched: list[str] = []
        ts = now()

        def add_result(item: ParsedItem, action: str, email: str = "", error: str = "") -> None:
            counts[action] += 1
            if len(results) < 3000:
                results.append({"line": item.line, "email": email or item.preview, "action": action, "error": error})

        conn = self.db.conn
        conn.execute("BEGIN IMMEDIATE")
        try:
            existing = {r["email"].lower(): r for r in conn.execute("SELECT * FROM mailboxes").fetchall()}
            for item in items:
                rec = item.record
                if rec is None:
                    add_result(item, "invalid", error=item.error)
                    continue
                if rec.email in seen:
                    add_result(item, "duplicate_in_file", rec.email)
                    continue
                seen.add(rec.email)
                tag_list = clean_tags(list(rec.tags) + extra_tags)
                wanted_status = rec.status or status or "available"
                current = existing.get(rec.email)
                if current is None:
                    if not dry_run:
                        conn.execute(
                            "INSERT INTO mailboxes(email,password,refresh_token,client_id,imap_host,imap_port,login,"
                            "status,note,tags,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                            self._values(rec, wanted_status, ts, tag_list, rec.note or note))
                    touched.append(rec.email)
                    add_result(item, "added", rec.email)
                elif mode == "skip":
                    add_result(item, "skipped", rec.email)
                else:
                    if not dry_run:
                        merged_tags = clean_tags(current["tags"].split(",") + tag_list)
                        conn.execute(
                            "UPDATE mailboxes SET password=?, refresh_token=?, client_id=?, imap_host=?, imap_port=?, login=?, "
                            "status=?, note=?, tags=?, check_ok=NULL, check_error='', updated_at=? WHERE id=?",
                            (rec.password or current["password"], rec.refresh_token or current["refresh_token"],
                             rec.client_id or current["client_id"], rec.imap_host or current["imap_host"],
                             rec.imap_port or current["imap_port"], rec.login or current["login"],
                             rec.status or status or current["status"], rec.note or note or current["note"],
                             ",".join(merged_tags), ts, current["id"]))
                    touched.append(rec.email)
                    add_result(item, "updated", rec.email)
            conn.execute("ROLLBACK" if dry_run else "COMMIT")
        except BaseException:
            try:
                conn.execute("ROLLBACK")
            except sqlite3.Error:
                pass
            raise
        if not dry_run and (counts["added"] or counts["updated"]):
            self.event("import", f"+{counts['added']} ~{counts['updated']}", f"skipped={counts['skipped']} invalid={counts['invalid']}", actor)
            self.webhooks.emit("import.done", dict(counts))
        return {"dry_run": dry_run, "counts": counts, "results": results, "emails": touched}

    def import_text(self, text: str, filename: str = "", **options) -> dict:
        return self.import_items(parsing.parse_text(text, filename), **options)

    def create_mailbox(self, data: dict, actor: str = "") -> dict:
        try:
            rec = parsing.parse_line(str(data["line"])) if data.get("line") else parsing.record_from_mapping(data)
        except parsing.ParseError as exc:
            raise ApiError(400, "invalid_mailbox", str(exc)) from exc
        if self.db.one("SELECT 1 FROM mailboxes WHERE email=?", (rec.email,)):
            raise ApiError(409, "exists", f"{rec.email} уже є в базі")
        status = str(data.get("status") or rec.status or "available").lower()
        if status not in STATUSES:
            raise ApiError(400, "bad_status", f"невідомий статус: {status}")
        self.db.execute(
            "INSERT INTO mailboxes(email,password,refresh_token,client_id,imap_host,imap_port,login,status,note,tags,"
            "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            self._values(rec, status, now(), clean_tags(rec.tags), rec.note))
        self.event("mailbox.added", rec.email, actor=actor)
        return self.get_mailbox(rec.email)

    # ------------------------------------------------------------------ update / delete
    def update_mailbox(self, email: str, patch: dict, actor: str = "") -> dict:
        row = self._row(email)
        fields: dict = {}
        if "email" in patch or "new_email" in patch:
            new = str(patch.get("new_email") or patch.get("email")).strip().lower()
            if new != row["email"]:
                if not parsing.EMAIL_RE.match(new):
                    raise ApiError(400, "invalid_mailbox", "некоректний email")
                if self.db.one("SELECT 1 FROM mailboxes WHERE email=? AND id<>?", (new, row["id"])):
                    raise ApiError(409, "exists", f"{new} уже є в базі")
                fields["email"] = new
        for key in ("password", "refresh_token", "client_id", "imap_host", "login", "note"):
            if key in patch and patch[key] is not None:
                fields[key] = str(patch[key]).strip() if key != "password" else str(patch[key])
        if "imap_port" in patch:
            fields["imap_port"] = to_int(patch["imap_port"], 0, 0, 65535)
        if "tags" in patch:
            fields["tags"] = ",".join(clean_tags(patch["tags"]))
        if fields.get("login") and "@" not in fields["login"]:
            raise ApiError(400, "invalid_mailbox", "login для IMAP має містити @")
        new_rt = fields.get("refresh_token", row["refresh_token"])
        new_cid = fields.get("client_id", row["client_id"])
        if bool(new_rt) != bool(new_cid):
            raise ApiError(400, "invalid_mailbox", "для OAuth потрібні і refresh_token, і client_id")
        credentials = {"password", "refresh_token", "client_id", "imap_host", "imap_port", "login"} & set(fields)
        if credentials:
            fields.update(check_ok=None, check_error="")
        if fields:
            fields["updated_at"] = now()
            self.db.execute(f"UPDATE mailboxes SET {','.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), row["id"]))
        target = fields.get("email", row["email"])
        if patch.get("status") and patch["status"] != row["status"]:
            return self.set_status(target, str(patch["status"]).lower(), actor=actor)
        if fields:
            self.event("mailbox.updated", target, ",".join(k for k in fields if k not in ("updated_at", "check_ok", "check_error")), actor)
        return self.get_mailbox(target)

    def delete_mailboxes(self, emails: list[str], actor: str = "") -> int:
        emails = [e.strip().lower() for e in emails if e and e.strip()]
        deleted = 0
        with self.db.tx() as conn:
            for email in emails:
                deleted += conn.execute("DELETE FROM mailboxes WHERE email=?", (email,)).rowcount
        if deleted:
            self.event("mailbox.deleted", f"{deleted} шт.", emails[0] if deleted == 1 else "", actor)
        return deleted

    # ------------------------------------------------------------------ pool: status, leases
    def reap(self) -> None:
        stamp = now()
        expired = self.db.query("SELECT email FROM mailboxes WHERE status='leased' AND lease_until IS NOT NULL AND lease_until<?", (stamp,))
        if expired:
            self.db.execute("UPDATE mailboxes SET status='available', lease_until=NULL, leased_at=NULL, lease_owner='', "
                            "updated_at=? WHERE status='leased' AND lease_until<?", (stamp, stamp))
            for row in expired:
                self.event("lease.expired", row["email"])

    def set_status(self, email: str, status: str, note: str | None = None, actor: str = "", ttl: int | None = None) -> dict:
        status = (status or "").strip().lower()
        if status not in STATUSES:
            raise ApiError(400, "bad_status", f"статус має бути одним із: {', '.join(STATUSES)}")
        row = self._row(email)
        stamp = now()
        sets = {"status": status, "updated_at": stamp}
        if status == "leased":
            sets.update(lease_until=stamp + (ttl or self.settings()["lease_ttl"]), leased_at=stamp, lease_owner=actor[:60])
        else:
            sets.update(lease_until=None, leased_at=None, lease_owner="")
        if note is not None:
            sets["note"] = str(note)[:500]
        self.db.execute(f"UPDATE mailboxes SET {','.join(f'{k}=?' for k in sets)} WHERE id=?", (*sets.values(), row["id"]))
        if status != row["status"]:
            self.event("mailbox.status", row["email"], f"{row['status']} → {status}", actor)
            self.webhooks.emit("mailbox.status", {"email": row["email"], "from": row["status"], "to": status})
        return self.get_mailbox(row["email"])

    def extend_lease(self, email: str, ttl: int | None = None) -> dict:
        row = self._row(email)
        if row["status"] != "leased":
            raise ApiError(409, "not_leased", "скринька не в оренді")
        self.db.execute("UPDATE mailboxes SET lease_until=?, updated_at=? WHERE id=?",
                        (now() + (ttl or self.settings()["lease_ttl"]), now(), row["id"]))
        return self.get_mailbox(row["email"])

    def acquire(self, count: int = 1, ttl: int | None = None, owner: str = "", tag: str = "", secrets: bool = False) -> dict:
        count = to_int(count, 1, 1, 100)
        ttl = to_int(ttl, self.settings()["lease_ttl"], 30, 86400)
        self.reap()
        picked: list[str] = []
        stamp = now()
        with self.db.tx() as conn:
            sql = "SELECT id FROM mailboxes WHERE status='available' AND (check_ok IS NULL OR check_ok=1)"
            params: list = []
            if tag:
                sql += " AND (',' || tags || ',') LIKE ?"
                params.append(f"%,{tag.strip().lower()},%")
            rows = conn.execute(sql + " ORDER BY COALESCE(leased_at,0), uses, id LIMIT ?", (*params, count)).fetchall()
            for row in rows:
                conn.execute("UPDATE mailboxes SET status='leased', lease_until=?, leased_at=?, lease_owner=?, uses=uses+1, "
                             "updated_at=? WHERE id=?", (stamp + ttl, stamp, owner[:60], stamp, row["id"]))
                picked.append(row["id"])
        items = [self.mailbox_dict(self.db.one("SELECT * FROM mailboxes WHERE id=?", (i,)), secrets) for i in picked]
        if items:
            self.event("pool.acquire", f"{len(items)} шт.", ",".join(m["email"] for m in items[:3]), owner)
        remaining = self.db.one("SELECT COUNT(*) n FROM mailboxes WHERE status='available'")["n"]
        return {"items": items, "available": remaining, "ttl": ttl}

    def bulk_tags(self, emails: list[str], add=None, remove=None) -> int:
        add, remove = clean_tags(add or []), set(clean_tags(remove or []))
        changed = 0
        with self.db.tx() as conn:
            for email in emails:
                row = conn.execute("SELECT id, tags FROM mailboxes WHERE email=?", (email.strip().lower(),)).fetchone()
                if row is None:
                    continue
                tags = [t for t in row["tags"].split(",") if t and t not in remove]
                merged = ",".join(clean_tags(tags + add))
                if merged != row["tags"]:
                    conn.execute("UPDATE mailboxes SET tags=?, updated_at=? WHERE id=?", (merged, now(), row["id"]))
                    changed += 1
        return changed

    # ------------------------------------------------------------------ export
    def export(self, fmt: str = "txt", secrets: bool = True, emails=None, **filters) -> tuple[str, str, str]:
        if fmt not in EXPORT_FORMATS:
            raise ApiError(400, "bad_format", "format має бути txt, csv або json")
        where, params = self._filters(emails=emails, **filters)
        rows = self.db.query(f"SELECT * FROM mailboxes WHERE {where} ORDER BY id", params)
        stamp = datetime.now().strftime("%Y%m%d-%H%M")
        if fmt == "json":
            body = json.dumps([self.mailbox_dict(r, secrets) for r in rows], ensure_ascii=False, indent=2)
        elif fmt == "csv":
            columns = ["email", "password", "refresh_token", "client_id", "imap_host", "imap_port", "login",
                       "status", "note", "tags"] if secrets else ["email", "status", "note", "tags"]
            out = io.StringIO()
            writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            for r in rows:
                writer.writerow({**{c: r[c] for c in columns if c in r.keys()}})
            body = out.getvalue()
        else:
            body = "\n".join(
                format_line(r["email"], r["password"], r["refresh_token"], r["client_id"], r["imap_host"],
                            r["imap_port"], r["login"]) if secrets else r["email"] for r in rows)
            body += "\n" if body else ""
        return body, EXPORT_FORMATS[fmt], f"mailboxes-{stamp}.{fmt}"

    # ------------------------------------------------------------------ mail operations
    def _mark_auth_failure(self, row, error: str) -> str:
        self.db.execute("UPDATE mailboxes SET check_ok=0, check_error=?, checked_at=? WHERE id=?",
                        (error[:300], now(), row["id"]))
        status = row["status"]
        if self.settings()["auto_invalidate"] and status in ("available", "leased"):
            self.db.execute("UPDATE mailboxes SET status='invalid', lease_until=NULL, leased_at=NULL, lease_owner='', "
                            "updated_at=? WHERE id=?", (now(), row["id"]))
            status = "invalid"
            self.event("mailbox.invalid", row["email"], error)
            self.webhooks.emit("mailbox.invalid", {"email": row["email"], "error": error})
        return status

    def check_mailbox(self, email: str, actor: str = "") -> dict:
        row = self._row(email)
        started = time.monotonic()
        ok, error, kind, count = True, "", "", None
        try:
            count = self.provider.check(self._acct(row)).messages
        except AuthError as exc:
            ok, error, kind = False, str(exc), "auth"
        except TemporaryError as exc:
            ok, error, kind = False, str(exc), "temp"
        except Exception as exc:  # provider bugs must not take the API down
            ok, error, kind = False, f"{type(exc).__name__}: {exc}"[:200], "temp"
        status = row["status"]
        if kind == "auth":
            status = self._mark_auth_failure(row, error)
        else:
            self.db.execute("UPDATE mailboxes SET checked_at=?, check_ok=?, check_error=?, "
                            "inbox_count=COALESCE(?, inbox_count) WHERE id=?",
                            (now(), 1 if ok else 0, error[:300], count, row["id"]))
            if ok and status == "invalid":
                self.db.execute("UPDATE mailboxes SET status='available', updated_at=? WHERE id=?", (now(), row["id"]))
                status = "available"
                self.event("mailbox.status", row["email"], "invalid → available (перевірка пройшла)", actor)
        return {"email": row["email"], "ok": ok, "error": error, "kind": kind, "messages": count,
                "ms": int((time.monotonic() - started) * 1000), "status": status}

    def start_check_job(self, emails=None, actor: str = "", **filters) -> dict:
        targets = list(emails) if emails else self.emails_matching(**filters)
        if not targets:
            raise ApiError(400, "empty", "немає скриньок для перевірки")
        self.event("check.started", f"{len(targets)} шт.", actor=actor)
        return self.jobs.start("check", targets, lambda email: self.check_mailbox(email, actor), concurrency=6)

    @staticmethod
    def _message_dict(r, full: bool) -> dict:
        data = {"id": r["id"], "folder": r["folder"], "from": r["sender"], "to": r["recipient"],
                "subject": r["subject"], "received_at": iso(r["received_at"]), "codes": json.loads(r["codes"]),
                "delivered": bool(r["delivered_at"]), "snippet": " ".join(r["body"].split())[:240]}
        if full:
            data["body"] = r["body"]
        return data

    def _store_messages(self, row, fetched) -> None:
        cfg = self.settings()
        patterns = compile_patterns(cfg["code_patterns"])
        fresh: list[dict] = []
        stamp = now()
        with self.db.tx() as conn:
            for m in fetched:
                eligible = marker_match(cfg["code_markers"], m.subject, m.sender)
                codes = find_codes(m.subject + "\n" + m.body, patterns) if eligible else []
                cursor = conn.execute(
                    "INSERT OR IGNORE INTO messages(mailbox_id,uid_key,folder,sender,recipient,subject,received_at,body,"
                    "codes,seen_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (row["id"], m.uid_key, m.folder, m.sender, m.recipient, m.subject, m.received_at, m.body,
                     json.dumps(codes), stamp))
                if cursor.rowcount and codes and m.received_at >= stamp - 900:
                    fresh.append({"email": row["email"], "code": codes[0], "subject": m.subject[:120],
                                  "from": m.sender, "received_at": iso(m.received_at), "message_id": cursor.lastrowid})
            best = conn.execute("SELECT subject, received_at, codes FROM messages WHERE mailbox_id=? AND codes<>'[]' "
                                "ORDER BY received_at DESC LIMIT 1", (row["id"],)).fetchone()
            if best:
                conn.execute("UPDATE mailboxes SET last_code=?, last_code_at=?, last_code_subject=? WHERE id=?",
                             (json.loads(best["codes"])[0], best["received_at"], best["subject"][:120], row["id"]))
            conn.execute("UPDATE mailboxes SET fetched_at=? WHERE id=?", (stamp, row["id"]))
            keep = cfg["messages_keep"]
            conn.execute("DELETE FROM messages WHERE mailbox_id=? AND id NOT IN "
                         "(SELECT id FROM messages WHERE mailbox_id=? ORDER BY received_at DESC LIMIT ?)",
                         (row["id"], row["id"], keep))
        for payload in fresh:
            self.webhooks.emit("code.received", payload)

    def _pull(self, row) -> None:
        try:
            session = self.provider.open(self._acct(row))
        except AuthError as exc:
            self._mark_auth_failure(row, str(exc))
            raise ApiError(409, "auth_failed", str(exc)) from exc
        except TemporaryError as exc:
            raise ApiError(503, "mailbox_unavailable", str(exc)) from exc
        try:
            self._store_messages(row, session.recent(15))
        except TemporaryError as exc:
            raise ApiError(503, "mailbox_unavailable", str(exc)) from exc
        finally:
            self._close_session(session)

    @staticmethod
    def _close_session(session) -> None:
        if session is not None:
            try:
                session.close()
            except Exception:
                pass

    def messages(self, email: str, refresh: bool = False, limit: int = 30) -> dict:
        row = self._row(email)
        if refresh and not (row["fetched_at"] and now() - row["fetched_at"] < 3):
            self._pull(row)
            row = self._row(email)
        rows = self.db.query("SELECT * FROM messages WHERE mailbox_id=? ORDER BY received_at DESC LIMIT ?",
                             (row["id"], to_int(limit, 30, 1, 200)))
        return {"email": row["email"], "fetched_at": iso(row["fetched_at"]),
                "items": [self._message_dict(r, False) for r in rows]}

    def get_message(self, email: str, message_id: int) -> dict:
        row = self._row(email)
        found = self.db.one("SELECT * FROM messages WHERE id=? AND mailbox_id=?", (message_id, row["id"]))
        if found is None:
            raise ApiError(404, "not_found", "лист не знайдено")
        return self._message_dict(found, True)

    def _wait_enter(self, email: str) -> None:
        with self._wait_lock:
            self._waiting[email] = self._waiting.get(email, 0) + 1

    def _wait_leave(self, email: str) -> None:
        with self._wait_lock:
            self._waiting[email] = self._waiting.get(email, 1) - 1
            if self._waiting[email] <= 0:
                self._waiting.pop(email, None)

    def wait_for_code(self, email: str, wait: int = 0, since: int | None = None, sender: str = "", subject: str = "",
                      fresh: bool = False, any_message: bool = False, regex: str = "", actor: str = "") -> dict | None:
        row = self._row(email)
        acct, cfg = self._acct(row), self.settings()
        base = since if since is not None else (row["leased_at"] if row["status"] == "leased" and row["leased_at"] else now() - 300)
        threshold = base - 120
        patterns = None
        if regex:
            try:
                patterns = [re.compile(regex)]
            except re.error as exc:
                raise ApiError(400, "bad_regex", f"некоректний regex: {exc}") from exc
        deadline = time.monotonic() + to_int(wait, 0, 0, 900)
        session, last_error = None, ""
        self._wait_enter(row["email"])
        try:
            while True:
                fetched = None
                try:
                    if session is None:
                        session = self.provider.open(acct)
                    fetched, last_error = session.recent(12), ""
                except AuthError as exc:
                    self._mark_auth_failure(self._row(row["email"]), str(exc))
                    raise ApiError(409, "auth_failed", str(exc)) from exc
                except TemporaryError as exc:
                    last_error = str(exc)
                    self._close_session(session)
                    session = None
                if fetched is not None:
                    self._store_messages(row, fetched)
                    hit = self._pick_code(row, threshold, sender, subject, fresh, any_message, patterns, cfg, actor)
                    if hit:
                        return hit
                if time.monotonic() >= deadline:
                    if last_error:
                        raise ApiError(503, "mailbox_unavailable", last_error)
                    return None
                time.sleep(max(0.2, min(cfg["poll_interval"], deadline - time.monotonic())))
        finally:
            self._close_session(session)
            self._wait_leave(row["email"])

    def _pick_code(self, row, threshold, sender, subject, fresh, any_message, patterns, cfg, actor) -> dict | None:
        rows = self.db.query("SELECT * FROM messages WHERE mailbox_id=? AND received_at>=? ORDER BY received_at DESC LIMIT 40",
                             (row["id"], threshold))
        compiled = patterns or compile_patterns(cfg["code_patterns"])
        for m in rows:
            codes = json.loads(m["codes"])
            if patterns or any_message:
                eligible = any_message or marker_match(cfg["code_markers"], m["subject"], m["sender"])
                codes = find_codes(m["subject"] + "\n" + m["body"], compiled) if eligible else []
            if not codes or (sender and sender.lower() not in m["sender"].lower()):
                continue
            if (subject and subject.lower() not in m["subject"].lower()) or (fresh and m["delivered_at"]):
                continue
            self.db.execute("UPDATE messages SET delivered_at=? WHERE id=?", (now(), m["id"]))
            self.db.execute("UPDATE mailboxes SET last_code=?, last_code_at=?, last_code_subject=? WHERE id=?",
                            (codes[0], m["received_at"], m["subject"][:120], row["id"]))
            self.event("code.delivered", row["email"], f"лист #{m['id']}", actor)
            return {"code": codes[0], "codes": codes, "email": row["email"], "message_id": m["id"],
                    "from": m["sender"], "subject": m["subject"], "folder": m["folder"],
                    "received_at": iso(m["received_at"])}
        return None

    # ------------------------------------------------------------------ background work
    def backup(self) -> Path | None:
        keep = self.config.backup_keep
        if keep <= 0:
            return None
        body, _, _ = self.export("txt", True)
        if not body:
            return None
        directory = self.config.data_dir / "backups"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"mailboxes-{datetime.now():%Y%m%d}.txt"
        path.write_text(body, encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        for old in sorted(directory.glob("mailboxes-*.txt"))[:-keep]:
            old.unlink(missing_ok=True)
        return path

    def _watch_leased(self) -> None:
        for row in self.db.query("SELECT * FROM mailboxes WHERE status='leased' ORDER BY fetched_at LIMIT 20"):
            if self._stop.is_set():
                return
            with self._wait_lock:
                busy = row["email"] in self._waiting
            if busy:
                continue
            try:
                self._pull(row)
            except ApiError as exc:
                log.info("watch %s: %s", mask_email(row["email"]), exc.message)

    def _loop(self) -> None:
        last_watch = last_backup = 0.0
        while not self._stop.wait(5):
            try:
                self.reap()
                cfg = self.settings()
                tick = time.monotonic()
                if cfg["watch_leased"] and tick - last_watch >= cfg["watch_interval"]:
                    last_watch = tick
                    self._watch_leased()
                if time.time() - last_backup > 86400:
                    last_backup = time.time()
                    self.backup()
            except Exception:
                log.exception("background loop error")

    def start_background(self) -> None:
        self.webhooks.start()
        threading.Thread(target=self._loop, name="hub-background", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
