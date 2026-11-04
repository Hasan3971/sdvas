"""Command line: python -m hotmailhub serve | passwd | key | import | export | check | stats"""
from __future__ import annotations

import argparse
import getpass
import json
import logging
import secrets
import sqlite3
import sys
from pathlib import Path

from . import __version__, api  # noqa: F401  (api registers the routes)
from .config import Config
from .hub import Hub
from .parsing import decode_bytes
from .util import mask_email
from .web import HubServer

RUNTIME_STATES = {"available": "available", "leased": "available", "cooldown": "available", "used": "used",
                  "burned": "burned", "invalid": "invalid", "failed": "invalid"}


def build_config(args) -> Config:
    config = Config.from_env()
    for name in ("host", "port"):
        if getattr(args, name, None) not in (None, ""):
            setattr(config, name, getattr(args, name))
    if getattr(args, "data_dir", None):
        config.data_dir = Path(args.data_dir)
        config.db_path = None
    return config.finalize()


def bootstrap(hub: Hub, config: Config) -> list[str]:
    """Create the admin password and the first BAS key on a fresh database."""
    lines: list[str] = []
    base = config.public_url or f"http://127.0.0.1:{config.port}"
    fresh = hub.db.one("SELECT 1 FROM settings WHERE key='bootstrap_done'") is None
    if config.admin_password:
        if not hub.auth.check_password(config.admin_password):
            hub.auth.set_password(config.admin_password)
    elif not hub.auth.has_password():
        password = secrets.token_urlsafe(14)
        hub.auth.set_password(password)
        lines.append(f"Пароль адміністратора: {password}")
    if fresh:
        _row, key = hub.auth.create_key("BAS", "bas")
        lines += [f"API-ключ для BAS:       {key}", "",
                  "У BAS-ресурсі mail_bridge_url вкажіть (скрипт далі додає /code?email=… сам):",
                  f"  {base}/k/{key}"]
        hub.db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('bootstrap_done','1')")
    if lines:
        path = config.data_dir / "FIRST_RUN.txt"
        path.write_text("Hotmail Hub — дані першого запуску. Збережіть і видаліть цей файл.\n\n" + "\n".join(lines) + "\n",
                        encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
    return lines


def cmd_serve(args) -> int:
    config = build_config(args)
    hub = Hub(config)
    created = bootstrap(hub, config)
    hub.start_background()
    server = HubServer((config.host, config.port), hub)
    print(f"Hotmail Hub {__version__}: http://{config.host}:{config.port}  (дані: {config.data_dir})", flush=True)
    if created:
        print(f"Перший запуск: пароль адміна та ключ BAS збережено у {config.data_dir / 'FIRST_RUN.txt'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nзупинено")
    finally:
        hub.stop()
        server.server_close()
    return 0


def cmd_passwd(args) -> int:
    hub = Hub(build_config(args))
    password = args.password or getpass.getpass("Новий пароль адміністратора: ")
    hub.auth.set_password(password)
    print("Пароль змінено; усі активні сесії скасовано.")
    return 0


def cmd_key(args) -> int:
    hub = Hub(build_config(args))
    if args.action == "create":
        row, plain = hub.auth.create_key(args.name or "key", args.preset)
        print(f"id={row['id']} name={row['name']} scopes={','.join(row['scopes'])}\n{plain}")
    elif args.action == "revoke":
        print("відкликано" if hub.auth.revoke_key(int(args.name)) else "ключ не знайдено")
    else:
        for row in hub.auth.list_keys():
            print(f"{row['id']:>3}  {row['name']:<20} {row['prefix']}…  {','.join(row['scopes'])}  last={row['last_used_at']}")
    return 0


def _runtime_states(hub: Hub, path: str) -> int:
    db = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    changed = 0
    for email, state in db.execute("SELECT email, state FROM mail_accounts"):
        target = RUNTIME_STATES.get(state, "available")
        row = hub.db.one("SELECT status FROM mailboxes WHERE email=?", (email.lower(),))
        if row and target != "available" and row["status"] != target:
            hub.set_status(email, target, actor="migration")
            changed += 1
    return changed


def cmd_import(args) -> int:
    hub = Hub(build_config(args))
    text = decode_bytes(Path(args.file).read_bytes())
    result = hub.import_text(text, args.file, mode=args.mode, status=args.status, tags=args.tags.split(",") if args.tags else [],
                             dry_run=args.dry_run, actor="cli")
    print(json.dumps(result["counts"], ensure_ascii=False))
    for item in result["results"]:
        if item["action"] == "invalid":
            print(f"  рядок {item['line']}: {item['error']} ({item['email']})")
    if args.runtime_db and not args.dry_run:
        print(f"статуси з runtime.db: змінено {_runtime_states(hub, args.runtime_db)}")
    if args.check and not args.dry_run:
        return _check(hub, result["emails"])
    return 0


def _check(hub: Hub, emails: list[str]) -> int:
    bad = 0
    for email in emails or hub.emails_matching():
        result = hub.check_mailbox(email, "cli")
        bad += not result["ok"]
        detail = f"листів у INBOX: {result['messages']}" if result["ok"] else result["error"]
        print(f"  {'OK  ' if result['ok'] else 'FAIL'} {mask_email(email):<28} {result['ms']:>5} мс  {detail}")
    return 1 if bad else 0


def cmd_check(args) -> int:
    hub = Hub(build_config(args))
    emails = hub.emails_matching(status=args.status or "")
    return _check(hub, emails)


def cmd_export(args) -> int:
    hub = Hub(build_config(args))
    body, _kind, _name = hub.export(args.format, not args.no_secrets, status=args.status or "")
    Path(args.file).write_text(body, encoding="utf-8")
    print(f"записано {len(body.splitlines())} рядків у {args.file}")
    return 0


def cmd_stats(args) -> int:
    print(json.dumps(Hub(build_config(args)).stats(), ensure_ascii=False, indent=2))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="hotmailhub", description="Hotmail Hub: пул скриньок і API кодів для BAS")
    parser.add_argument("--data-dir", help="каталог даних (за замовчуванням HUB_DATA_DIR або ./data)")
    sub = parser.add_subparsers(dest="command")
    serve = sub.add_parser("serve", help="запустити сервер (за замовчуванням)")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    passwd = sub.add_parser("passwd", help="змінити пароль адміністратора")
    passwd.add_argument("--password")
    key = sub.add_parser("key", help="API-ключі")
    key.add_argument("action", choices=["create", "list", "revoke"])
    key.add_argument("name", nargs="?", help="назва ключа (create) або id (revoke)")
    key.add_argument("--preset", default="bas", help="bas | readonly | admin або список дозволів")
    imp = sub.add_parser("import", help="імпорт з файлу txt/csv/json")
    imp.add_argument("file")
    imp.add_argument("--mode", choices=["skip", "update"], default="skip")
    imp.add_argument("--status", default="")
    imp.add_argument("--tags", default="")
    imp.add_argument("--dry-run", action="store_true")
    imp.add_argument("--check", action="store_true", help="одразу перевірити вхід у додані скриньки")
    imp.add_argument("--runtime-db", help="старий runtime.db: перенести статуси used/burned/invalid")
    exp = sub.add_parser("export", help="експорт у файл")
    exp.add_argument("file")
    exp.add_argument("--format", choices=["txt", "csv", "json"], default="txt")
    exp.add_argument("--status", default="")
    exp.add_argument("--no-secrets", action="store_true")
    chk = sub.add_parser("check", help="перевірити вхід у скриньки")
    chk.add_argument("--status", default="")
    sub.add_parser("stats", help="статистика пулу")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stdout)
    handlers = {"serve": cmd_serve, "passwd": cmd_passwd, "key": cmd_key, "import": cmd_import, "export": cmd_export,
                "check": cmd_check, "stats": cmd_stats, None: cmd_serve}
    if args.command is None:
        args.host = args.port = None
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
