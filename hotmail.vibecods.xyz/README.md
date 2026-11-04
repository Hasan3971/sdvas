# Hotmail Hub — hotmail.vibecods.xyz

Сервіс для пулу пошти під реєстрації: зберігає скриньки (Hotmail/Outlook через OAuth2 та будь-який IMAP),
видає їх BAS в оренду, читає листи (INBOX + Junk) і віддає код підтвердження через API. Є веб-панель:
додавання, редагування, видалення, імпорт (текст / файл txt, csv, json), експорт, перевірка входу, перегляд листів,
ключі API, вебхуки, журнал.

Без залежностей: лише Python 3.12+ (стандартна бібліотека) і SQLite. Docker — для продакшну.

## Швидкий старт

**Docker (як на сервері)**
```bash
cp .env.example .env            # за потреби змінити
docker compose up -d --build    # слухає 127.0.0.1:14010
type data\FIRST_RUN.txt         # пароль адміна + перший ключ BAS (потім файл видалити)
```
Домен: блок із `deploy/Caddyfile.snippet` додається в `reverse-proxy/Caddyfile`, далі
`docker exec server-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`.

**Без Docker (Windows)**: `start.bat` або `python -m hotmailhub serve --port 8899` → http://127.0.0.1:8899.

Оновлення на сервері: `powershell -File deploy\update.ps1` (git pull → копіювання → `docker compose up -d --build`).

## Підключення BAS

Старий скрипт BAS викликає `mail_bridge_url + "/code?email=…&timeout=120"` — хаб підтримує цей контракт без змін.
Достатньо в ресурсі **mail_bridge_url** вказати адресу з ключем у шляху:

```
https://hotmail.vibecods.xyz/k/hm_ВАШ_КЛЮЧ          (або http://127.0.0.1:14010/k/hm_ВАШ_КЛЮЧ на тому ж ПК)
```
Ключ створюється в панелі («API та BAS») або `docker compose exec hub python -m hotmailhub key create BAS --preset bas`.
Докладніше (оренда скриньок із пулу, текстові ендпоінти для BAS, вебхуки) — [docs/BAS.md](docs/BAS.md); усі запити — [docs/API.md](docs/API.md).

## Формати скриньок

```
email:пароль:refresh_token:client_id        Hotmail/Outlook OAuth2 (розділювач також | або ;)
email;пароль                                IMAP, хост за доменом (gmail, yahoo, rambler, mail.ru, ukr.net …)
email;пароль;imap.host[:port][;login]       власний IMAP / спільна скринька
#disabled email;пароль                      вимкнена (сумісність зі старим mails.txt)
```
Імпорт приймає txt/csv/json у UTF-8, UTF-8 BOM, UTF-16 та cp1251. Експорт у `txt` дає файл у тому ж форматі — його можна віддати старим інструментам.

> **Важливо про Hotmail:** Microsoft видає новий `refresh_token` при кожному оновленні токена. Хаб зберігає ротовані токени в базі, тому
> актуальні дані завжди тут (експорт / `data/backups/mailboxes-РРРРММДД.txt`), а старі копії mails.txt поступово застарівають.

## Як це працює

- **Статуси**: `available` → (оренда BAS) `leased` → `used` / `burned`; `invalid` ставиться автоматично, якщо вхід у пошту перестав працювати
  (повертається в `available`, коли перевірка знову проходить); `disabled` — вимкнена вручну. Оренда має TTL і повертається сама.
- **Код**: `GET …/code?wait=120` тримає запит і опитує пошту кожні 4 с (одне IMAP-з'єднання на очікування); враховуються листи після початку оренди,
  кілька кодів → найновіший; `fresh=1` не віддає один код двічі. Слова-маркери, регулярні вирази й інтервали — у «Налаштуваннях».
- **Вебхуки**: `code.received`, `mailbox.status`, `mailbox.invalid`, `import.done` з підписом HMAC-SHA256; орендовані скриньки сервер опитує сам.
- **Резервні копії**: щодня `data/backups/mailboxes-РРРРММДД.txt` (7 останніх; містить паролі — зберігати як секрет).

## Безпека

- Панель і API закриті: пароль адміна (PBKDF2) + підписана cookie з CSRF-токеном; для скриптів — API-ключі з дозволами `read/code/write/secrets/admin`
  (у базі лише SHA-256, показуються один раз). Помилки входу обмежуються по IP.
- Паролі й refresh-токени скриньок лежать у SQLite у відкритому вигляді (сервісу потрібні для входу в пошту): база — у Docker-томі, `data/` не комітиться.
- Ключ у шляху (`/k/<ключ>/…`) зручний для BAS, але потрапляє в логи прокси; для власних скриптів краще заголовок `X-API-Key`.
- Не публікуйте `data/`, `.env`, `mails*.txt`: усе це в `.gitignore`.

## CLI

```
python -m hotmailhub serve [--host --port]      сервер
python -m hotmailhub passwd [--password …]      змінити пароль адміна (скасовує сесії)
python -m hotmailhub key create|list|revoke     API-ключі (--preset bas|readonly|admin)
python -m hotmailhub import FILE [--mode update] [--status used] [--tags a,b] [--dry-run] [--check] [--runtime-db старий.db]
python -m hotmailhub export FILE [--format csv] [--status available] [--no-secrets]
python -m hotmailhub check [--status available] перевірити вхід (в консолі email маскується)
python -m hotmailhub stats
```
Змінні середовища (`HUB_*`) — у `.env.example`. У контейнері: `docker compose exec hub python -m hotmailhub …`.

## Міграція зі старого mailhub.py

`python -m hotmailhub import mails.txt --runtime-db runtime.db --check` — переносить скриньки та статуси used/burned/invalid зі старого `runtime.db`.
Старі ендпоінти `/code`, `/api/code`, `/health` лишилися, тож BAS-скрипти не треба міняти.

## Розробка

```bash
python -m unittest discover -s tests -t .        # 77 тестів, без мережі
python -m tests.dev_server 8899                   # демо-дані й підробна пошта, пароль demo-password
```
Структура: `hotmailhub/` — `providers.py` (IMAP/XOAUTH2), `hub.py` (пул, оренда, код, імпорт/експорт), `api.py` + `web.py` (HTTP на stdlib),
`auth.py`, `webhooks.py`, `jobs.py`, `static/` (панель на чистому JS без збірки).
