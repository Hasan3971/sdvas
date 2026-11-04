import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from hotmailhub.config import Config
from hotmailhub.hub import ApiError, Hub

from .helpers import FakeProvider, oauth_line, tiktok_message


class HubCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.provider = FakeProvider()
        self.hub = Hub(Config(data_dir=Path(self.tmp.name)).finalize(), provider=self.provider)
        self.hub.update_settings({"poll_interval": 1})

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, text, **kw):
        return self.hub.import_text(text, **kw)

    def status(self, email):
        return self.hub.get_mailbox(email)["status"]


class ImportTests(HubCase):
    def test_counts_duplicates_and_invalid(self):
        r = self.add(f"{oauth_line('a@hotmail.com')}\nb@rambler.ru;pw\nb@rambler.ru;again\nnonsense\n")
        self.assertEqual(r["counts"], {"added": 2, "updated": 0, "skipped": 0, "duplicate_in_file": 1, "invalid": 1})
        self.assertEqual([x["action"] for x in r["results"]], ["added", "added", "duplicate_in_file", "invalid"])

    def test_skip_vs_update_keeps_status(self):
        self.add("a@mail.ru;old")
        self.hub.set_status("a@mail.ru", "used")
        self.assertEqual(self.add("a@mail.ru;new")["counts"]["skipped"], 1)
        r = self.add("a@mail.ru;new", mode="update")
        self.assertEqual(r["counts"]["updated"], 1)
        box = self.hub.get_mailbox("a@mail.ru", secrets=True)
        self.assertEqual((box["password"], box["status"]), ("new", "used"))

    def test_dry_run_writes_nothing(self):
        r = self.add("a@mail.ru;pw\nb@mail.ru;pw", dry_run=True)
        self.assertEqual(r["counts"]["added"], 2)
        self.assertEqual(self.hub.stats()["total"], 0)

    def test_status_tags_and_disabled_marker(self):
        self.add("#disabled a@mail.ru;pw\nb@mail.ru;pw", status="burned", tags=["Batch1"])
        self.assertEqual(self.status("a@mail.ru"), "disabled")
        self.assertEqual(self.status("b@mail.ru"), "burned")
        self.assertEqual(self.hub.get_mailbox("b@mail.ru")["tags"], ["batch1"])
        with self.assertRaises(ApiError):
            self.add("c@mail.ru;pw", status="nonsense")


