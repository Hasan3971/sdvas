import json
import unittest

from hotmailhub import parsing
from hotmailhub.codes import find_codes, html_to_text, marker_match

UUID = "123e4567-e89b-12d3-a456-426614174000"


class ParseLine(unittest.TestCase):
    def test_oauth_colon_with_colon_in_password(self):
        rec = parsing.parse_line(f"A@Hotmail.com:pa:ss:M.C5abc!x:{UUID}")
        self.assertEqual((rec.email, rec.password, rec.refresh_token, rec.client_id), ("a@hotmail.com", "pa:ss", "M.C5abc!x", UUID))
        self.assertTrue(rec.oauth)

    def test_oauth_pipe_and_semicolon(self):
        for sep in ("|", ";"):
            rec = parsing.parse_line(sep.join(["u@outlook.com", "pw", "M.R3tok", UUID]))
            self.assertTrue(rec.oauth, sep)

    def test_imap_forms(self):
        self.assertEqual(parsing.parse_line("u@rambler.ru;pw").imap_host, "")
        rec = parsing.parse_line("u@yandex.ru;pw;imap.yandex.ru:1993;box@gmail.com")
        self.assertEqual((rec.imap_host, rec.imap_port, rec.login), ("imap.yandex.ru", 1993, "box@gmail.com"))
        self.assertEqual(parsing.parse_line("u@gmx.com:secret").password, "secret")

    def test_disabled_prefix_and_roundtrip(self):
        rec = parsing.parse_line("#disabled u@mail.ru;pw")
        self.assertEqual(rec.status, "disabled")
        line = parsing.format_line("u@mail.ru", "pw", imap_host="imap.mail.ru", imap_port=993, login="b@mail.ru")
        self.assertEqual(parsing.parse_line(line).login, "b@mail.ru")

    def test_errors_do_not_echo_secrets(self):
        for bad in ("nonsense", "u@x.com", "not-an-email;pw", "u@x.com;pw;h;l;extra", "u@x.com:pw:tok"):
            with self.assertRaises(parsing.ParseError):
                parsing.parse_line(bad)
        items = parsing.parse_text("u@x.com;pw;h;l;extra-secret-value")
        self.assertNotIn("extra-secret-value", items[0].preview)

    def test_text_json_csv(self):
        items = parsing.parse_text("# comment\n\nu@mail.ru;pw\nbroken\n")
        self.assertEqual([i.line for i in items], [3, 4])
        self.assertIsNone(items[1].record)
        data = json.dumps([{"email": "a@mail.ru", "password": "p", "tags": "x,y", "status": "used"}, "b@mail.ru;pw", {"email": "bad"}])
        items = parsing.parse_text(data)
        self.assertEqual((items[0].record.status, items[0].record.tags), ("used", ["x", "y"]))
        self.assertIsNone(items[2].record)
        csv_text = f"email,password,refresh_token,client_id,note\na@hotmail.com,pw,M.C5t,{UUID},hello\n"
        rec = parsing.parse_text(csv_text, "x.csv")[0].record
        self.assertEqual((rec.oauth, rec.note), (True, "hello"))

    def test_decode_bytes(self):
        self.assertEqual(parsing.decode_bytes("пошта".encode("utf-16")), "пошта")
        self.assertEqual(parsing.decode_bytes("пошта".encode("cp1251")), "пошта")
        self.assertEqual(parsing.decode_bytes(b"\xef\xbb\xbfabc"), "abc")


class Codes(unittest.TestCase):
    def test_keyword_proximity_wins(self):
        text = "Order 654321 shipped. Your TikTok verification code is 123456."
        self.assertEqual(find_codes(text)[0], "123456")

    def test_alnum_code(self):
        self.assertEqual(find_codes("Code: 9WBH3Q")[0], "9WBH3Q")

    def test_html_to_text_drops_styles(self):
        raw = "<html><style>.a{color:#FF2D55}</style><body><p>Code <b>111222</b></p></body></html>"
        text = html_to_text(raw)
        self.assertIn("111222", text)
        self.assertNotIn("FF2D55", text)

    def test_markers(self):
        self.assertTrue(marker_match("tiktok,verify", "Hello", "TikTok <a@b>"))
        self.assertFalse(marker_match("tiktok", "Newsletter", "shop@x.com"))


if __name__ == "__main__":
    unittest.main()
