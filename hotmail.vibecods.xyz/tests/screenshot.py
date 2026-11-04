"""Log in to a running hub and screenshot hash routes with headless Chrome (Playwright).

    python tests/screenshot.py --routes "#/,#/mailboxes" --out /tmp/shots [--light] [--mobile]
Needs: pip install playwright   (uses the system Chrome, no browser download)
"""
from __future__ import annotations

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright

CHROME = "/usr/local/bin/google-chrome"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8899")
    ap.add_argument("--password", default="demo-password")
    ap.add_argument("--routes", default="#/")
    ap.add_argument("--out", default="/tmp/shots")
    ap.add_argument("--light", action="store_true")
    ap.add_argument("--mobile", action="store_true")
    ap.add_argument("--wait", type=int, default=700, help="ms to wait after navigation")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    size = {"width": 390, "height": 844} if args.mobile else {"width": 1440, "height": 900}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        context = browser.new_context(viewport=size, color_scheme="light" if args.light else "dark")
        page = context.new_page()
        errors: list[str] = []
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.goto(args.url)
        page.wait_for_timeout(400)
        if page.locator("input[type=password]").count():
            page.fill("input[type=password]", args.password)
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)
        for route in args.routes.split(","):
            page.goto(args.url + "/" + route.strip())
            page.wait_for_timeout(args.wait)
            name = route.strip().strip("#/").replace("/", "_") or "home"
            page.screenshot(path=str(out / f"{name}{'-m' if args.mobile else ''}{'-light' if args.light else ''}.png"))
            print("saved", name)
        for line in errors:
            print(line)
        browser.close()


if __name__ == "__main__":
    main()
