"""Demo server with a fake mail provider and seeded data (for UI work and screenshots).

    python -m tests.dev_server [port]      # login: demo-password
"""
from __future__ import annotations

import sys
import tempfile
import time
from pathlib import Path

from hotmailhub import api  # noqa: F401
from hotmailhub.config import Config
from hotmailhub.hub import Hub
from hotmailhub.providers import FetchedMessage
from hotmailhub.web import HubServer

from .helpers import FakeProvider, tiktok_message

UUID = "123e4567-e89b-12d3-a456-4266141740{:02d}"


class DemoProvider(FakeProvider):
    """Mailboxes named live*@ receive a TikTok code 4 seconds after a session opens."""

    def open(self, acct):
        if acct.email.startswith("live"):
            self.deliver(acct.email, tiktok_message(f"{int(time.time()) % 900000 + 100000}", uid=int(time.time())), after=4)
        return super().open(acct)


def seed(hub: Hub, provider: DemoProvider) -> None:
    lines = []
    for n in range(1, 25):
        lines.append(f"demo{n:02d}@hotmail.com:pw{n}:M.C5{'x' * 40}{n}:{UUID.format(n)}")
    lines += [f"mail{n}@rambler.ru;secret{n}" for n in range(1, 7)]
    lines += ["inbox.team@gmail.com;apppass;imap.gmail.com:993", "support@ukr.net;pw", "dead.account@outlook.com:pw:M.C5dead:" + UUID.format(99)]
    lines += ["live.wait@hotmail.com:pw:M.C5live:" + UUID.format(98), "live.wait2@hotmail.com:pw:M.C5live2:" + UUID.format(97)]
    hub.import_text("\n".join(lines), tags=["batch-nov"])
    hub.import_text("old01@hotmail.com;pw\nold02@hotmail.com;pw\nold03@hotmail.com;pw", tags=["batch-oct"])
    for n in (1, 2, 3, 4, 5, 6, 7, 8):
        hub.set_status(f"demo{n:02d}@hotmail.com", "used", note=f"@user_{n}k registered")
    for n in (9, 10, 11):
        hub.set_status(f"demo{n:02d}@hotmail.com", "burned", note="TikTok: email limit")
    hub.set_status("support@ukr.net", "disabled", note="тримаю про запас")
    hub.acquire(4, owner="bas-worker-1", ttl=900)
    hub.update_mailbox("mail1@rambler.ru", {"tags": ["vip", "batch-nov"], "note": "основна скринька"})
    provider.auth_fail.add("dead.account@outlook.com")
    hub.check_mailbox("dead.account@outlook.com", "seed")
    for email in [m["email"] for m in hub.list_mailboxes(limit=200)["items"]][:30]:
        if email.startswith(("live", "dead")):
            continue
        if hub.get_mailbox(email)["status"] in ("available", "leased", "used"):
            hub.check_mailbox(email, "seed")
    for n, email in enumerate(("demo12@hotmail.com", "demo13@hotmail.com", "demo01@hotmail.com", "mail1@rambler.ru")):
        provider.deliver(email, tiktok_message(f"{482910 + n * 1111}", uid=1, age=60 * (n + 1)))
        provider.deliver(email, FetchedMessage("INBOX:1:2", "INBOX", "Microsoft account team <account-security-noreply@accountprotection.microsoft.com>",
                                               email, "Welcome to your new Outlook account", int(time.time()) - 86400,
                                               "Thanks for choosing Outlook. Get started: add a profile photo and customise your inbox."))
        hub.messages(email, refresh=True)
    hub.auth.create_key("Readonly dashboard", "readonly")
    hub.webhooks.create("https://example.com/hooks/hotmail", "demo-secret", ["code.received", "mailbox.status"])
    hub.auth.set_password("demo-password")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    tmp = tempfile.mkdtemp(prefix="hub-demo-")
    config = Config(data_dir=Path(tmp), host="127.0.0.1", port=port, public_url=f"http://127.0.0.1:{port}").finalize()
    provider = DemoProvider()
    hub = Hub(config, provider=provider)
    seed(hub, provider)
    hub.start_background()
    print(f"demo: http://127.0.0.1:{port}  password: demo-password  data: {tmp}", flush=True)
    HubServer(("127.0.0.1", port), hub).serve_forever()


if __name__ == "__main__":
    main()
