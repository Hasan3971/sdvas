# Hotmail Hub — довідник API (v1)

Базова адреса: `https://hotmail.vibecods.xyz` (локально `http://127.0.0.1:14010`, у режимі `python -m hotmailhub` — `http://127.0.0.1:8899`).
Усі відповіді — JSON (`application/json; charset=utf-8`), час — ISO-8601 UTC (`2026-11-04T13:05:03Z`).
Email у шляху можна писати як є або з `%40`.

## 1. Авторизація

| Спосіб | Як передати | Для кого |
|---|---|---|
| Сесія адміністратора | `POST /api/v1/auth/login {"password": "..."}` → cookie `hm_session` (HttpOnly, SameSite=Lax). У відповіді `csrf`; **усі не-GET запити з cookie мусять мати заголовок `X-CSRF-Token: <csrf>`**. | веб-панель |
| API-ключ | `Authorization: Bearer hm_…` або `X-API-Key: hm_…` або `?key=hm_…` | BAS, скрипти |
| Ключ у шляху | `https://host/k/hm_…/code?email=…` — для клієнтів, які вміють лише додати рядок до базового URL (`mail_bridge_url` у BAS) | BAS без правок скрипта |

Ключі створюються в панелі («API та BAS») або `python -m hotmailhub key create BAS --preset bas`. Показуються **один раз**; у базі лишається лише SHA-256.

Дозволи (scopes) ключа: `read` (читання), `code` (коди, оренда, зміна статусу, перевірка), `write` (додавання/редагування/видалення/імпорт), `secrets` (пароль і refresh_token у відповідях та експорті), `admin` (ключі, вебхуки, налаштування; має всі дозволи). Пресети: `bas` = read+code+write, `readonly` = read, `admin` = усе.

Помилка: `{"error": {"code": "not_found", "message": "…"}}` + HTTP-статус (400 некоректний запит, 401 немає/невірна авторизація, 403 немає дозволу/CSRF, 404, 409 конфлікт, 413, 429 з `Retry-After`, 503 пошта тимчасово недоступна). Після 10 невірних паролів / 30 невірних ключів з однієї адреси — 429 на 10 хвилин.

## 2. Об'єкт скриньки

```json
{
  "id": 1, "email": "demo01@hotmail.com", "type": "oauth2",          // oauth2 | imap
  "provider": "Outlook · OAuth2",
  "status": "available",      // available | leased | used | burned | invalid | disabled
  "imap_host": "", "imap_port": 0, "login": "",
  "note": "", "tags": ["batch-nov"], "has_password": true,
  "health": {"ok": true, "checked_at": "…", "error": "", "messages": 3},   // ok: true | false | null (не перевірялась)
  "last_code": {"code": "482910", "at": "…", "subject": "…"},              // або null
  "lease": {"owner": "bas-1", "since": "…", "until": "…"},                 // лише для status=leased, інакше null
  "uses": 2, "created_at": "…", "updated_at": "…"
}
```
З `secrets=1` (потрібен дозвіл `secrets`) додається `password`, `refresh_token`, `client_id`, `line` (рядок у форматі mails.txt).

Статуси: `available` — вільна; `leased` — видана BAS (оренда з TTL, після завершення повертається в `available`); `used` — реєстрація успішна; `burned` — TikTok відхилив адресу/ліміт; `invalid` — вхід у пошту не працює (ставиться автоматично при помилці авторизації, повертається в `available`, коли перевірка знову проходить); `disabled` — вимкнена вручну.

## 3. Скриньки

| Метод і шлях | Дозвіл | Опис |
|---|---|---|
| `GET /api/v1/mailboxes` | read | Список. Параметри: `q` (email/нотатка/тег), `status` (через кому), `type` (`oauth2`/`imap`), `tag`, `health` (`ok`/`error`/`unknown`), `sort` (`email,status,updated_at,created_at,last_code_at,checked_at,uses,id`), `order` (`asc`/`desc`), `limit` (1–1000, типово 50), `offset`, `secrets`. Відповідь: `{items, total, limit, offset}` |
| `POST /api/v1/mailboxes` | write | Одна скринька: `{"email","password","refresh_token","client_id","imap_host","imap_port","login","note","tags","status"}` або `{"line": "email:pass:token:client_id"}` → **201**. Якщо передано `lines`/`text`/масив — працює як імпорт |
| `GET /api/v1/mailboxes/{email}` | read | Одна скринька (`?secrets=1`) |
| `PATCH /api/v1/mailboxes/{email}` | write | Змінити поля (`email` — перейменування, `status`, `note`, `tags`, `password`, `refresh_token`+`client_id`, `imap_host`, `imap_port`, `login`). Зміна облікових даних скидає результат перевірки |
| `DELETE /api/v1/mailboxes/{email}` | write | Видалити |
| `POST /api/v1/mailboxes/bulk` | write | `{"action": "delete"\|"status"\|"tags"\|"check", "emails": [...] або "filter": {q,status,type,tag,health} або "all": true, "status": "burned", "add": ["x"], "remove": ["y"]}`. `check` повертає задачу (202) |
| `GET /api/v1/mailboxes/{email}/messages` | read | Збережені листи: `{email, fetched_at, items:[{id, folder, from, to, subject, received_at, codes, delivered, snippet}]}`. `?refresh=1` спершу тягне з пошти (INBOX + Junk), `limit` |
| `GET /api/v1/mailboxes/{email}/messages/{id}` | read | Лист повністю (`body` — простий текст) |
| `POST /api/v1/mailboxes/{email}/check` | code | Перевірити вхід зараз: `{email, ok, error, kind: ""\|"auth"\|"temp", messages, ms, status}` |
| `POST /api/v1/mailboxes/{email}/status` | code | `{"status": "used", "note": "…"}` |
| `POST /api/v1/mailboxes/{email}/extend` | code | Продовжити оренду: `{"ttl": 600}` |

