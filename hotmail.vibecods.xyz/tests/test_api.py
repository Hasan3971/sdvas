import hashlib
import hmac
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from hotmailhub.web import STATIC_DIR

from .helpers import App, oauth_line, tiktok_message


def multipart(fields, files):
    boundary = "----hubtest"
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields.items()]
    for name, (filename, data) in files.items():
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                      "Content-Type: application/octet-stream\r\n\r\n").encode() + data + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


class ApiCase(unittest.TestCase):
    def setUp(self):
        self.app = App()
        self.app.hub.update_settings({"poll_interval": 1})

    def tearDown(self):
        self.app.close()

    def admin(self, *a, **k):
        if not self.app.cookie:
            self.app.login()
        return self.app.admin(*a, **k)


class AuthTests(ApiCase):
    def test_protected_routes_need_auth_and_health_is_public(self):
        self.assertEqual(self.app.request("GET", "/api/v1/mailboxes")[0], 401)
        status, response, data = self.app.request("GET", "/health")
        self.assertEqual((status, data["ok"]), (200, True))
        self.assertIn("default-src 'self'", response.getheader("Content-Security-Policy"))
        self.assertEqual(response.getheader("X-Content-Type-Options"), "nosniff")

    def test_login_cookie_and_csrf(self):
        self.assertEqual(self.app.request("POST", "/api/v1/auth/login", {"password": "nope"})[0], 401)
        self.app.login()
        status, response, _ = self.app.request("POST", "/api/v1/auth/login", {"password": self.app.password})
        cookie = response.getheader("Set-Cookie")
        self.assertTrue("HttpOnly" in cookie and "SameSite=Lax" in cookie)
        self.assertEqual(self.app.request("GET", "/api/v1/me", headers={"Cookie": self.app.cookie})[2]["kind"], "session")
        no_csrf = self.app.request("POST", "/api/v1/mailboxes", {"email": "a@mail.ru", "password": "p"},
                                   headers={"Cookie": self.app.cookie})
        self.assertEqual(no_csrf[0], 403)
        self.assertEqual(self.app.admin("POST", "/api/v1/mailboxes", {"email": "a@mail.ru", "password": "p"})[0], 201)

    def test_login_is_rate_limited(self):
        codes = [self.app.request("POST", "/api/v1/auth/login", {"password": "x"})[0] for _ in range(11)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)
        self.assertEqual(self.app.request("POST", "/api/v1/auth/login", {"password": self.app.password})[0], 429)

    def test_key_transports(self):
        key = self.app.key("readonly")
        for headers, path in (({"Authorization": f"Bearer {key}"}, "/api/v1/stats"), ({"X-API-Key": key}, "/api/v1/stats"),
                              ({}, f"/api/v1/stats?key={key}"), ({}, f"/k/{key}/api/v1/stats")):
            self.assertEqual(self.app.request("GET", path, headers=headers)[0], 200, path)
        self.assertEqual(self.app.request("GET", "/api/v1/stats", headers={"X-API-Key": "hm_wrong"})[0], 401)

    def test_scopes(self):
        reader, bas = self.app.key("readonly"), self.app.key("bas")
        body = {"email": "a@mail.ru", "password": "p"}
        self.assertEqual(self.app.with_key(reader, "POST", "/api/v1/mailboxes", body)[0], 403)
        self.assertEqual(self.app.with_key(bas, "POST", "/api/v1/mailboxes", body)[0], 201)
        self.assertEqual(self.app.with_key(bas, "GET", "/api/v1/mailboxes?secrets=1")[0], 403)
        self.assertEqual(self.app.with_key(bas, "GET", "/api/v1/keys")[0], 403)
        self.assertEqual(self.app.with_key(self.app.key("admin"), "GET", "/api/v1/keys")[0], 200)

    def test_revoked_key_stops_working_and_key_is_shown_once(self):
        status, _, created = self.admin("POST", "/api/v1/keys", {"name": "BAS 2", "preset": "bas"})
        self.assertEqual(status, 201)
        self.assertEqual(self.app.with_key(created["key"], "GET", "/api/v1/stats")[0], 200)
        listed = self.admin("GET", "/api/v1/keys")[2]["items"]
        self.assertTrue(all("key" not in item for item in listed))
        self.assertEqual(self.admin("DELETE", f"/api/v1/keys/{created['id']}")[0], 200)
        self.assertEqual(self.app.with_key(created["key"], "GET", "/api/v1/stats")[0], 401)

    def test_password_change_invalidates_other_sessions(self):
        self.app.login()
        old_cookie = self.app.cookie
        self.assertEqual(self.app.admin("POST", "/api/v1/auth/password", {"current": "bad", "new": "new-password-1"})[0], 403)
        self.assertEqual(self.app.admin("POST", "/api/v1/auth/password", {"current": self.app.password, "new": "short"})[0], 400)
        self.assertEqual(self.app.admin("POST", "/api/v1/auth/password", {"current": self.app.password, "new": "new-password-1"})[0], 200)
        self.assertEqual(self.app.request("GET", "/api/v1/me", headers={"Cookie": old_cookie})[0], 401)

    def test_static_and_traversal(self):
        index = STATIC_DIR / "index.html"
        if index.exists():
            status, response, _ = self.app.request("GET", "/", raw=True)
            self.assertEqual((status, response.getheader("Content-Type").split(";")[0]), (200, "text/html"))
        for path in ("/%2e%2e/config.py", "/..%2fconfig.py", "/static/../../hub.py"):
            self.assertEqual(self.app.request("GET", path)[0], 404, path)


