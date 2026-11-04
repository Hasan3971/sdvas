"""HTTP plumbing on the standard library: routing, authentication, CSRF, static files."""
from __future__ import annotations

import hmac
import json
import logging
import mimetypes
import re
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import parsing
from .auth import Identity
from .hub import ApiError, Hub
from .multipart import parse_multipart

log = logging.getLogger("hub.http")
STATIC_DIR = Path(__file__).parent / "static"
SAFE_METHODS = ("GET", "HEAD", "OPTIONS")
COOKIE = "hm_session"
PATH_KEY = re.compile(r"^/k/([A-Za-z0-9_\-]{8,100})(/.*)?$")
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; "
       "base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")


@dataclass
class Response:
    status: int = 200
    body: bytes = b""
    content_type: str = "application/json; charset=utf-8"
    headers: dict = field(default_factory=dict)
    cookies: list = field(default_factory=list)

    @classmethod
    def json(cls, payload, status: int = 200) -> "Response":
        return cls(status, json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode())

    @classmethod
    def text(cls, text: str, status: int = 200, content_type: str = "text/plain; charset=utf-8",
             filename: str = "") -> "Response":
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'} if filename else {}
        return cls(status, text.encode("utf-8"), content_type, headers)


class Request:
    def __init__(self, handler: "Handler", method: str, path: str, raw_query: str, path_key: str) -> None:
        self.handler, self.method, self.path, self.path_key = handler, method, path, path_key
        self.query = {k: v[-1] for k, v in urllib.parse.parse_qs(raw_query, keep_blank_values=True).items()}
        self.headers = handler.headers
        self.params: dict[str, str] = {}
        self.identity: Identity | None = None
        self.files: dict[str, tuple[str, bytes]] = {}
        self._body: bytes | None = None
        self._data: dict | None = None

    @property
    def hub(self) -> Hub:
        return self.handler.server.hub  # type: ignore[attr-defined]

    @property
    def ip(self) -> str:
        peer = self.handler.client_address[0]
        if self.hub.config.trust_proxy:
            forwarded = self.headers.get("X-Forwarded-For", "")
            if forwarded:
                return forwarded.split(",")[-1].strip()[:64]
        return peer

    @property
    def secure(self) -> bool:
        mode = self.hub.config.cookie_secure
        if mode in ("always", "never"):
            return mode == "always"
        return self.hub.config.trust_proxy and self.headers.get("X-Forwarded-Proto", "").lower() == "https"

    @property
    def body(self) -> bytes:
        if self._body is None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length > self.hub.config.max_body:
                raise ApiError(413, "too_large", "тіло запиту завелике")
            self._body = self.handler.rfile.read(length) if length > 0 else b""
        return self._body

    @property
    def content_type(self) -> str:
        return (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()

    def data(self) -> dict:
        """Query string merged with a JSON, form, multipart or plain-text body."""
        if self._data is not None:
            return self._data
        data: dict = dict(self.query)
        body, kind = self.body, self.content_type
        if body:
            if kind == "multipart/form-data":
                fields, self.files = parse_multipart(self.headers.get("Content-Type", ""), body)
                data.update(fields)
            elif kind == "application/x-www-form-urlencoded":
                data.update({k: v[-1] for k, v in urllib.parse.parse_qs(body.decode("utf-8", "replace"),
                                                                        keep_blank_values=True).items()})
            elif kind.endswith("json") or body.lstrip()[:1] in (b"{", b"[") and kind in ("", "text/plain"):
                try:
                    parsed = json.loads(parsing.decode_bytes(body))
                except ValueError as exc:
                    raise ApiError(400, "bad_json", "некоректний JSON") from exc
                if isinstance(parsed, dict):
                    data.update(parsed)
                else:
                    data["items"] = parsed
            else:
                data.setdefault("text", parsing.decode_bytes(body))
        self._data = data
        return data

    def require(self, scope: str) -> None:
        if self.identity is None or not self.identity.can(scope):
            raise ApiError(403, "forbidden", f"потрібен дозвіл: {scope}")


class Router:
    def __init__(self) -> None:
        self.routes: list[tuple[str, re.Pattern, str | None, object]] = []

    def route(self, method: str, pattern: str, scope: str | None = None):
        regex = re.compile("^" + re.sub(r"\{(\w+)\}", r"(?P<\1>[^/]+)", pattern) + "/?$")

        def decorator(fn):
            self.routes.append((method, regex, scope, fn))
            return fn
        return decorator

    def match(self, method: str, path: str):
        allowed = False
        for verb, regex, scope, fn in self.routes:
            found = regex.match(path)
            if found:
                if verb == method or (method == "HEAD" and verb == "GET"):
                    return fn, scope, found.groupdict()
                allowed = True
        return "method" if allowed else None


router = Router()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HotmailHub"
    sys_version = ""
    timeout = 120

    def log_message(self, *args) -> None:
        pass

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = lambda self: self._handle()

    def _handle(self) -> None:
        started = time.monotonic()
        method = self.command
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path) or "/"
        key = PATH_KEY.match(path)
        path_key = ""
        if key:
            path_key, path = key.group(1), key.group(2) or "/"
        req = Request(self, method, path, parsed.query, path_key)
        try:
            response = self._route(req)
        except ApiError as exc:
            headers = {"Retry-After": str(exc.extra["retry_after"])} if "retry_after" in exc.extra else {}
            response = Response.json({"error": {"code": exc.code, "message": exc.message}}, exc.status)
            response.headers.update(headers)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception:
            log.exception("unhandled error on %s %s", method, path)
            response = Response.json({"error": {"code": "internal", "message": "внутрішня помилка сервера"}}, 500)
        self._send(req, response)
        shown = "/k/***" + (path if path_key else "")
        if not path.startswith("/api/v1/health"):
            log.info("%s %s %s %s %dms", req.ip, method, shown if path_key else path, response.status,
                     int((time.monotonic() - started) * 1000))

    def _authenticate(self, req: Request) -> Identity | None:
        hub = req.hub
        header = req.headers.get("Authorization", "")
        key = (req.path_key or (header[7:].strip() if header.lower().startswith("bearer ") else "")
               or req.headers.get("X-API-Key", "") or req.query.get("key", "") or req.query.get("api_key", ""))
        if key:
            wait = hub.auth.key_limiter.retry_after(req.ip)
            if wait:
                raise ApiError(429, "too_many_attempts", f"забагато невдалих спроб; повторіть через {wait} с", retry_after=wait)
            identity = hub.auth.find_key(key.strip())
            if identity is None:
                hub.auth.key_limiter.fail(req.ip)
            return identity
        for part in req.headers.get("Cookie", "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == COOKIE and value:
                return hub.auth.read_session(value)
        return None

    def _route(self, req: Request) -> Response:
        if req.method == "OPTIONS":
            return Response(204, headers={"Allow": "GET, POST, PUT, PATCH, DELETE, OPTIONS"})
        if req.method in ("GET", "HEAD") and not req.path.startswith(("/api/", "/bas/")):
            static = self._static(req)
            if static is not None:
                return static
        match = router.match(req.method, req.path)
        if match is None:
            raise ApiError(404, "not_found", "невідомий шлях")
        if match == "method":
            raise ApiError(405, "method_not_allowed", "метод не підтримується")
        fn, scope, params = match
        req.params = {k: urllib.parse.unquote(v) for k, v in params.items()}
        if scope:
            identity = self._authenticate(req)
            if identity is None:
                raise ApiError(401, "unauthorized", "потрібна авторизація: сесія або API-ключ")
            if scope != "auth" and not identity.can(scope):
                raise ApiError(403, "forbidden", f"потрібен дозвіл: {scope}")
            if identity.kind == "session" and req.method not in SAFE_METHODS and not hmac.compare_digest(
                    req.headers.get("X-CSRF-Token", ""), identity.csrf):
                raise ApiError(403, "csrf", "недійсний CSRF-токен; оновіть сторінку")
            req.identity = identity
        result = fn(req.hub, req)
        if isinstance(result, Response):
            return result
        if isinstance(result, tuple):
            return Response.json(result[1], result[0])
        return Response.json(result)

    def _static(self, req: Request) -> Response | None:
        rel = "index.html" if req.path in ("", "/") else req.path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if not target.is_file() or STATIC_DIR.resolve() not in target.parents:
            return None
        stat = target.stat()
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        if req.headers.get("If-None-Match") == etag:
            return Response(304, headers={"ETag": etag, "Cache-Control": "no-cache"})
        kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if kind.startswith("text/") or kind.endswith(("javascript", "json", "svg+xml")):
            kind += "; charset=utf-8"
        return Response(200, target.read_bytes(), kind, {"ETag": etag, "Cache-Control": "no-cache"})

    def _send(self, req: Request, response: Response) -> None:
        body = b"" if req.method == "HEAD" or response.status in (204, 304) else response.body
        try:
            self.send_response(response.status)
            if response.status != 204 or response.body:
                self.send_header("Content-Type", response.content_type)
            self.send_header("Content-Length", str(len(response.body) if req.method == "HEAD" else len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", CSP)
            if "Cache-Control" not in response.headers:
                self.send_header("Cache-Control", "no-store")
            for name, value in response.headers.items():
                self.send_header(name, value)
            for cookie in response.cookies:
                self.send_header("Set-Cookie", cookie)
            self.end_headers()
            if body:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


class HubServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128

    def __init__(self, address, hub: Hub) -> None:
        self.hub = hub
        super().__init__(address, Handler)

    def handle_error(self, request, client_address) -> None:
        log.debug("connection error from %s", client_address)