## 4. Код підтвердження

`GET /api/v1/mailboxes/{email}/code` (або `GET /api/v1/code?email=…`) — дозвіл `code`.

| Параметр | Опис |
|---|---|
| `wait` (або `timeout`) | секунд очікування, 0–900 (0 — одна перевірка). Сервер тримає з'єднання й опитує пошту кожні 4 с |
| `since` | epoch (с/мс) або ISO-8601: враховувати листи не раніше цього часу (мінус 2 хв запасу). Типово: початок оренди, а без оренди — 5 хвилин тому |
| `fresh=1` | не повертати код із листа, який уже віддавали раніше |
| `sender`, `subject` | підрядки для фільтра відправника/теми |
| `any=1` | не вимагати слова-маркери (tiktok, verification, код…) у темі/відправнику |
| `regex` | власний регулярний вираз (перша група або весь збіг — код) |
| `format=text` | відповідь — лише код (`text/plain`), порожньо, якщо немає |

Відповідь: `{"found": true, "code": "482910", "codes": ["482910"], "email", "message_id", "from", "subject", "folder", "received_at"}` або `{"found": false, "code": "", "email", "waited": 30}` (HTTP 200 — «ще немає»). Помилки: 404 немає такої скриньки, 409 `auth_failed` (скринька стає `invalid`), 503 `mailbox_unavailable`.

**Сумісність зі старою панеллю (для BAS):** `GET /code?email=…&timeout=120` і `GET /api/code?…` завжди повертають HTTP 200 з `{"code": "123456", "email": "…"}`; порожній `code` + `error` означає «ще немає» (BAS повторює запит); 404 — скриньки немає.

## 5. Пул для BAS

| Запит | Дозвіл | Опис |
|---|---|---|
| `POST /api/v1/pool/acquire` | code | `{"count": 1, "ttl": 900, "owner": "bas-1", "tag": "", "secrets": false, "format": "json"\|"email"\|"line"}` → `{items:[mailbox], available, ttl}`. Бере найдавніше використані `available` зі здоровим входом і ставить `leased`. `format=email` — email'и текстом по рядку; `format=line` (потрібен `secrets`) — рядки mails.txt |
| `POST /api/v1/pool/release` | code | `{"email", "status": "used"\|"burned"\|"available"\|"invalid", "note"}` |
| `GET /bas/next?format=email\|line\|json&ttl=&tag=&owner=` | code | те саме для BAS: одна скринька **текстом** (порожня відповідь — вільних немає) |
| `GET /bas/code?email=…&timeout=120` | code | лише код текстом (порожньо — немає) |
| `GET /bas/done?email=…&status=used&note=…` | code | відповідь `ok` |

## 6. Імпорт і експорт

`POST /api/v1/import` (дозвіл write). Тіло — що завгодно з цього:
- `text/plain` — рядки як є;
- JSON: `{"text"|"lines": "…", "mode": "skip"|"update", "status": "available", "tags": ["x"], "note": "", "dry_run": false, "check": false}` або масив рядків/об'єктів;
- `application/x-www-form-urlencoded` з тими самими полями;
- `multipart/form-data` з файлом у полі `file` (UTF-8, UTF-8 BOM, UTF-16, cp1251) + поля вище;
- параметри також приймаються в query string.