class HttpRobustnessTests(ApiCase):
    def raw(self, payload: bytes, expect: int) -> bytes:
        import socket
        with socket.create_connection(("127.0.0.1", self.app.port), timeout=10) as sock:
            sock.sendall(payload)
            sock.settimeout(5)
            data = b""
            try:
                while data.count(b"HTTP/1.1 ") < expect:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    data += chunk
            except socket.timeout:
                pass
            return data

    def test_unread_body_does_not_poison_the_next_request(self):
        body = b'{"email":"a@mail.ru","password":"p"}'
        req = (b"POST /api/v1/mailboxes HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n" % len(body)) + body
        data = self.raw(req + b"GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", 2)
        self.assertIn(b"HTTP/1.1 401", data)
        self.assertIn(b"HTTP/1.1 200", data)

    def test_chunked_import_is_decoded(self):
        key = self.app.key("bas")
        text = b"a@mail.ru;p\nb@mail.ru;p\n"
        chunks = b"%x\r\n%s\r\n0\r\n\r\n" % (len(text), text)
        head = (f"POST /api/v1/import HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {key}\r\nContent-Type: text/plain\r\n"
                "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n").encode()
        data = self.raw(head + chunks, 1)
        self.assertIn(b"HTTP/1.1 200", data)
        self.assertEqual(self.app.hub.stats()["total"], 2)

    def test_oversized_body_is_rejected(self):
        self.app.hub.config.max_body = 100
        key = self.app.key("bas")
        status, _, data = self.app.with_key(key, "POST", "/api/v1/import", "x" * 500, content_type="text/plain")
        self.assertEqual(status, 413)


class MailboxApiTests(ApiCase):
    def test_crud(self):
        self.admin("GET", "/api/v1/stats")
        status, _, box = self.admin("POST", "/api/v1/mailboxes", {"email": "A@Mail.ru", "password": "p", "tags": ["x"], "note": "hi"})
        self.assertEqual((status, box["email"], box["tags"]), (201, "a@mail.ru", ["x"]))
        self.assertEqual(self.admin("POST", "/api/v1/mailboxes", {"email": "a@mail.ru", "password": "p"})[0], 409)
        self.assertEqual(self.admin("POST", "/api/v1/mailboxes", {"email": "bad", "password": "p"})[0], 400)
        status, _, box = self.admin("PATCH", "/api/v1/mailboxes/a%40mail.ru", {"note": "new", "status": "burned"})
        self.assertEqual((status, box["note"], box["status"]), (200, "new", "burned"))
        self.assertEqual(self.admin("GET", "/api/v1/mailboxes/a@mail.ru")[2]["email"], "a@mail.ru")
        self.assertNotIn("password", self.admin("GET", "/api/v1/mailboxes/a@mail.ru")[2])
        self.assertEqual(self.admin("GET", "/api/v1/mailboxes/a@mail.ru?secrets=1")[2]["password"], "p")
        self.assertEqual(self.admin("DELETE", "/api/v1/mailboxes/a@mail.ru")[0], 200)
        self.assertEqual(self.admin("GET", "/api/v1/mailboxes/a@mail.ru")[0], 404)
        self.assertEqual(self.admin("DELETE", "/api/v1/mailboxes/a@mail.ru")[0], 404)

    def test_list_filters_sort_paging(self):
        self.app.hub.import_text("a@mail.ru;p\nb@mail.ru;p\nc@gmail.com;p\n" + oauth_line("d@hotmail.com", 1))
        self.app.hub.set_status("b@mail.ru", "used")
        listing = lambda q: self.admin("GET", "/api/v1/mailboxes?" + q)[2]
        self.assertEqual(listing("")["total"], 4)
        self.assertEqual(listing("status=used")["items"][0]["email"], "b@mail.ru")
        self.assertEqual(listing("q=gmail")["total"], 1)
        self.assertEqual(listing("type=oauth2")["items"][0]["email"], "d@hotmail.com")
        page = listing("sort=email&order=desc&limit=2&offset=1")
        self.assertEqual([m["email"] for m in page["items"]], ["c@gmail.com", "b@mail.ru"])
        self.assertEqual(page["total"], 4)

    def test_bulk_actions(self):
        self.app.hub.import_text("a@mail.ru;p\nb@mail.ru;p\nc@mail.ru;p")
        self.assertEqual(self.admin("POST", "/api/v1/mailboxes/bulk", {"action": "status", "emails": ["a@mail.ru", "b@mail.ru"], "status": "used"})[2]["updated"], 2)
        self.assertEqual(self.admin("POST", "/api/v1/mailboxes/bulk", {"action": "tags", "filter": {"status": "used"}, "add": ["done"]})[2]["updated"], 2)
        self.assertEqual(self.admin("POST", "/api/v1/mailboxes/bulk", {"action": "delete", "filter": {"status": "used"}})[2]["deleted"], 2)
        self.assertEqual(self.admin("POST", "/api/v1/mailboxes/bulk", {"action": "delete"})[0], 400)
        self.assertEqual(self.app.hub.stats()["total"], 1)