class PoolTests(HubCase):
    def test_acquire_least_recently_used_and_skips_unhealthy(self):
        self.add("a@mail.ru;p\nb@mail.ru;p\nc@mail.ru;p")
        self.provider.auth_fail.add("a@mail.ru")
        self.hub.check_mailbox("a@mail.ru")
        got = self.hub.acquire(5, owner="bas")
        self.assertEqual([m["email"] for m in got["items"]], ["b@mail.ru", "c@mail.ru"])
        self.assertEqual(got["available"], 0)
        self.assertEqual(self.hub.acquire(1)["items"], [])
        self.assertEqual(got["items"][0]["lease"]["owner"], "bas")

    def test_tag_filter_and_secrets(self):
        self.add("a@mail.ru;p", tags=["x"])
        self.add("b@mail.ru;p", tags=["y"])
        got = self.hub.acquire(1, tag="y", secrets=True)
        self.assertEqual((got["items"][0]["email"], got["items"][0]["password"]), ("b@mail.ru", "p"))

    def test_lease_expiry_and_extend(self):
        self.add("a@mail.ru;p")
        self.hub.acquire(1, ttl=30)
        self.hub.db.execute("UPDATE mailboxes SET lease_until=? WHERE email='a@mail.ru'", (int(time.time()) - 5,))
        self.assertEqual(self.status("a@mail.ru"), "available")
        self.hub.acquire(1, ttl=30)
        self.hub.extend_lease("a@mail.ru", 600)
        self.assertGreater(self.hub.db.one("SELECT lease_until FROM mailboxes")["lease_until"], time.time() + 500)
        self.hub.set_status("a@mail.ru", "used")
        self.assertIsNone(self.hub.get_mailbox("a@mail.ru")["lease"])
        with self.assertRaises(ApiError):
            self.hub.extend_lease("a@mail.ru")

    def test_rename_conflicts_and_oauth_validation(self):
        self.add("a@mail.ru;p\nb@mail.ru;p")
        with self.assertRaises(ApiError) as ctx:
            self.hub.update_mailbox("a@mail.ru", {"email": "b@mail.ru"})
        self.assertEqual(ctx.exception.status, 409)
        with self.assertRaises(ApiError):
            self.hub.update_mailbox("a@mail.ru", {"refresh_token": "M.C5x"})
        box = self.hub.update_mailbox("a@mail.ru", {"email": "z@mail.ru", "note": "n", "tags": "A, b", "status": "burned"})
        self.assertEqual((box["email"], box["note"], box["tags"], box["status"]), ("z@mail.ru", "n", ["a", "b"], "burned"))

    def test_delete_and_stats(self):
        self.add("a@mail.ru;p\nb@mail.ru;p")
        self.assertEqual(self.hub.delete_mailboxes(["A@mail.ru", "ghost@mail.ru"]), 1)
        self.assertEqual(self.hub.stats()["total"], 1)

    def test_bulk_tags(self):
        self.add("a@mail.ru;p;", tags=["old"])
        self.assertEqual(self.hub.bulk_tags(["a@mail.ru"], add=["new"], remove=["old"]), 1)
        self.assertEqual(self.hub.get_mailbox("a@mail.ru")["tags"], ["new"])


class ExportTests(HubCase):
    def test_txt_roundtrip(self):
        self.add(f"{oauth_line('a@hotmail.com', 1)}\nb@yandex.ru;pw;imap.yandex.ru:993;box@yandex.ru")
        text, kind, name = self.hub.export("txt")
        self.assertTrue(name.endswith(".txt") and kind == "text/plain")
        other = Hub(Config(data_dir=Path(self.tmp.name) / "other").finalize(), provider=self.provider)
        r = other.import_text(text)
        self.assertEqual(r["counts"]["added"], 2)
        self.assertEqual(other.get_mailbox("a@hotmail.com", secrets=True)["line"], oauth_line("a@hotmail.com", 1))

    def test_csv_and_json_respect_secrets(self):
        self.add("a@mail.ru;topsecret")
        csv_text = self.hub.export("csv", secrets=False)[0]
        self.assertNotIn("topsecret", csv_text)
        self.assertIn("topsecret", self.hub.export("csv", secrets=True)[0])
        data = json.loads(self.hub.export("json", secrets=True)[0])
        self.assertEqual(data[0]["password"], "topsecret")
        self.assertNotIn("password", json.loads(self.hub.export("json", secrets=False)[0])[0])
        self.assertEqual(self.hub.export("txt", secrets=False)[0], "a@mail.ru\n")

    def test_filter_by_status(self):
        self.add("a@mail.ru;p\nb@mail.ru;p")
        self.hub.set_status("b@mail.ru", "used")
        self.assertEqual(self.hub.export("txt", False, status="used")[0], "b@mail.ru\n")

    def test_backup_prunes(self):
        self.add("a@mail.ru;p")
        self.hub.config.backup_keep = 1
        directory = self.hub.config.data_dir / "backups"
        directory.mkdir()
        (directory / "mailboxes-20200101.txt").write_text("old")
        path = self.hub.backup()
        self.assertEqual([p.name for p in directory.glob("mailboxes-*.txt")], [path.name])


