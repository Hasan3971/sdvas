"""Test harness: a fake mail provider and an in-process HTTP server."""
from __future__ import annotations

import http.client
import json
import tempfile
import threading
import time
from pathlib import Path

from hotmailhub import api  # noqa: F401  (registers routes)
from hotmailhub.config import Config
from hotmailhub.hub import Hub
from hotmailhub.providers import AuthError, CheckResult, FetchedMessage, TemporaryError
from hotmailhub.web import HubServer

OAUTH_LINE = "{email}:pw:M.C5{n}token:123e4567-e89b-12d3-a456-42661417400{n}"


def oauth_line(email: str, n: int = 0) -> str:
    return OAUTH_LINE.format(email=email, n=n)


def tiktok_message(code: str = "123456", uid: int = 1, age: int = 0, subject: str = "Verification code") -> FetchedMessage:
    return FetchedMessage(f"INBOX:1:{uid}", "INBOX", "TikTok <no-reply@account.tiktok.com>", "x@hotmail.com", subject,
                          int(time.time()) - age, f"Your verification code is {code}. It expires in 10 minutes.")


class FakeSession:
    def __init__(self, provider: "FakeProvider", email: str) -> None:
        self.provider, self.email = provider, email

    def recent(self, limit: int = 10):
        if self.email in self.provider.temp_fail:
            raise TemporaryError("IMAP: timeout")
        now = time.monotonic()
        return [m for at, m in self.provider.boxes.get(self.email, []) if at <= now][:limit]

    def close(self) -> None:
        self.provider.closed += 1


class FakeProvider:
    def __init__(self) -> None:
        self.boxes: dict[str, list[tuple[float, FetchedMessage]]] = {}
        self.auth_fail: set[str] = set()
        self.temp_fail: set[str] = set()
        self.closed = 0

    def deliver(self, email: str, message: FetchedMessage, after: float = 0.0) -> None:
        self.boxes.setdefault(email, []).insert(0, (time.monotonic() + after, message))

    def check(self, acct):
        if acct.email in self.auth_fail:
            raise AuthError("IMAP: AUTHENTICATE failed.")
        if acct.email in self.temp_fail:
            raise TemporaryError("IMAP: timeout")
        return CheckResult(len(self.boxes.get(acct.email, [])), 3)

    def open(self, acct):
        if acct.email in self.auth_fail:
            raise AuthError("IMAP: AUTHENTICATE failed.")
        if acct.email in self.temp_fail:
            raise TemporaryError("IMAP: timeout")
        return FakeSession(self, acct.email)


class App:
    """Hub + HTTP server on an ephemeral port, with a small client."""

    def __init__(self, password: str = "correct-horse-1") -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.config = Config(data_dir=Path(self.tmp.name), host="127.0.0.1", port=0, background=False).finalize()
        self.provider = FakeProvider()
        self.hub = Hub(self.config, provider=self.provider)
        self.hub.auth.set_password(password)
        self.password = password
        self.server = HubServer(("127.0.0.1", 0), self.hub)
        self.port = self.server.server_address[1]
        self.cookie = ""
        self.csrf = ""
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def __enter__(self) -> "App":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def request(self, method: str, path: str, body=None, headers=None, content_type=None, raw: bool = False):
        headers = dict(headers or {})
        payload = None
        if body is not None:
            if isinstance(body, (dict, list)):
                payload, content_type = json.dumps(body).encode(), content_type or "application/json"
            else:
                payload = body if isinstance(body, bytes) else str(body).encode()
        if content_type:
            headers["Content-Type"] = content_type
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        conn.request(method, path, body=payload, headers=headers)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        if raw:
            return response.status, response, data
        try:
            return response.status, response, json.loads(data) if data else None
        except ValueError:
            return response.status, response, data.decode("utf-8", "replace")

    def login(self):
        status, response, data = self.request("POST", "/api/v1/auth/login", {"password": self.password})
        assert status == 200, data
        self.cookie = response.getheader("Set-Cookie").split(";")[0]
        self.csrf = data["csrf"]

    def admin(self, method: str, path: str, body=None, **kw):
        headers = {"Cookie": self.cookie, "X-CSRF-Token": self.csrf}
        return self.request(method, path, body, headers=headers, **kw)

    def key(self, scopes="bas") -> str:
        return self.hub.auth.create_key("t", scopes)[1]

    def with_key(self, key: str, method: str, path: str, body=None, **kw):
        return self.request(method, path, body, headers={"Authorization": f"Bearer {key}"}, **kw)