class ImportExportTests(ApiCase):
    def test_import_encodings(self):
        key = self.app.key("bas")
        lines = "a@mail.ru;p\nb@mail.ru;p\nbroken"
        status, _, r = self.app.with_key(key, "POST", "/api/v1/import?status=available", lines, content_type="text/plain")
        self.assertEqual((status, r["counts"]["added"], r["counts"]["invalid"]), (200, 2, 1))
        status, _, r = self.app.with_key(key, "POST", "/api/v1/import", {"lines": "c@mail.ru;p", "tags": "batch2"})
        self.assertEqual(r["counts"]["added"], 1)
        status, _, r = self.app.with_key(key, "POST", "/api/v1/import", "text=d%40mail.ru%3Bp&mode=skip", content_type="application/x-www-form-urlencoded")
        self.assertEqual(r["counts"]["added"], 1)
        status, _, r = self.app.with_key(key, "POST", "/api/v1/import", [{"email": "e@mail.ru", "password": "p"}])
        self.assertEqual(r["counts"]["added"], 1)
        status, _, r = self.app.with_key(key, "POST", "/api/v1/mailboxes", {"lines": "f@mail.ru;p"})
        self.assertEqual(r["counts"]["added"], 1)
        self.assertEqual(self.app.hub.stats()["total"], 6)

    def test_multipart_file_utf16_and_dry_run(self):
        body, ctype = multipart({"mode": "skip", "dry_run": "1"}, {"file": ("mails.txt", "a@mail.ru;p\nb@mail.ru;p\n".encode("utf-16"))})
        status, _, r = self.admin("POST", "/api/v1/import", body, content_type=ctype)
        self.assertEqual((status, r["dry_run"], r["counts"]["added"]), (200, True, 2))
        self.assertEqual(self.app.hub.stats()["total"], 0)
        body, ctype = multipart({}, {"file": ("mails.csv", b"email,password,status\nz@mail.ru,pw,used\n")})
        status, _, r = self.admin("POST", "/api/v1/import", body, content_type=ctype)
        self.assertEqual(r["counts"]["added"], 1)
        self.assertEqual(self.app.hub.get_mailbox("z@mail.ru")["status"], "used")

    def test_empty_import_and_check_after_import(self):
        self.assertEqual(self.admin("POST", "/api/v1/import", {"text": "  "})[0], 400)
        status, _, r = self.admin("POST", "/api/v1/import", {"text": "a@mail.ru;p", "check": True})
        self.assertIn("job", r)

    def test_export_formats_and_secret_scope(self):
        self.app.hub.import_text("a@mail.ru;topsecret")
        status, response, body = self.admin("GET", "/api/v1/export?format=txt", raw=True)
        self.assertEqual((status, body.decode().strip()), (200, "a@mail.ru;topsecret"))
        self.assertIn("attachment", response.getheader("Content-Disposition"))
        self.assertEqual(self.admin("GET", "/api/v1/export?format=json")[2][0]["password"], "topsecret")
        bas = self.app.key("bas")
        self.assertEqual(self.app.with_key(bas, "GET", "/api/v1/export?secrets=1")[0], 403)
        status, _, body = self.app.with_key(bas, "GET", "/api/v1/export?format=txt", raw=True)
        self.assertEqual(body.decode().strip(), "a@mail.ru")
        self.assertEqual(self.admin("GET", "/api/v1/export?format=xml")[0], 400)


