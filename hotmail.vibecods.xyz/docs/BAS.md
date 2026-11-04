# Підключення BAS до Hotmail Hub

Три способи — від «нічого не міняти» до повного керування пулом.

## 1. Без змін у скрипті: `mail_bridge_url`

Скрипти `BASRegistrationTikTok*.xml` самі формують `mail_bridge_url + "/code?email=" + email + "&timeout=120"`
і чекають HTTP 200 із JSON, де є поле `code`. Хаб відповідає саме так. У ресурсі **mail_bridge_url** (замість `http://127.0.0.1:8899`) вкажіть:

```
https://hotmail.vibecods.xyz/k/hm_ВАШ_КЛЮЧ
```
(на тому самому ПК можна `http://127.0.0.1:14010/k/hm_ВАШ_КЛЮЧ`). Пара `mails_file` / `email` лишається як є.
Порожній `code` у відповіді означає «ще немає» — скрипт сам повторює запит.

## 2. Пул із хабу: взяти скриньку → код → позначити

Хаб віддає вільні скриньки в оренду (повертаються самі через TTL), тож файли mails.txt між запусками більше не потрібні.
Приклад у стилі скрипта (BAS):

```js
HUB = "https://hotmail.vibecods.xyz"
KEY = "hm_ВАШ_КЛЮЧ"
// 1) вільна скринька (порожня відповідь — пул закінчився)
http_client_get(HUB + "/bas/next?owner=bas-1&key=" + KEY)!
EMAIL = http_client_content().trim()
if(EMAIL.length == 0) fail("У пулі немає вільних скриньок")
// ... реєстрація: TikTok надсилає код на EMAIL ...
// 2) код (чекає до 120 с; fresh=1 — не віддавати вже використаний код)
http_client_get(HUB + "/bas/code?email=" + encodeURIComponent(EMAIL) + "&timeout=120&fresh=1&key=" + KEY)!
CODE = http_client_content().trim()
// 3) результат: used — успіх, burned — TikTok відхилив адресу, available — повернути в пул
http_client_get(HUB + "/bas/done?email=" + encodeURIComponent(EMAIL) + "&status=used&key=" + KEY)!
```
Пароль скриньки BAS не потрібен (код читає хаб), тому ключ `bas` не має дозволу `secrets`; `/bas/next?format=line` (рядок mails.txt) потребує ключа з цим дозволом.

Те саме JSON-API: `POST /api/v1/pool/acquire`, `GET /api/v1/mailboxes/{email}/code?wait=120`, `POST /api/v1/pool/release` — див. [API.md](API.md).

## 3. Керування пулом з BAS або скриптів

З ключем `bas` (дозволи read+code+write) можна додавати, редагувати, видаляти й імпортувати скриньки:

```bash
curl -H "X-API-Key: $KEY" -F file=@mails.txt -F mode=skip -F check=1 https://hotmail.vibecods.xyz/api/v1/import   # файл
curl -H "X-API-Key: $KEY" -d 'lines=a@hotmail.com:pw:M.C5…:uuid' https://hotmail.vibecods.xyz/api/v1/import       # form-urlencoded (BAS http_client_post)
curl -H "X-API-Key: $KEY" -X PATCH -H 'Content-Type: application/json' -d '{"status":"burned","note":"ліміт"}' https://hotmail.vibecods.xyz/api/v1/mailboxes/a@hotmail.com
curl -H "X-API-Key: $KEY" -X DELETE https://hotmail.vibecods.xyz/api/v1/mailboxes/a@hotmail.com
curl -H "X-API-Key: $KEY" "https://hotmail.vibecods.xyz/api/v1/export?format=txt&status=available&secrets=0" -o emails.txt
```

## Вебхуки (замість опитування)
У панелі «API та BAS» → «Вебхуки» вкажіть URL (наприклад, локальний HTTP-сервер BAS). Хаб надішле POST
`{"event":"code.received","data":{"email","code","subject","received_at"}}` одразу, як лист із кодом з'явиться в орендованій скриньці
(підпис — заголовок `X-Hub-Signature: sha256=…`).

## Діагностика
- `401` — немає/невірний ключ; `403` — у ключа немає потрібного дозволу; `429` — забагато невдалих спроб (чекайте `Retry-After`).
- `{"code":"","error":"…"}` на `/code` — коду ще немає; `409 auth_failed` у v1 — скринька не пускає (стала `invalid`), візьміть іншу.
- Перевірити вхід у всі скриньки: панель → «Перевірити всі» або `docker compose exec hub python -m hotmailhub check`.