Формати рядків (визначаються автоматично; CSV/JSON — за вмістом або розширенням `.csv`/`.json`):
```
email:password:refresh_token:client_id       # Hotmail/Outlook OAuth2 (також розділювач | ; Tab); у паролі можуть бути двокрапки
email;password                                # IMAP, хост за доменом
email;password;imap.host[:port][;login]       # свій IMAP / спільна скринька
#disabled email;password                      # вимкнена (сумісність зі старим mails.txt)
```
`mode=skip` (типово) пропускає наявні адреси, `update` оновлює дані, зберігаючи статус. `dry_run=1` — лише розбір і підрахунок. Відповідь:
```json
{"dry_run": false, "counts": {"added": 3, "updated": 0, "skipped": 1, "duplicate_in_file": 0, "invalid": 1},
 "results": [{"line": 4, "email": "x@y.com", "action": "added|updated|skipped|duplicate_in_file|invalid", "error": ""}],
 "emails": ["…"], "job": {…}}   // job — якщо check=1
```
Паролі й токени в `results` не повторюються.

`GET|POST /api/v1/export` (дозвіл read; для паролів — ще `secrets`): `format=txt|csv|json`, фільтри `status,q,type,tag,health`, `emails=a@x,b@y`, `secrets=0|1` (типово 1, якщо ключ має `secrets`), `inline=1` — без `Content-Disposition: attachment`. `txt` — готовий файл для BAS (`email:password:refresh_token:client_id`).

## 7. Перевірка входу

`POST /api/v1/check` (дозвіл code): `{"emails": [...]}` або фільтр (`status`, `q`, …); без параметрів — усі скриньки. Відповідь 202:
`{"id": "ab12…", "kind": "check", "state": "running"|"done", "total": 38, "done": 10, "ok": 9, "failed": 1, "results": [{email, ok, error, kind, messages, ms, status}], "started_at", "finished_at"}`.
Стан: `GET /api/v1/jobs/{id}` (read). Помилка авторизації переводить скриньку в `invalid` (якщо увімкнено в налаштуваннях); тимчасова мережева — статус не змінює.

## 8. Решта

| Запит | Дозвіл | Опис |
|---|---|---|
| `GET /api/v1/health` (також `/health`, `/api/health`) | — | `{"ok": true, "version": "2.0.0"}` |
| `GET /api/v1/me` | будь-яка авторизація | `{kind: "session"\|"key", name, scopes, csrf, version, public_url}` — 401, якщо не авторизовано |
| `POST /api/v1/auth/login`, `/auth/logout` | — | вхід/вихід |
| `POST /api/v1/auth/password` | admin | `{"current", "new"}` (≥ 8 символів); решта сесій скасовується |
| `GET /api/v1/stats` | read | `{total, by_status:{…}, types:{oauth2,imap}, health:{ok,error,unknown}, codes_24h, available}` |
| `GET /api/v1/events?limit=&before=&kind=` | read | журнал: `{items:[{id, at, kind, subject, detail, actor}]}`; `kind` — маска з `*` (`mailbox.*`) |
| `GET/POST /api/v1/keys`, `DELETE /api/v1/keys/{id}` | admin | ключі; відповідь на створення містить `key` (один раз). `GET` повертає також `scopes` і `presets` |
| `GET/POST /api/v1/webhooks`, `PATCH/DELETE /api/v1/webhooks/{id}`, `POST …/{id}/test` | admin | вебхуки (див. нижче) |
| `GET/PUT /api/v1/settings` | admin | `{settings, defaults}`; поля: `lease_ttl`, `poll_interval`, `default_wait`, `code_markers`, `code_patterns`, `auto_invalidate`, `watch_leased`, `watch_interval`, `messages_keep` |

### Вебхуки
`POST {url}` з JSON `{"event": "code.received", "at": "…", "data": {…}}`, заголовки `X-Hub-Event` і `X-Hub-Signature: sha256=<HMAC-SHA256(secret, тіло)>`; 3 спроби (0, 2, 8 с). Події: `code.received` (`email, code, subject, from, received_at, message_id`; сервер сам опитує пошту орендованих скриньок), `mailbox.status` (`email, from, to`), `mailbox.invalid` (`email, error`), `import.done` (лічильники), `ping`. Секрет показується один раз при створенні, якщо не заданий вручну.

## 9. Приклади

```bash
KEY=hm_xxx; H=https://hotmail.vibecods.xyz
curl -H "X-API-Key: $KEY" "$H/api/v1/stats"
curl -H "X-API-Key: $KEY" -X POST "$H/api/v1/pool/acquire" -H 'Content-Type: application/json' -d '{"count":1,"owner":"bas-1"}'
curl -H "X-API-Key: $KEY" "$H/api/v1/mailboxes/demo01@hotmail.com/code?wait=120&fresh=1"
curl -H "X-API-Key: $KEY" -F file=@mails.txt -F mode=skip -F check=1 "$H/api/v1/import"
curl -H "X-API-Key: $KEY" "$H/api/v1/export?format=txt&status=available&secrets=0" -o emails.txt
curl "$H/k/$KEY/code?email=demo01@hotmail.com&timeout=120"          # як mail_bridge_url у BAS
```