class PoolAndCodeTests(ApiCase):
    def setUp(self):
        super().setUp()
        self.app.hub.import_text("a@hotmail.com;p\nb@hotmail.com;p")
        self.key = self.app.key("bas")

    def test_acquire_release_flow(self):
        status, _, r = self.app.with_key(self.key, "POST", "/api/v1/pool/acquire", {"count": 1, "owner": "bot-1", "ttl": 60})
        self.assertEqual((status, r["items"][0]["lease"]["owner"], r["available"]), (200, "bot-1", 1))
        email = r["items"][0]["email"]
        self.assertEqual(self.app.with_key(self.key, "POST", "/api/v1/pool/acquire", {"format": "line"})[0], 403)
        status, _, text = self.app.with_key(self.key, "POST", "/api/v1/pool/acquire", {"format": "email"}, raw=True)
        self.assertEqual(text.decode().strip(), "b@hotmail.com" if email == "a@hotmail.com" else "a@hotmail.com")
        self.assertEqual(self.app.with_key(self.key, "POST", f"/api/v1/mailboxes/{email}/extend", {"ttl": 300})[0], 200)
        status, _, r = self.app.with_key(self.key, "POST", "/api/v1/pool/release", {"email": email, "status": "burned", "note": "limit"})
        self.assertEqual((r["status"], r["note"]), ("burned", "limit"))

    def test_bas_text_endpoints(self):
        status, _, nxt = self.app.with_key(self.key, "GET", "/bas/next", raw=True)
        email = nxt.decode()
        self.assertTrue(email.endswith("@hotmail.com"))
        self.assertEqual(self.app.with_key(self.key, "GET", "/bas/next?format=line", raw=True)[0], 403)
        self.app.provider.deliver(email, tiktok_message("424242"))
        status, response, code = self.app.with_key(self.key, "GET", f"/bas/code?email={email}&timeout=0", raw=True)
        self.assertEqual((status, code.decode(), response.getheader("Content-Type").split(";")[0]), (200, "424242", "text/plain"))
        self.assertEqual(self.app.with_key(self.key, "GET", f"/bas/done?email={email}&status=used", raw=True)[2], b"ok")
        self.assertEqual(self.app.hub.get_mailbox(email)["status"], "used")

    def test_v1_code_json_and_text(self):
        self.app.provider.deliver("a@hotmail.com", tiktok_message("135790"))
        status, _, r = self.app.with_key(self.key, "GET", "/api/v1/mailboxes/a@hotmail.com/code")
        self.assertEqual((status, r["found"], r["code"], r["subject"]), (200, True, "135790", "Verification code"))
        status, _, r = self.app.with_key(self.key, "GET", "/api/v1/code?email=b@hotmail.com&wait=0")
        self.assertEqual((status, r["found"], r["code"]), (200, False, ""))
        status, _, body = self.app.with_key(self.key, "GET", "/api/v1/mailboxes/a@hotmail.com/code?format=text", raw=True)
        self.assertEqual(body, b"135790")

    def test_legacy_code_contract_for_bas(self):
        self.app.provider.deliver("a@hotmail.com", tiktok_message("246810"))
        status, _, r = self.app.with_key(self.key, "GET", "/code?email=a%40hotmail.com&timeout=120")
        self.assertEqual((status, r["code"], r["email"]), (200, "246810", "a@hotmail.com"))
        status, _, r = self.app.request("GET", f"/k/{self.key}/code?email=a@hotmail.com&timeout=5")
        self.assertEqual(r["code"], "246810")
        self.assertEqual(self.app.with_key(self.key, "GET", "/code?email=ghost@hotmail.com&timeout=0")[0], 404)
        self.assertEqual(self.app.with_key(self.key, "GET", "/code")[0], 400)
        status, _, r = self.app.with_key(self.key, "GET", "/api/code?email=b@hotmail.com&timeout=0")
        self.assertEqual((status, r["code"]), (200, ""))
        self.assertIn("error", r)
        self.app.provider.auth_fail.add("b@hotmail.com")
        status, _, r = self.app.with_key(self.key, "GET", "/api/code?email=b@hotmail.com&timeout=0")
        self.assertEqual((status, r["code"]), (200, ""))
        self.assertEqual(self.app.with_key(self.key, "GET", "/api/v1/mailboxes/b@hotmail.com/code")[0], 409)

    def test_long_poll_over_http(self):
        self.app.provider.deliver("a@hotmail.com", tiktok_message("808080"), after=1.2)
        started = time.monotonic()
        status, _, r = self.app.with_key(self.key, "GET", "/api/v1/mailboxes/a@hotmail.com/code?wait=8")
        self.assertEqual((status, r["code"]), (200, "808080"))
        self.assertLess(time.monotonic() - started, 6)

    def test_check_job_and_messages(self):
        job = self.app.with_key(self.key, "POST", "/api/v1/check", {"status": "available"})[2]
        for _ in range(40):
            snap = self.app.with_key(self.key, "GET", f"/api/v1/jobs/{job['id']}")[2]
            if snap["state"] == "done":
                break
            time.sleep(0.1)
        self.assertEqual((snap["total"], snap["ok"]), (2, 2))
        self.assertEqual(self.app.with_key(self.key, "GET", "/api/v1/jobs/nope")[0], 404)
        self.app.provider.deliver("a@hotmail.com", tiktok_message("121212"))
        listing = self.app.with_key(self.key, "GET", "/api/v1/mailboxes/a@hotmail.com/messages?refresh=1")[2]
        mid = listing["items"][0]["id"]
        self.assertEqual(listing["items"][0]["codes"], ["121212"])
        self.assertIn("body", self.app.with_key(self.key, "GET", f"/api/v1/mailboxes/a@hotmail.com/messages/{mid}")[2])
        self.assertEqual(self.app.with_key(self.key, "POST", "/api/v1/mailboxes/a@hotmail.com/check")[2]["ok"], True)