class CheckTests(HubCase):
    def test_auth_failure_invalidates_then_recovers(self):
        self.add("a@mail.ru;p")
        self.provider.auth_fail.add("a@mail.ru")
        r = self.hub.check_mailbox("a@mail.ru")
        self.assertEqual((r["ok"], r["kind"], r["status"]), (False, "auth", "invalid"))
        self.assertFalse(self.hub.get_mailbox("a@mail.ru")["health"]["ok"])
        self.provider.auth_fail.clear()
        r = self.hub.check_mailbox("a@mail.ru")
        self.assertEqual((r["ok"], r["status"]), (True, "available"))

    def test_temporary_failure_keeps_status(self):
        self.add("a@mail.ru;p")
        self.provider.temp_fail.add("a@mail.ru")
        r = self.hub.check_mailbox("a@mail.ru")
        self.assertEqual((r["ok"], r["kind"], r["status"]), (False, "temp", "available"))

    def test_auto_invalidate_can_be_disabled(self):
        self.hub.update_settings({"auto_invalidate": False})
        self.add("a@mail.ru;p")
        self.provider.auth_fail.add("a@mail.ru")
        self.assertEqual(self.hub.check_mailbox("a@mail.ru")["status"], "available")

    def test_job_progress(self):
        self.add("a@mail.ru;p\nb@mail.ru;p")
        self.provider.auth_fail.add("b@mail.ru")
        job = self.hub.start_check_job()
        for _ in range(50):
            snap = self.hub.jobs.snapshot(job["id"])
            if snap["state"] == "done":
                break
            time.sleep(0.1)
        self.assertEqual((snap["total"], snap["ok"], snap["failed"]), (2, 1, 1))

    def test_rotated_token_is_persisted_only_when_unchanged(self):
        self.add(oauth_line("a@hotmail.com", 1))
        row = self.hub.db.one("SELECT id, refresh_token FROM mailboxes")
        self.hub._on_rotate(row["id"], "stale", "X")
        self.assertEqual(self.hub.get_mailbox("a@hotmail.com", secrets=True)["refresh_token"], row["refresh_token"])
        self.hub._on_rotate(row["id"], row["refresh_token"], "NEW")
        self.assertEqual(self.hub.get_mailbox("a@hotmail.com", secrets=True)["refresh_token"], "NEW")


