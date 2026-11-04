"""Outgoing webhooks: signed JSON POSTs delivered by one background worker."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.request

from .util import iso, now

log = logging.getLogger("hub.webhooks")
EVENTS = ("code.received", "mailbox.status", "mailbox.invalid", "import.done", "ping")


def deliver(url: str, secret: str, event: str, body: bytes, timeout: float = 8) -> str:
    headers = {"Content-Type": "application/json", "User-Agent": "HotmailHub/2", "X-Hub-Event": event}
    if secret:
        headers["X-Hub-Signature"] = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return str(response.status)
    except urllib.error.HTTPError as exc:
        return str(exc.code)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return f"error: {type(exc).__name__}"


class Webhooks:
    def __init__(self, db, timeout: float = 8, retry_delays=(0, 2, 8)) -> None:
        self.db, self.timeout, self.retry_delays = db, timeout, retry_delays
        self._queue: queue.Queue = queue.Queue(maxsize=2000)
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._worker, name="webhooks", daemon=True)
            self._thread.start()

    def emit(self, event: str, data: dict) -> None:
        rows = self.db.query("SELECT * FROM webhooks WHERE active=1")
        if not rows:
            return
        body = json.dumps({"event": event, "at": iso(now()), "data": data}, ensure_ascii=False).encode()
        for row in rows:
            wanted = [e.strip() for e in row["events"].split(",")]
            if "*" in wanted or event in wanted:
                try:
                    self._queue.put_nowait((row["id"], row["url"], row["secret"], event, body))
                except queue.Full:
                    log.warning("webhook queue full, dropping %s", event)
        self.start()

    def _worker(self) -> None:
        while True:
            hook_id, url, secret, event, body = self._queue.get()
            status = ""
            for delay in self.retry_delays:
                if delay:
                    time.sleep(delay)
                status = deliver(url, secret, event, body, self.timeout)
                if status.startswith("2"):
                    break
            self.db.execute("UPDATE webhooks SET last_at=?, last_status=? WHERE id=?", (now(), status, hook_id))

    # --- management ------------------------------------------------------
    @staticmethod
    def as_dict(row) -> dict:
        return {"id": row["id"], "url": row["url"], "events": row["events"].split(","), "active": bool(row["active"]),
                "has_secret": bool(row["secret"]), "created_at": iso(row["created_at"]),
                "last_at": iso(row["last_at"]), "last_status": row["last_status"]}

    def list(self) -> list[dict]:
        return [self.as_dict(r) for r in self.db.query("SELECT * FROM webhooks ORDER BY id")]

    def get(self, hook_id: int):
        return self.db.one("SELECT * FROM webhooks WHERE id=?", (hook_id,))

    @staticmethod
    def clean_events(events) -> str:
        if isinstance(events, str):
            events = [e for e in events.replace(" ", ",").split(",") if e]
        events = [e for e in (events or ["*"]) if e == "*" or e in EVENTS]
        return ",".join(events or ["*"])

    def create(self, url: str, secret: str = "", events=None) -> dict:
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError("URL має починатися з http:// або https://")
        cursor = self.db.execute("INSERT INTO webhooks(url,secret,events,created_at) VALUES(?,?,?,?)",
                                 (url[:500], secret[:200], self.clean_events(events), now()))
        return self.as_dict(self.get(cursor.lastrowid))

    def update(self, hook_id: int, patch: dict) -> dict | None:
        row = self.get(hook_id)
        if row is None:
            return None
        url = str(patch.get("url", row["url"]))
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError("URL має починатися з http:// або https://")
        self.db.execute("UPDATE webhooks SET url=?, events=?, active=?, secret=? WHERE id=?",
                        (url[:500], self.clean_events(patch.get("events", row["events"])),
                         1 if patch.get("active", bool(row["active"])) else 0,
                         str(patch["secret"])[:200] if "secret" in patch else row["secret"], hook_id))
        return self.as_dict(self.get(hook_id))

    def delete(self, hook_id: int) -> bool:
        return self.db.execute("DELETE FROM webhooks WHERE id=?", (hook_id,)).rowcount > 0

    def test(self, hook_id: int) -> str | None:
        row = self.get(hook_id)
        if row is None:
            return None
        body = json.dumps({"event": "ping", "at": iso(now()), "data": {"hook": hook_id}}).encode()
        status = deliver(row["url"], row["secret"], "ping", body, self.timeout)
        self.db.execute("UPDATE webhooks SET last_at=?, last_status=? WHERE id=?", (now(), status, hook_id))
        return status