class Receiver(BaseHTTPRequestHandler):
    received = []

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        Receiver.received.append((dict(self.headers), body))
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a):
        pass


class WebhookSettingsTests(ApiCase):
    def test_signed_delivery_on_status_change(self):
        Receiver.received = []
        server = HTTPServer(("127.0.0.1", 0), Receiver)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{server.server_address[1]}/hook"
            status, _, hook = self.admin("POST", "/api/v1/webhooks", {"url": url, "events": ["mailbox.status", "ping"]})
            self.assertEqual(status, 201)
            secret = hook["secret"]
            self.assertTrue(secret)
            self.assertIsNone(self.admin("GET", "/api/v1/webhooks")[2]["items"][0].get("secret"))
            self.assertEqual(self.admin("POST", f"/api/v1/webhooks/{hook['id']}/test")[2]["ok"], True)
            self.app.hub.import_text("a@mail.ru;p")
            self.app.hub.set_status("a@mail.ru", "used")
            for _ in range(50):
                if len(Receiver.received) >= 2:
                    break
                time.sleep(0.1)
            events = {h.get("X-Hub-Event"): (h, b) for h, b in Receiver.received}
            headers, body = events["mailbox.status"]
            expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
            self.assertEqual(headers["X-Hub-Signature"], expected)
            self.assertEqual(json.loads(body)["data"], {"email": "a@mail.ru", "from": "available", "to": "used"})
        finally:
            server.shutdown()
            server.server_close()

    def test_webhook_validation_and_crud(self):
        self.assertEqual(self.admin("POST", "/api/v1/webhooks", {"url": "ftp://x"})[0], 400)
        hook = self.admin("POST", "/api/v1/webhooks", {"url": "http://127.0.0.1:9/x", "secret": "s"})[2]
        self.assertIsNone(hook["secret"])
        self.assertEqual(self.admin("PATCH", f"/api/v1/webhooks/{hook['id']}", {"active": False})[2]["active"], False)
        self.assertEqual(self.admin("DELETE", f"/api/v1/webhooks/{hook['id']}")[0], 200)
        self.assertEqual(self.admin("DELETE", f"/api/v1/webhooks/{hook['id']}")[0], 404)

    def test_settings_and_events(self):
        status, _, r = self.admin("PUT", "/api/v1/settings", {"lease_ttl": 120, "code_patterns": ["\\b(\\d{8})\\b"]})
        self.assertEqual((status, r["settings"]["lease_ttl"]), (200, 120))
        self.assertEqual(self.admin("PUT", "/api/v1/settings", {"code_patterns": ["("]})[0], 400)
        self.assertEqual(self.admin("GET", "/api/v1/settings")[2]["defaults"]["lease_ttl"], 900)
        kinds = [e["kind"] for e in self.admin("GET", "/api/v1/events?limit=5")[2]["items"]]
        self.assertIn("settings.updated", kinds)
        self.assertEqual(self.admin("GET", "/api/v1/nonexistent")[0], 404)
        self.assertEqual(self.admin("DELETE", "/api/v1/stats")[0], 405)


if __name__ == "__main__":
    unittest.main()