class CodeTests(HubCase):
    def setUp(self):
        super().setUp()
        self.add("a@hotmail.com;p")

    def test_immediate_code_updates_mailbox(self):
        self.provider.deliver("a@hotmail.com", tiktok_message("654321"))
        hit = self.hub.wait_for_code("a@hotmail.com")
        self.assertEqual((hit["code"], hit["codes"]), ("654321", ["654321"]))
        box = self.hub.get_mailbox("a@hotmail.com")
        self.assertEqual(box["last_code"]["code"], "654321")

    def test_no_code_returns_none(self):
        self.assertIsNone(self.hub.wait_for_code("a@hotmail.com", wait=0))

    def test_waits_for_delayed_message(self):
        self.provider.deliver("a@hotmail.com", tiktok_message("111222"), after=1.2)
        started = time.monotonic()
        hit = self.hub.wait_for_code("a@hotmail.com", wait=8)
        self.assertEqual(hit["code"], "111222")
        self.assertTrue(1.0 < time.monotonic() - started < 6)

    def test_timeout(self):
        started = time.monotonic()
        self.assertIsNone(self.hub.wait_for_code("a@hotmail.com", wait=2))
        self.assertGreaterEqual(time.monotonic() - started, 1.9)

    def test_since_excludes_old_messages(self):
        self.provider.deliver("a@hotmail.com", tiktok_message("999000", age=3600))
        self.assertIsNone(self.hub.wait_for_code("a@hotmail.com"))
        self.assertEqual(self.hub.wait_for_code("a@hotmail.com", since=int(time.time()) - 7200)["code"], "999000")

    def test_lease_start_is_default_threshold(self):
        self.provider.deliver("a@hotmail.com", tiktok_message("222333", age=250))
        self.hub.acquire(1)
        self.hub.db.execute("UPDATE mailboxes SET leased_at=?", (int(time.time()) - 5,))
        self.assertIsNone(self.hub.wait_for_code("a@hotmail.com"))

    def test_fresh_skips_already_delivered(self):
        self.provider.deliver("a@hotmail.com", tiktok_message("333444"))
        self.assertEqual(self.hub.wait_for_code("a@hotmail.com", fresh=True)["code"], "333444")
        self.assertIsNone(self.hub.wait_for_code("a@hotmail.com", fresh=True))
        self.assertEqual(self.hub.wait_for_code("a@hotmail.com")["code"], "333444")

    def test_newest_message_wins(self):
        self.provider.deliver("a@hotmail.com", tiktok_message("100000", uid=1, age=120))
        self.provider.deliver("a@hotmail.com", tiktok_message("200000", uid=2, age=10))
        self.assertEqual(self.hub.wait_for_code("a@hotmail.com")["code"], "200000")

    def test_filters_and_markers(self):
        news = tiktok_message("555666", subject="Weekly offers")
        news.sender = "shop@example.com"
        news.body = "Save big, ref 555666"
        self.provider.deliver("a@hotmail.com", news)
        self.assertIsNone(self.hub.wait_for_code("a@hotmail.com"))
        self.assertEqual(self.hub.wait_for_code("a@hotmail.com", any_message=True)["code"], "555666")
        self.assertIsNone(self.hub.wait_for_code("a@hotmail.com", any_message=True, sender="tiktok"))
        self.assertEqual(self.hub.wait_for_code("a@hotmail.com", regex=r"ref (\d+)", any_message=True)["code"], "555666")
        with self.assertRaises(ApiError):
            self.hub.wait_for_code("a@hotmail.com", regex="(")

    def test_failures_map_to_errors(self):
        self.provider.temp_fail.add("a@hotmail.com")
        with self.assertRaises(ApiError) as ctx:
            self.hub.wait_for_code("a@hotmail.com")
        self.assertEqual(ctx.exception.status, 503)
        self.provider.temp_fail.clear()
        self.provider.auth_fail.add("a@hotmail.com")
        with self.assertRaises(ApiError) as ctx:
            self.hub.wait_for_code("a@hotmail.com")
        self.assertEqual((ctx.exception.status, self.status("a@hotmail.com")), (409, "invalid"))

    def test_unknown_mailbox(self):
        with self.assertRaises(ApiError) as ctx:
            self.hub.wait_for_code("ghost@hotmail.com")
        self.assertEqual(ctx.exception.status, 404)

    def test_messages_are_pruned_and_listed(self):
        self.hub.update_settings({"messages_keep": 5})
        for n in range(8):
            self.provider.deliver("a@hotmail.com", tiktok_message(f"10000{n}", uid=n + 1, age=100 - n))
        listed = self.hub.messages("a@hotmail.com", refresh=True)
        self.assertEqual(len(listed["items"]), 5)
        full = self.hub.get_message("a@hotmail.com", listed["items"][0]["id"])
        self.assertIn("verification code", full["body"])

    def test_settings_validation(self):
        with self.assertRaises(ApiError):
            self.hub.update_settings({"code_patterns": ["("]})
        with self.assertRaises(ApiError):
            self.hub.update_settings({"nope": 1})
        self.assertEqual(self.hub.update_settings({"lease_ttl": 5})["lease_ttl"], 30)

    def test_concurrent_waiters_both_get_the_code(self):
        self.provider.deliver("a@hotmail.com", tiktok_message("777888"), after=1.1)
        results = []
        threads = [threading.Thread(target=lambda: results.append(self.hub.wait_for_code("a@hotmail.com", wait=6)["code"]))
                   for _ in range(2)]
        [t.start() for t in threads]
        [t.join(10) for t in threads]
        self.assertEqual(results, ["777888", "777888"])


if __name__ == "__main__":
    unittest.main()
