import imaplib
import unittest

from hotmailhub import providers as pv

UUID = "123e4567-e89b-12d3-a456-426614174000"
RAW = (b"From: TikTok <no-reply@tiktok.com>\r\nTo: u@hotmail.com\r\nSubject: =?utf-8?B?0JrQvtC0IDEyMzQ1Ng==?=\r\n"
       b"Content-Type: text/html; charset=utf-8\r\n\r\n<p>Your verification code is <b>123456</b></p>")


class FakeImap:
    def __init__(self, folders=None, fail_auth=0):
        self.folders = folders or {"INBOX": [(1, RAW)], "Junk": [(7, RAW)]}
        self.fail_auth, self.current, self.log = fail_auth, "", []

    def authenticate(self, mech, cb):
        self.log.append(("auth", cb(b"")))
        if self.fail_auth:
            self.fail_auth -= 1
            raise imaplib.IMAP4.error("AUTHENTICATE failed.")

    def login(self, user, password):
        self.log.append(("login", user))
        if password == "bad":
            raise imaplib.IMAP4.error("[AUTHENTICATIONFAILED] Invalid credentials")

    def noop(self): return "OK", [b""]
    def list(self): return "OK", [b'(\\HasNoChildren) "/" "INBOX"', b'(\\HasNoChildren \\Junk) "/" "Junk"']
    def response(self, name): return name, [b"42"]
    def logout(self): self.log.append(("logout",))
    def close(self): pass

    def select(self, folder, readonly=True):
        name = folder.strip('"')
        if name not in self.folders:
            return "NO", [b"nope"]
        self.current = name
        return "OK", [str(len(self.folders[name])).encode()]

    def uid(self, command, *args):
        items = self.folders[self.current]
        if command == "SEARCH":
            return "OK", [b" ".join(str(u).encode() for u, _ in items)]
        uid = int(args[0])
        raw = dict(items)[uid]
        head = b'1 (UID %d INTERNALDATE "04-Nov-2026 13:00:00 +0000" BODY[]<0> {%d}' % (uid, len(raw))
        return "OK", [(head, raw), b")"]


def provider(imap=None, post=None, rotate=None):
    return pv.LiveProvider("https://x", 5, 4, on_rotate=rotate, imap_factory=lambda h, p: imap,
                           http_post=post or (lambda form: {"access_token": "AT", "expires_in": 3600}))


class ImapTests(unittest.TestCase):
    def test_session_reads_inbox_and_junk(self):
        acct = pv.Account(1, "u@hotmail.com", "", "M.C5t", UUID)
        session = provider(FakeImap()).open(acct)
        found = session.recent(5)
        self.assertEqual(sorted(m.folder for m in found), ["INBOX", "Junk"])
        self.assertEqual(found[0].subject, "Код 123456")
        self.assertIn("123456", found[0].body)
        self.assertEqual(found[0].received_at, 1793797200)
        session.close()

    def test_xoauth2_payload_and_check(self):
        imap = FakeImap()
        result = provider(imap).check(pv.Account(1, "u@hotmail.com", "", "M.C5t", UUID))
        self.assertEqual(result.messages, 1)
        self.assertEqual(imap.log[0], ("auth", b"user=u@hotmail.com\x01auth=Bearer AT\x01\x01"))

    def test_password_login_failure_is_auth_error(self):
        with self.assertRaises(pv.AuthError):
            provider(FakeImap()).check(pv.Account(1, "u@rambler.ru", "bad"))

    def test_microsoft_without_oauth_is_rejected_early(self):
        with self.assertRaises(pv.AuthError) as ctx:
            provider(FakeImap()).check(pv.Account(1, "u@hotmail.com", "pw"))
        self.assertIn("OAuth", str(ctx.exception))

    def test_stale_token_is_refreshed_once(self):
        imap = FakeImap(fail_auth=1)
        calls = []
        post = lambda form: calls.append(form["scope"]) or {"access_token": f"AT{len(calls)}", "expires_in": 3600}
        provider(imap, post).check(pv.Account(1, "u@hotmail.com", "", "M.C5t", UUID))
        self.assertEqual(len(calls), 2)


class OAuthTests(unittest.TestCase):
    def test_rotated_refresh_token_is_reported(self):
        seen = []
        post = lambda form: {"access_token": "AT", "refresh_token": "NEW", "expires_in": 3600}
        client = pv.OAuthClient("https://x", 5, post=post, on_rotate=lambda *a: seen.append(a))
        acct = pv.Account(9, "u@hotmail.com", "", "OLD", UUID)
        self.assertEqual(client.access_token(acct), "AT")
        self.assertEqual((acct.refresh_token, seen), ("NEW", [(9, "OLD", "NEW")]))
        self.assertEqual(client.access_token(acct), "AT")  # cached: no second rotation

    def test_scope_fallback(self):
        scopes = []

        def post(form):
            scopes.append(form["scope"])
            if form["scope"] == pv.IMAP_SCOPE:
                raise pv.AuthError("OAuth invalid_grant: scope")
            return {"access_token": "AT"}
        client = pv.OAuthClient("https://x", 5, post=post)
        self.assertEqual(client.access_token(pv.Account(1, "u@hotmail.com", "", "R", UUID)), "AT")
        self.assertEqual(scopes, [pv.IMAP_SCOPE, pv.LEGACY_SCOPE])

    def test_all_scopes_rejected_raises_first_error(self):
        def post(form):
            raise pv.AuthError("OAuth invalid_grant: expired")
        with self.assertRaises(pv.AuthError):
            pv.OAuthClient("https://x", 5, post=post).access_token(pv.Account(1, "u@hotmail.com", "", "R", UUID))

    def test_endpoint_resolution(self):
        self.assertEqual(pv.resolve_endpoint(pv.Account(1, "a@hotmail.com", "", "r", UUID)), ("outlook.office365.com", 993))
        self.assertEqual(pv.resolve_endpoint(pv.Account(1, "a@ukr.net", "p")), ("imap.ukr.net", 993))
        self.assertEqual(pv.resolve_endpoint(pv.Account(1, "a@my.org", "p", imap_host="mx.my.org", imap_port=143)), ("mx.my.org", 143))


if __name__ == "__main__":
    unittest.main()
