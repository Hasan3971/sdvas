// API та BAS (#/api): BAS connection guide with copy-ready snippets, API keys, webhooks and an endpoint cheat sheet.
import {
  h, icon, mount, openModal, confirmDialog, toast, field, uid, withBusy, skel, emptyState, errorBanner, banner,
  timeEl, copy, copyButton, switchEl, tabsEl, checkboxEl, reducedMotion,
} from '../ui.js';
import { api, isAbort } from '../api.js';
import { methodBadge, scopeChip, SCOPE_INFO } from '../components.js';

const CSS_HREF = '/css/api-bas.css';
const KEY_MARK = '\uE000'; // where the API key goes inside snippet templates
const KEY_PLACEHOLDER = '<KEY>';
const POLL_MS = 30000;

const SCOPES = ['read', 'code', 'write', 'secrets', 'admin'];
const PRESETS = { bas: ['read', 'code', 'write'], readonly: ['read'], admin: SCOPES };
const PRESET_OPTIONS = [
  { value: 'bas', title: 'BAS', text: 'Читання, коди й запис. Для BAS-скриптів: ключ не бачить паролів скриньок.' },
  { value: 'readonly', title: 'Лише читання', text: 'Перегляд скриньок, листів, статистики й журналу — без жодних змін.' },
  { value: 'admin', title: 'Адмін', text: 'Усі дозволи: паролі скриньок, ключі, вебхуки й налаштування.' },
  { value: 'custom', title: 'Власний', text: 'Самостійно оберіть потрібні дозволи нижче.' },
];
const PRESET_TITLES = { bas: 'BAS', readonly: 'Лише читання', admin: 'Адмін' };

const EVENTS = ['code.received', 'mailbox.status', 'mailbox.invalid', 'import.done', 'ping'];
const EVENT_INFO = {
  'code.received': 'Надійшов код підтвердження (email, code, subject, from)',
  'mailbox.status': 'Змінився статус скриньки (email, from, to)',
  'mailbox.invalid': 'Вхід у скриньку перестав працювати (email, error)',
  'import.done': 'Імпорт завершено (лічильники)',
  ping: 'Тестовий запит — кнопка «Тест»',
};

// [method, path, scope (null = any authenticated), description]
const ENDPOINTS = [
  { group: 'Скриньки', rows: [
    ['GET', '/api/v1/mailboxes', 'read', 'Список: пошук, фільтри, сортування, сторінки (?secrets=1 — з паролями)'],
    ['POST', '/api/v1/mailboxes', 'write', 'Додати скриньку або імпортувати рядки'],
    ['GET', '/api/v1/mailboxes/{email}', 'read', 'Одна скринька'],
    ['PATCH', '/api/v1/mailboxes/{email}', 'write', 'Змінити поля, статус, нотатку, теги'],
    ['DELETE', '/api/v1/mailboxes/{email}', 'write', 'Видалити скриньку'],
    ['POST', '/api/v1/mailboxes/bulk', 'write', 'Масово: видалити, змінити статус чи теги, перевірити'],
    ['POST', '/api/v1/mailboxes/{email}/check', 'code', 'Перевірити вхід у скриньку зараз'],
  ] },
  { group: 'Коди підтвердження', rows: [
    ['GET', '/api/v1/mailboxes/{email}/code', 'code', 'Код із пошти: wait, fresh, since, sender, subject, regex, format=text'],
    ['GET', '/api/v1/code?email=…', 'code', 'Те саме, але email у параметрі'],
  ] },
  { group: 'Пул для BAS', rows: [
    ['POST', '/api/v1/pool/acquire', 'code', 'Взяти вільні скриньки в оренду (count, ttl, owner, tag)'],
    ['POST', '/api/v1/pool/release', 'code', 'Повернути й позначити: used, burned, available, invalid'],
    ['GET', '/bas/next', 'code', 'Одна скринька текстом (порожньо — вільних немає)'],
    ['GET', '/bas/code?email=…&timeout=120', 'code', 'Лише код текстом (порожньо — ще немає)'],
    ['GET', '/bas/done?email=…&status=used', 'code', 'Позначити результат, відповідь ok'],
    ['GET', '/code?email=…&timeout=120', 'code', 'Сумісність зі старим mail_bridge_url: JSON із полем code'],
  ] },
  { group: 'Імпорт, експорт, перевірка', rows: [
    ['POST', '/api/v1/import', 'write', 'Імпорт: текст, JSON, форма чи файл (mode, dry_run, check)'],
    ['GET', '/api/v1/export', 'read', 'Експорт TXT, CSV або JSON; паролі — з дозволом secrets'],
    ['POST', '/api/v1/check', 'code', 'Перевірити вхід у вибрані або всі скриньки (повертає задачу)'],
    ['GET', '/api/v1/jobs/{id}', 'read', 'Стан і результати задачі перевірки'],
  ] },
  { group: 'Журнал і статистика', rows: [
    ['GET', '/api/v1/events', 'read', 'Журнал подій (limit, before, kind=mailbox.*)'],
    ['GET', '/api/v1/stats', 'read', 'Зведення пулу: статуси, типи, стан входу, коди за 24 год'],
    ['GET', '/api/v1/me', null, 'Хто авторизований і які дозволи має ключ'],
  ] },
];

// ---------------------------------------------------------------- small helpers

let stylesReady = null;

/** Loads this page's stylesheet once; resolves when it is usable so the page never flashes unstyled. */
function ensureStyles() {
  if (stylesReady) return stylesReady;
  stylesReady = new Promise((resolve) => {
    let link = document.head.querySelector(`link[href="${CSS_HREF}"]`);
    if (link && link.sheet) {
      resolve();
      return;
    }
    if (!link) {
      link = h('link', { rel: 'stylesheet', href: CSS_HREF });
      document.head.appendChild(link);
    }
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
  });
  return stylesReady;
}

const ic = (text) => h('code', { class: 'ab-ic' }, text);
const para = (...children) => h('p', { class: 'ab-text' }, ...children);

function card({ title, sub = '', action = null, body, cls = '', count = null }) {
  const titleId = uid('ab-title');
  return h('section', { class: `card ${cls}`, 'aria-labelledby': titleId },
    h('header', { class: 'card-head' },
      h('div', { class: 'card-titles' },
        h('h2', { class: 'card-title', id: titleId }, title, count),
        sub ? h('p', { class: 'card-sub' }, sub) : null),
      action),
    body);
}

/** Keeps only characters a key can contain; a pasted URL or line is reduced to the hm_… part. */
function sanitizeKey(raw) {
  const text = String(raw || '').trim();
  const found = /hm_[A-Za-z0-9_-]{6,}/.exec(text);
  return (found ? found[0] : text.replace(/[^A-Za-z0-9_-]/g, '')).slice(0, 100);
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

function presetLabel(scopes, presets) {
  for (const [name, list] of Object.entries(presets || PRESETS)) {
    if (sameSet(list, scopes)) return PRESET_TITLES[name] || name;
  }
  return 'Власний набір';
}

function skeletonList(rows) {
  return h('div', { class: 'ab-skel-list', 'aria-hidden': 'true' },
    Array.from({ length: rows }, () => h('div', { class: 'ab-skel-row' },
      skel('skel-line w-70'), skel('skel-line w-50'), skel('skel-pill'), skel('skel-line w-40'), skel('skel-line w-30'))));
}

/** Re-renders a container but gives focus back to the same control (matched by data-fk). */
function renderKeepingFocus(container, render) {
  const active = document.activeElement;
  const fk = active && container.contains(active) ? active.getAttribute('data-fk') : null;
  render();
  if (!fk) return;
  const next = [...container.querySelectorAll('[data-fk]')].find((el) => el.getAttribute('data-fk') === fk);
  if (next) next.focus({ preventScroll: true });
}

const th = (label, cls) => h('th', { class: cls, scope: 'col', role: 'columnheader' }, label);
const td = (cls, label, ...children) => h('td', { class: cls, role: 'cell', 'data-label': label || null }, ...children);

function tableOf(cls, headRow, rows) {
  return h('div', { class: 'ab-tablewrap' },
    h('table', { class: `ab-table ${cls}`, role: 'table' },
      h('thead', { role: 'rowgroup' }, headRow),
      h('tbody', { role: 'rowgroup' }, rows)));
}

function secretBox(value, label) {
  const input = h('input', {
    type: 'text', class: 'input mono ab-secret-input', readOnly: true, value, spellcheck: 'false', autocomplete: 'off',
    'aria-label': label, onFocus: (e) => e.target.select(),
  });
  const el = h('div', { class: 'ab-secret' }, input, copyButton(value, { label: `Копіювати: ${label}`, what: label, text: 'Копіювати' }));
  return { el, input };
}

/** A footer button that copies `value` and briefly confirms it. */
function copyAction(m, value, label, what) {
  const text = h('span', null, label);
  const btn = h('button', {
    type: 'button', class: 'btn btn-primary',
    onClick: async () => {
      if (!(await copy(value, what))) return;
      mount(btn, icon('check', { size: 16 }), h('span', null, 'Скопійовано'));
      m.scope.timeout(() => mount(btn, icon('copy', { size: 16 }), h('span', null, label)), 1800);
    },
  }, icon('copy', { size: 16 }), text);
  return btn;
}

// ---------------------------------------------------------------- snippets

const STR = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/;
const CALL = /\b[A-Za-z_]\w*(?=\()/;
const LANGS = {
  js: [['c', /\/\/[^\n]*/], ['s', STR], ['k', /\b(?:if|else|true|false|null)\b/], ['f', CALL], ['n', /\b\d+\b/]],
  py: [['c', /#[^\n]*/], ['s', new RegExp(`[fFbBrR]{0,2}(?:${STR.source})`)],
    ['k', /\b(?:import|from|def|return|if|else|raise|with|as|in|not|True|False|None)\b/], ['f', CALL], ['n', /\b\d+(?:\.\d+)?\b/]],
  sh: [['c', /#[^\n]*/], ['s', STR], ['v', /\$\w+/], ['k', /\bcurl\b/], ['o', /\s--?[A-Za-z][\w-]*/]],
  json: [['k', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/], ['s', STR], ['n', /-?\b\d+(?:\.\d+)?\b/], ['k', /\b(?:true|false|null)\b/]],
};
const tokenizers = {};

function tokenizer(lang) {
  const rules = LANGS[lang];
  if (!rules) return null;
  if (!tokenizers[lang]) tokenizers[lang] = { rules, re: new RegExp(rules.map(([, re]) => `(${re.source})`).join('|'), 'g') };
  return tokenizers[lang];
}

/** Colours a snippet and marks where the key sits. Pure DOM building, no markup parsing. */
function highlight(code, lang, keyText, live) {
  const out = [];
  const push = (text, cls) => {
    text.split(KEY_MARK).forEach((part, i) => {
      if (i) out.push(h('span', { class: live ? 'ab-key ab-key-live' : 'ab-key key-ph' }, keyText));
      if (part) out.push(cls ? h('span', { class: `ab-t-${cls}` }, part) : part);
    });
  };
  const tk = tokenizer(lang);
  if (!tk) {
    push(code, '');
    return out;
  }
  let last = 0;
  for (const m of code.matchAll(tk.re)) {
    if (m.index > last) push(code.slice(last, m.index), '');
    push(m[0], tk.rules[m.findIndex((g, i) => i > 0 && g !== undefined) - 1][0]);
    last = m.index + m[0].length;
  }
  if (last < code.length) push(code.slice(last), '');
  return out;
}

function createSnippet(ctx, { title, lang, code }) {
  const codeEl = h('code');
  const keyText = () => ctx.key || KEY_PLACEHOLDER;
  const render = () => mount(codeEl, highlight(code, lang, keyText(), Boolean(ctx.key)));
  render();
  ctx.snippets.push({ render });
  return h('div', { class: 'ab-snippet', role: 'group', 'aria-label': title },
    h('div', { class: 'ab-snippet-head' },
      h('span', { class: 'ab-snippet-title' }, title),
      copyButton(() => code.split(KEY_MARK).join(keyText()), { label: `Копіювати: ${title}`, what: title, text: 'Копіювати' })),
    h('pre', { class: 'ab-pre', tabindex: '0' }, codeEl));
}

function templates(origin) {
  const K = KEY_MARK;
  return {
    bridge: `${origin}/k/${K}`,
    bridgeCall: `${origin}/k/${K}/code?email=demo01@hotmail.com&timeout=120`,
    bas: [
      `HUB = "${origin}"`,
      `KEY = "${K}"`,
      '// 1) вільна скринька (порожня відповідь — пул закінчився)',
      'http_client_get(HUB + "/bas/next?owner=bas-1&key=" + KEY)!',
      'EMAIL = http_client_content().trim()',
      'if(EMAIL.length == 0) fail("У пулі немає вільних скриньок")',
      '// ... реєстрація: TikTok надсилає код на EMAIL ...',
      '// 2) код (чекає до 120 с; fresh=1 — не віддавати вже використаний код)',
      'http_client_get(HUB + "/bas/code?email=" + encodeURIComponent(EMAIL) + "&timeout=120&fresh=1&key=" + KEY)!',
      'CODE = http_client_content().trim()',
      '// 3) результат: used — успіх, burned — TikTok відхилив адресу, available — повернути в пул',
      'http_client_get(HUB + "/bas/done?email=" + encodeURIComponent(EMAIL) + "&status=used&key=" + KEY)!',
    ].join('\n'),
    curl: [
      `KEY="${K}"`,
      `H="${origin}"`,
      '',
      '# 1) взяти вільну скриньку в оренду',
      'curl -X POST "$H/api/v1/pool/acquire" -H "X-API-Key: $KEY" \\',
      '  -H "Content-Type: application/json" -d \'{"count":1,"owner":"bas-1"}\'',
      '',
      '# 2) дочекатися коду (сервер тримає запит до 120 с)',
      'curl -H "X-API-Key: $KEY" "$H/api/v1/mailboxes/demo01@hotmail.com/code?wait=120&fresh=1"',
      '',
      '# 3) позначити результат: used / burned / available / invalid',
      'curl -X POST "$H/api/v1/pool/release" -H "X-API-Key: $KEY" \\',
      '  -H "Content-Type: application/json" -d \'{"email":"demo01@hotmail.com","status":"used"}\'',
      '',
      '# імпорт mails.txt і експорт для BAS',
      'curl -H "X-API-Key: $KEY" -F file=@mails.txt -F mode=skip -F check=1 "$H/api/v1/import"',
      'curl -H "X-API-Key: $KEY" "$H/api/v1/export?format=txt&status=available&secrets=0" -o emails.txt',
    ].join('\n'),
    python: [
      'import json',
      'import urllib.parse',
      'import urllib.request',
      '',
      `HUB = "${origin}"`,
      `KEY = "${K}"`,
      '',
      '',
      'def call(method, path, body=None):',
      '    request = urllib.request.Request(',
      '        HUB + path,',
      '        data=json.dumps(body).encode() if body is not None else None,',
      '        headers={"X-API-Key": KEY, "Content-Type": "application/json"},',
      '        method=method,',
      '    )',
      '    with urllib.request.urlopen(request, timeout=150) as response:',
      '        return json.loads(response.read())',
      '',
      '',
      '# 1) взяти вільну скриньку в оренду',
      'items = call("POST", "/api/v1/pool/acquire", {"count": 1, "owner": "bas-1"})["items"]',
      'if not items:',
      '    raise SystemExit("У пулі немає вільних скриньок")',
      'email = items[0]["email"]',
      '',
      '# 2) дочекатися коду: сервер тримає запит до 120 с',
      'query = urllib.parse.urlencode({"wait": 120, "fresh": 1})',
      'result = call("GET", f"/api/v1/mailboxes/{urllib.parse.quote(email)}/code?{query}")',
      'print(result["code"] if result["found"] else "код не надійшов")',
      '',
      '# 3) повернути скриньку: used — успіх, available — спробувати ще раз',
      'call("POST", "/api/v1/pool/release", {"email": email, "status": "used" if result["found"] else "available"})',
    ].join('\n'),
    payload: [
      '{',
      '  "event": "code.received",',
      '  "at": "2026-11-04T13:05:03Z",',
      '  "data": {',
      '    "email": "demo01@hotmail.com",',
      '    "code": "482910",',
      '    "subject": "Verification code",',
      '    "from": "TikTok <no-reply@account.tiktok.com>",',
      '    "received_at": "2026-11-04T13:05:01Z",',
      '    "message_id": 41',
      '  }',
      '}',
    ].join('\n'),
    verify: [
      'import hashlib',
      'import hmac',
      'import json',
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      '',
      '# секрет, який хаб показав під час створення вебхука',
      'SECRET = b"your-webhook-secret"',
      '',
      '',
      'class Hook(BaseHTTPRequestHandler):',
      '    def do_POST(self):',
      '        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))',
      '        digest = hmac.new(SECRET, body, hashlib.sha256).hexdigest()',
      '        signature = self.headers.get("X-Hub-Signature", "")',
      '        if not hmac.compare_digest(f"sha256={digest}".encode(), signature.encode()):',
      '            self.send_response(401)',
      '            self.end_headers()',
      '            return',
      '        event = json.loads(body)',
      '        if event["event"] == "code.received":',
      '            print(event["data"]["email"], event["data"]["code"])',
      '        self.send_response(204)',
      '        self.end_headers()',
      '',
      '',
      'HTTPServer(("0.0.0.0", 9000), Hook).serve_forever()',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------- guide

function createGuide(ctx, { onCreateKey }) {
  const { origin } = ctx;
  const code = templates(origin);
  const snip = (title, lang, text) => createSnippet(ctx, { title, lang, code: text });

  const inputId = uid('ab-key');
  const hintId = `${inputId}-hint`;
  const keyInput = h('input', {
    type: 'text', class: 'input mono', id: inputId, placeholder: 'hm_… — вставте ключ або створіть новий', autocomplete: 'off',
    spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': hintId, 'data-lpignore': 'true', 'data-1p-ignore': '',
  });
  const hint = h('div', { class: 'field-hint', id: hintId });
  const copyKey = copyButton(() => ctx.key, { label: 'Копіювати ключ', what: 'Ключ', text: 'Копіювати' });
  const forget = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => ctx.setKey('') },
    icon('x', { size: 14 }), 'Забути');
  const keybar = h('div', { class: 'ab-keybar' },
    h('label', { class: 'ab-keybar-label', for: inputId }, icon('key', { size: 15 }), 'Ключ для прикладів', h('span', { class: 'field-opt' }, 'необов’язково')),
    h('div', { class: 'ab-keybar-row' }, keyInput, copyKey, forget),
    hint);
  keyInput.addEventListener('input', () => {
    const clean = sanitizeKey(keyInput.value);
    if (clean !== keyInput.value) keyInput.value = clean;
    ctx.setKey(clean);
  });

  function syncKey() {
    if (keyInput.value !== ctx.key) keyInput.value = ctx.key;
    copyKey.disabled = !ctx.key;
    forget.disabled = !ctx.key;
    keybar.classList.toggle('has-key', Boolean(ctx.key));
    hint.textContent = ctx.key
      ? `${ctx.keyName ? `У приклади підставлено ключ «${ctx.keyName}», який ви щойно створили.` : 'У приклади підставлено введений ключ.'} Він лише в пам’яті цієї сторінки й зникне після оновлення.`
      : 'Вставте ключ — і він підставиться в усі приклади нижче. Ніде не зберігається.';
    ctx.snippets.forEach((s) => s.render());
  }
  ctx.onKey(syncKey);

  const step = (n, title, text, extra) => h('li', { class: 'ab-step' },
    h('span', { class: 'ab-step-num', 'aria-hidden': 'true' }, String(n)),
    h('div', { class: 'ab-step-main' }, h('div', { class: 'ab-step-title' }, title), h('div', { class: 'ab-step-text' }, text), extra));
  const steps = h('ol', { class: 'ab-steps' },
    step(1, 'Створіть API-ключ', 'Пресет «BAS» (read + code + write) не бачить паролів скриньок. Ключ показується лише один раз.',
      h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: onCreateKey }, icon('plus', { size: 15, stroke: 2.2 }), 'Створити ключ')),
    step(2, 'Підключіть BAS', 'Вставте адресу з першої вкладки в ресурс mail_bridge_url — скрипт лишається без змін. Або беріть скриньки з пулу (друга вкладка).'),
    step(3, 'Запустіть і стежте', 'Коли BAS попросить код, хаб сам прочитає лист у скриньці. Видачі кодів і зміни статусів видно в журналі.',
      h('a', { class: 'link-btn', href: '#/activity' }, 'Відкрити журнал →')));

  const defs = [
    { id: 'ab-url', label: 'mail_bridge_url для BAS', nodes: [
      para('Скрипти BAS самі дописують ', ic('/code?email=…&timeout=120'), ' до адреси ', ic('mail_bridge_url'),
        ' і чекають JSON із полем ', ic('code'), '. Хаб відповідає саме так, тож скрипт міняти не треба: у ресурсі ',
        ic('mail_bridge_url'), ' замість старої адреси вкажіть адресу хаба з ключем.'),
      snip('mail_bridge_url', 'text', code.bridge),
      para('Далі BAS сам викликає хаб так (email підставляє скрипт). Порожній ', ic('code'), ' у відповіді означає «ще немає» — скрипт повторить запит.'),
      snip('Запит, який зробить BAS', 'text', code.bridgeCall),
      banner('warning', h('div', null,
        h('div', { class: 'banner-title' }, 'Ключ — частина адреси'),
        h('div', { class: 'banner-msg' }, 'Хто знає адресу, має всі дозволи ключа, а сама адреса потрапляє в логи проксі. Не публікуйте її й не показуйте на скриншотах. Для цього ресурсу достатньо ключа з пресетом «BAS»; якщо адреса витекла — відкличте ключ нижче й створіть новий.'))),
    ] },
    { id: 'ab-bas', label: 'BAS: взяти скриньку → код → позначити', nodes: [
      para('Хаб віддає вільні скриньки в оренду (за замовчуванням на 15 хв — потім вони самі повертаються в пул), тож файли ',
        ic('mails.txt'), ' між запусками не потрібні. Скрипт бере скриньку, чекає код і позначає результат:'),
      snip('Скрипт BAS: скринька → код → результат', 'js', code.bas),
      para('Статуси для ', ic('/bas/done'), ': ', ic('used'), ' — реєстрація успішна, ', ic('burned'), ' — TikTok відхилив адресу, ',
        ic('available'), ' — повернути в пул, ', ic('invalid'), ' — вхід у пошту не працює. Потрібен ключ із дозволом ', scopeChip('code'), ' (пресет «BAS»).'),
      h('p', { class: 'ab-text is-muted' }, 'Ключ у шляху чи параметрі потрапляє в логи проксі. Для власних скриптів надійніше заголовок ',
        ic('X-API-Key'), ' — див. вкладки «curl» і «Python».'),
    ] },
    { id: 'ab-curl', label: 'curl', nodes: [
      para('Ключ передається заголовком ', ic('X-API-Key'), ' (також працюють ', ic('Authorization: Bearer …'), ' і ', ic('?key=…'),
        '). Заголовок надійніший за ключ в адресі: адреси потрапляють у логи.'),
      snip('curl', 'sh', code.curl),
    ] },
    { id: 'ab-py', label: 'Python (urllib)', nodes: [
      para('Приклад лише на стандартній бібліотеці — нічого встановлювати не треба. Сервер тримає запит коду до 120 с, тож таймаут сокета має бути більшим.'),
      snip('Python (urllib)', 'py', code.python),
    ] },
    { id: 'ab-hook', label: 'Вебхук', nodes: [
      para('Замість опитування хаб сам надсилає ', ic('POST'), ' на вашу адресу, щойно в орендованій скриньці з’являється код. Додайте вебхук у розділі нижче; ',
        'у заголовках приходять ', ic('X-Hub-Event'), ' (назва події) і ', ic('X-Hub-Signature: sha256=<HMAC-SHA256(секрет, тіло)>'),
        '. Відповідайте HTTP 2xx — інакше хаб повторить спробу (3 спроби: одразу, через 2 і 8 с).'),
      snip('Тіло запиту (code.received)', 'json', code.payload),
      para('Підпис рахується від сирого тіла запиту. Приклад приймача з перевіркою:'),
      snip('Перевірка підпису (Python)', 'py', code.verify),
    ] },
  ];

  const tabs = tabsEl({ tabs: defs.map(({ id, label }) => ({ id, label })), value: defs[0].id, label: 'Приклади підключення', onChange: show });
  const panels = defs.map((d, i) => h('div', {
    class: 'ab-panel', role: 'tabpanel', id: `panel-${d.id}`, 'aria-labelledby': `tab-${d.id}`, hidden: i !== 0,
  }, d.nodes));
  function show(id) {
    panels.forEach((p) => { p.hidden = p.id !== `panel-${id}`; });
  }

  syncKey();
  const body = h('div', { class: 'ab-guide-body' },
    h('p', { class: 'ab-lead' }, 'Хаб віддає BAS скриньки й коди підтвердження. Приклади нижче вже містять адресу цього хаба — ', ic(origin), '.'),
    steps, keybar, h('div', null, tabs.el, panels));
  return { el: card({ title: 'Як підключити BAS', sub: 'Три кроки й готові приклади для копіювання', body, cls: 'ab-guide' }) };
}

// ---------------------------------------------------------------- keys

function createKeys(ctx) {
  const { scope } = ctx;
  let data = null;
  let lastSig = '';
  const body = h('div', { class: 'ab-body', 'aria-busy': 'true' }, skeletonList(3));
  const count = h('span', { class: 'card-count', hidden: true });
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: () => openCreate() },
    icon('plus', { size: 15, stroke: 2.2 }), 'Створити ключ');
  const el = card({ title: 'API-ключі', count, sub: 'Доступ для BAS, скриптів та інтеграцій', action: addBtn, body, cls: 'ab-keys-card' });

  async function load({ silent = false } = {}) {
    try {
      const res = await api.get('/api/v1/keys', null, { signal: scope.signal });
      if (scope.disposed) return;
      const next = JSON.stringify([res.items, res.presets]);
      if (data && next === lastSig) return;
      data = res;
      lastSig = next;
      renderKeepingFocus(body, renderList);
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      if (!data) {
        body.removeAttribute('aria-busy');
        mount(body, errorBanner({
          title: 'Не вдалося завантажити ключі', message: err.message,
          onRetry: () => { mount(body, skeletonList(3)); load(); },
        }));
      } else if (!silent) toast.error(err.message, { title: 'Не вдалося оновити ключі' });
    }
  }

  function renderList() {
    body.removeAttribute('aria-busy');
    const items = data.items.slice().reverse();
    count.textContent = String(items.length);
    count.hidden = !items.length;
    if (!items.length) {
      mount(body, emptyState({
        iconName: 'key', title: 'Ключів ще немає',
        text: 'Створіть ключ із пресетом «BAS» — він потрібен, щоб BAS і скрипти могли брати скриньки та коди.',
        actions: [h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openCreate() }, icon('plus', { size: 16, stroke: 2.2 }), 'Створити ключ')],
      }));
      return;
    }
    const head = h('tr', { role: 'row' },
      th('Назва', 'ab-c-name'), th('Ключ', 'ab-c-prefix'), th('Дозволи', 'ab-c-scopes'), th('Створено', 'ab-c-created'),
      th('Востаннє використано', 'ab-c-used'), h('th', { class: 'ab-c-actions', scope: 'col', role: 'columnheader' }, h('span', { class: 'sr-only' }, 'Дії')));
    mount(body, tableOf('ab-keys', head, items.map(row)));
  }

  function row(k) {
    const revokeBtn = h('button', {
      type: 'button', class: 'btn btn-sm btn-danger-ghost', 'aria-label': `Відкликати ключ «${k.name}»`, 'data-fk': `revoke:${k.id}`,
      onClick: () => revoke(k, revokeBtn),
    }, icon('ban', { size: 14 }), 'Відкликати');
    return h('tr', { role: 'row', 'data-id': String(k.id) },
      td('ab-c-name', '', h('div', { class: 'ab-name' }, k.name, ctx.newKeyId === k.id ? h('span', { class: 'badge tone-green' }, 'новий') : null),
        h('div', { class: 'ab-sub' }, presetLabel(k.scopes, data.presets))),
      td('ab-c-prefix', '', h('code', { class: 'ab-prefix', title: 'Початок ключа; повний ключ показується лише під час створення' }, `${k.prefix}…`)),
      td('ab-c-scopes', '', h('div', { class: 'ab-chips' }, k.scopes.map(scopeChip))),
      td('ab-c-created', 'Створено', timeEl(k.created_at, { cls: 'ab-when' })),
      td('ab-c-used', 'Використано', timeEl(k.last_used_at, { cls: 'ab-when', empty: 'ніколи' })),
      td('ab-c-actions', '', revokeBtn));
  }

  async function revoke(k, btn) {
    const ok = await confirmDialog({
      title: `Відкликати ключ «${k.name}»?`,
      message: 'Усі скрипти й ресурси BAS, що використовують цей ключ, одразу втратять доступ. Цю дію не можна скасувати.',
      confirmText: 'Відкликати', danger: true,
      details: h('div', { class: 'ab-confirm-meta' }, h('code', { class: 'ab-prefix' }, `${k.prefix}…`), h('div', { class: 'ab-chips' }, k.scopes.map(scopeChip))),
    });
    if (!ok || scope.disposed) return;
    await withBusy(btn, async () => {
      try {
        await api.del(`/api/v1/keys/${k.id}`);
        toast.success(`Ключ «${k.name}» відкликано`);
        if (ctx.keyId === k.id) ctx.setKey('');
      } catch (err) {
        toast.error(err.message, { title: 'Не вдалося відкликати ключ' });
      }
      await load({ silent: true });
    });
  }

  function openCreate() {
    const presets = (data && data.presets) || PRESETS;
    const scopeList = (data && data.scopes) || SCOPES;
    const m = openModal({
      title: 'Новий API-ключ', subtitle: 'Ключ показується один раз — на сервері зберігається лише його SHA-256-хеш.',
      size: 'md', className: 'ab-modal',
    });
    scope.add(() => m.close());
    const formId = uid('ab-key-form');

    const nameInput = h('input', {
      type: 'text', class: 'input', name: 'name', maxlength: '60', autocomplete: 'off', spellcheck: 'false', 'aria-required': 'true',
      placeholder: 'Наприклад: BAS-1 або Скрипт імпорту',
    });
    const nameField = field({ label: 'Назва', control: nameInput, hint: 'Допомагає відрізнити ключі в списку та в журналі.' });

    let preset = 'bas';
    const options = PRESET_OPTIONS.map((o) => {
      const input = h('input', { type: 'radio', class: 'radio', name: 'preset', value: o.value, checked: o.value === preset });
      const label = h('label', { class: ['ab-opt', o.value === preset && 'is-selected'] }, input,
        h('span', { class: 'ab-opt-body' }, h('span', { class: 'ab-opt-title' }, o.title), h('span', { class: 'ab-opt-text' }, o.text)));
      input.addEventListener('change', () => choose(o.value));
      return { o, input, label };
    });
    const presetSet = h('fieldset', { class: 'ab-fieldset' },
      h('legend', { class: 'ab-legend' }, 'Набір дозволів'), h('div', { class: 'ab-opts' }, options.map((x) => x.label)));

    const boxes = scopeList.map((s) => ({
      s,
      cb: checkboxEl({
        label: h('code', { class: 'ab-code-name' }, s), hint: (SCOPE_INFO[s] && SCOPE_INFO[s].text) || '', name: 'scope', value: s,
        onChange: () => { scopesError.hidden = true; warn(); },
      }),
    }));
    const scopesError = h('div', { class: 'field-error', role: 'alert', hidden: true });
    const scopeSet = h('fieldset', { class: 'ab-fieldset' },
      h('legend', { class: 'ab-legend' }, 'Що дозволено ключу'),
      h('div', { class: 'ab-checks' }, boxes.map((b) => b.cb.el)), scopesError);
    const warnSlot = h('div');

    function warn() {
      const picked = boxes.filter((b) => b.cb.input.checked).map((b) => b.s);
      const text = picked.includes('admin')
        ? 'Дозвіл admin відкриває повний доступ: паролі скриньок, ключі, вебхуки й налаштування. Давайте його лише довіреним скриптам.'
        : picked.includes('secrets') ? 'Дозвіл secrets відкриває паролі й refresh_token скриньок у відповідях API та експорті.' : '';
      mount(warnSlot, text ? banner('warning', text) : null);
    }

    function choose(value) {
      preset = value;
      const custom = value === 'custom';
      options.forEach((x) => {
        x.input.checked = x.o.value === value;
        x.label.classList.toggle('is-selected', x.o.value === value);
      });
      if (!custom) {
        const set = presets[value] || [];
        boxes.forEach((b) => { b.cb.input.checked = set.includes(b.s); });
      }
      boxes.forEach((b) => {
        b.cb.input.disabled = !custom;
        b.cb.el.classList.toggle('is-locked', !custom);
      });
      scopesError.hidden = true;
      warn();
    }
    choose(preset);

    const formError = h('div', { class: 'ab-form-error' });
    const form = h('form', { id: formId, class: 'ab-form', novalidate: true }, nameField.el, presetSet, scopeSet, warnSlot, formError);
    form.style.display = 'contents';
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', form: formId }, icon('key', { size: 16 }), 'Створити ключ');
    m.setBody(form);
    m.setFooter(h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Скасувати'), submit);
    nameInput.addEventListener('input', () => nameField.setError(''));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      mount(formError);
      const name = nameInput.value.trim();
      const picked = boxes.filter((b) => b.cb.input.checked).map((b) => b.s);
      nameField.setError(name ? '' : 'Вкажіть назву ключа.');
      scopesError.textContent = picked.length ? '' : 'Оберіть принаймні один дозвіл.';
      scopesError.hidden = Boolean(picked.length);
      if (!name) {
        nameInput.focus();
        return;
      }
      if (!picked.length) return;
      withBusy(submit, async () => {
        try {
          const created = await api.post('/api/v1/keys', { name, scopes: picked });
          ctx.newKeyId = created.id;
          ctx.setKey(created.key, { name: created.name, id: created.id });
          load({ silent: true });
          if (!scope.disposed) showCreated(created);
        } catch (err) {
          mount(formError, banner('error', h('div', null,
            h('div', { class: 'banner-title' }, 'Не вдалося створити ключ'), h('div', { class: 'banner-msg' }, err.message))));
        }
      });
    });

    function showCreated(created) {
      const box = secretBox(created.key, 'API-ключ');
      m.setTitle('Ключ створено');
      m.setSubtitle(`«${created.name}» · ${presetLabel(created.scopes, presets)}`);
      m.setBody(
        banner('warning', h('div', null,
          h('div', { class: 'banner-title' }, 'Скопіюйте ключ зараз'),
          h('div', { class: 'banner-msg' }, 'Після закриття цього вікна ключ не можна буде переглянути: на сервері лишається лише його хеш. Загубили — відкличте ключ і створіть новий.'))),
        box.el,
        h('div', { class: 'ab-created-meta' }, 'Дозволи:', h('div', { class: 'ab-chips' }, created.scopes.map(scopeChip))),
        h('p', { class: 'field-hint' }, 'Ключ уже підставлено у приклади на цій сторінці. Він лишається лише в пам’яті, доки ви не оновите сторінку чи не натиснете «Забути».'));
      m.setFooter(
        h('button', { type: 'button', class: 'btn', onClick: () => m.close(true) }, 'Готово'),
        copyAction(m, created.key, 'Скопіювати ключ', 'Ключ'));
      requestAnimationFrame(() => { if (m.isOpen) box.input.focus(); });
    }

    m.closed.then((created) => {
      if (created === true && !scope.disposed && ctx.key) {
        toast.success('Тепер приклади на сторінці містять ваш ключ.', {
          title: 'Ключ підставлено', timeout: 6000,
          action: { label: 'Показати', onClick: () => ctx.showGuide() },
        });
      }
    });
    return m;
  }

  return { el, load, openCreate };
}

// ---------------------------------------------------------------- webhooks

const DELIVERY_ERROR = /^error:\s*/;

function describeDelivery(status) {
  if (/^\d{3}$/.test(status)) return `Сервер відповів HTTP ${status}.`;
  return `Не вдалося доставити запит (${status.replace(DELIVERY_ERROR, '') || 'помилка'}). Перевірте адресу й чи доступний сервер ззовні.`;
}

function createHooks(ctx) {
  const { scope } = ctx;
  let data = null;
  let lastSig = '';
  let pending = 0;
  const body = h('div', { class: 'ab-body', 'aria-busy': 'true' }, skeletonList(2));
  const count = h('span', { class: 'card-count', hidden: true });
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: () => openCreate() },
    icon('plus', { size: 15, stroke: 2.2 }), 'Додати вебхук');
  const el = card({
    title: 'Вебхуки', count, sub: 'Хаб сам надсилає POST, коли з’являється код або змінюється статус', action: addBtn, body, cls: 'ab-hooks-card',
  });

  async function load({ silent = false } = {}) {
    if (pending) return;
    try {
      const res = await api.get('/api/v1/webhooks', null, { signal: scope.signal });
      if (scope.disposed || pending) return;
      const next = JSON.stringify([res.items, res.events]);
      if (data && next === lastSig) return;
      data = res;
      lastSig = next;
      renderKeepingFocus(body, renderList);
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      if (!data) {
        body.removeAttribute('aria-busy');
        mount(body, errorBanner({
          title: 'Не вдалося завантажити вебхуки', message: err.message,
          onRetry: () => { mount(body, skeletonList(2)); load(); },
        }));
      } else if (!silent) toast.error(err.message, { title: 'Не вдалося оновити вебхуки' });
    }
  }

  function renderList() {
    body.removeAttribute('aria-busy');
    const items = data.items.slice().reverse();
    count.textContent = String(items.length);
    count.hidden = !items.length;
    if (!items.length) {
      mount(body, emptyState({
        iconName: 'webhook', title: 'Вебхуків ще немає',
        text: 'Додайте адресу — хаб надсилатиме на неї POST із підписом, щойно в орендованій скриньці з’явиться код.',
        actions: [h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openCreate() }, icon('plus', { size: 16, stroke: 2.2 }), 'Додати вебхук')],
      }));
      return;
    }
    const head = h('tr', { role: 'row' },
      th('URL', 'ab-c-url'), th('Події', 'ab-c-events'), th('Активний', 'ab-c-active'), th('Остання доставка', 'ab-c-status'),
      h('th', { class: 'ab-c-actions', scope: 'col', role: 'columnheader' }, h('span', { class: 'sr-only' }, 'Дії')));
    mount(body, tableOf('ab-hooks', head, items.map(row)));
  }

  function deliveryCell(hook) {
    const s = hook.last_status || '';
    if (!s) return h('span', { class: 'muted' }, 'ще не надсилався');
    const http = /^\d{3}$/.test(s);
    const tone = http && s.startsWith('2') ? 'st-available' : http && s.startsWith('3') ? 'st-leased' : 'st-invalid';
    return h('div', { class: 'ab-status' },
      h('span', { class: `pill ${tone}`, title: s }, h('span', { class: 'dot' }), http ? `HTTP ${s}` : 'помилка'),
      timeEl(hook.last_at, { cls: 'ab-when' }));
  }

  function row(hook) {
    const sw = switchEl({ checked: hook.active, onChange: (checked) => toggle(hook, checked, sw.input) });
    sw.input.setAttribute('aria-label', `Активний: ${hook.url}`);
    sw.input.setAttribute('data-fk', `switch:${hook.id}`);
    const testBtn = h('button', {
      type: 'button', class: 'btn btn-sm', 'aria-label': `Надіслати тестовий запит на ${hook.url}`, 'data-fk': `test:${hook.id}`,
      onClick: () => test(hook, testBtn),
    }, icon('send', { size: 14 }), 'Тест');
    const delBtn = h('button', {
      type: 'button', class: 'btn btn-sm btn-danger-ghost', 'aria-label': `Видалити вебхук ${hook.url}`, 'data-fk': `delete:${hook.id}`,
      onClick: () => remove(hook, delBtn),
    }, icon('trash', { size: 14 }), 'Видалити');
    const all = hook.events.includes('*');
    return h('tr', { role: 'row', 'data-id': String(hook.id) },
      td('ab-c-url', '', h('div', { class: 'ab-url-cell' },
        h('code', { class: 'ab-url mono', title: hook.url }, hook.url),
        hook.has_secret
          ? h('span', { class: 'ab-lock', role: 'img', title: 'Запити підписуються секретом (X-Hub-Signature)', 'aria-label': 'Запити підписуються секретом' }, icon('lock', { size: 13 }))
          : h('span', { class: 'muted' }, 'без підпису'))),
      td('ab-c-events', '', h('div', { class: 'tags' }, all
        ? h('span', { class: 'tag ab-ev-all' }, 'усі події')
        : hook.events.map((name) => h('span', { class: 'tag ab-ev', title: EVENT_INFO[name] || '' }, name)))),
      td('ab-c-active', 'Активний', sw.el),
      td('ab-c-status', 'Остання доставка', deliveryCell(hook)),
      td('ab-c-actions', '', h('div', { class: 'ab-actions' }, testBtn, delBtn)));
  }

  async function toggle(hook, active, input) {
    const hadFocus = document.activeElement === input;
    input.disabled = true;
    pending += 1;
    try {
      Object.assign(hook, await api.patch(`/api/v1/webhooks/${hook.id}`, { active }));
      lastSig = JSON.stringify([data.items, data.events]);
      toast.success(active ? 'Вебхук увімкнено' : 'Вебхук вимкнено', { timeout: 2200 });
    } catch (err) {
      input.checked = !active;
      toast.error(err.message, { title: 'Не вдалося змінити вебхук' });
    } finally {
      pending -= 1;
      input.disabled = false;
      if (hadFocus) input.focus({ preventScroll: true });
    }
  }

  async function test(hook, btn) {
    pending += 1;
    await withBusy(btn, async () => {
      try {
        const res = await api.post(`/api/v1/webhooks/${hook.id}/test`, {});
        if (res.ok) toast.success(describeDelivery(res.status), { title: 'Тест пройшов' });
        else toast.error(describeDelivery(res.status), { title: 'Тест не пройшов' });
      } catch (err) {
        toast.error(err.message, { title: 'Не вдалося виконати тест' });
      }
    });
    pending -= 1;
    await load({ silent: true });
  }

  async function remove(hook, btn) {
    const ok = await confirmDialog({
      title: 'Видалити вебхук?',
      message: 'Хаб перестане надсилати на цю адресу події. Цю дію не можна скасувати.',
      confirmText: 'Видалити', danger: true,
      details: h('div', { class: 'ab-confirm-meta' }, h('code', { class: 'ab-ic' }, hook.url)),
    });
    if (!ok || scope.disposed) return;
    pending += 1;
    await withBusy(btn, async () => {
      try {
        await api.del(`/api/v1/webhooks/${hook.id}`);
        toast.success('Вебхук видалено');
      } catch (err) {
        toast.error(err.message, { title: 'Не вдалося видалити вебхук' });
      }
    });
    pending -= 1;
    await load({ silent: true });
  }

  function openCreate() {
    const events = (data && data.events) || EVENTS;
    const m = openModal({
      title: 'Новий вебхук', subtitle: 'Хаб надсилатиме на цю адресу POST із JSON і підписом HMAC-SHA256.', size: 'md', className: 'ab-modal',
    });
    scope.add(() => m.close());
    const formId = uid('ab-hook-form');

    const urlInput = h('input', {
      type: 'text', class: 'input mono', name: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
      'aria-required': 'true', placeholder: 'https://example.com/hooks/hotmail',
    });
    const urlField = field({
      label: 'URL', control: urlInput,
      hint: 'Має починатися з http:// або https://. Відповідайте кодом 2xx — інакше хаб повторить спробу (3 спроби: одразу, через 2 і 8 с).',
    });

    const allBox = checkboxEl({
      label: 'Усі події', hint: 'У тому числі ті, що з’являться пізніше',
      onChange: (checked) => syncEvents(checked),
    });
    const boxes = events.map((name) => ({
      name,
      cb: checkboxEl({
        label: h('code', { class: 'ab-code-name' }, name), hint: EVENT_INFO[name] || '', value: name, checked: name === 'code.received',
        onChange: () => { eventsError.hidden = true; },
      }),
    }));
    const eventsError = h('div', { class: 'field-error', role: 'alert', hidden: true });
    function syncEvents(all) {
      boxes.forEach((b) => {
        if (all) b.cb.input.checked = true;
        b.cb.input.disabled = all;
        b.cb.el.classList.toggle('is-locked', all);
      });
      eventsError.hidden = true;
    }
    const eventSet = h('fieldset', { class: 'ab-fieldset' },
      h('legend', { class: 'ab-legend' }, 'Події'),
      h('div', { class: 'ab-checks' }, allBox.el, h('div', { class: 'ab-checks-sep' }), boxes.map((b) => b.cb.el)), eventsError);

    const secretInput = h('input', {
      type: 'text', class: 'input mono', name: 'secret', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
      placeholder: 'Згенерувати автоматично', 'data-lpignore': 'true', 'data-1p-ignore': '',
    });
    const secretField = field({
      label: 'Секрет', optional: true, control: secretInput,
      hint: 'Підписує тіло запиту: X-Hub-Signature = sha256=HMAC-SHA256(секрет, тіло). Якщо залишити порожнім, хаб створить секрет і покаже його один раз.',
    });

    const formError = h('div', { class: 'ab-form-error' });
    const form = h('form', { id: formId, class: 'ab-form', novalidate: true }, urlField.el, eventSet, secretField.el, formError);
    form.style.display = 'contents';
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', form: formId }, icon('webhook', { size: 16 }), 'Додати вебхук');
    m.setBody(form);
    m.setFooter(h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Скасувати'), submit);
    urlInput.addEventListener('input', () => urlField.setError(''));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      mount(formError);
      const url = urlInput.value.trim();
      const picked = allBox.input.checked ? ['*'] : boxes.filter((b) => b.cb.input.checked).map((b) => b.name);
      urlField.setError(/^https?:\/\/\S+$/i.test(url) ? '' : 'Вкажіть адресу, що починається з http:// або https://.');
      eventsError.textContent = picked.length ? '' : 'Оберіть принаймні одну подію.';
      eventsError.hidden = Boolean(picked.length);
      if (!/^https?:\/\/\S+$/i.test(url)) {
        urlInput.focus();
        return;
      }
      if (!picked.length) return;
      const payload = { url, events: picked };
      if (secretInput.value.trim()) payload.secret = secretInput.value.trim();
      withBusy(submit, async () => {
        try {
          const created = await api.post('/api/v1/webhooks', payload);
          load({ silent: true });
          if (created.secret) showSecret(created);
          else {
            m.close();
            toast.success('Вебхук додано', { title: 'Готово' });
          }
        } catch (err) {
          mount(formError, banner('error', h('div', null,
            h('div', { class: 'banner-title' }, 'Не вдалося додати вебхук'), h('div', { class: 'banner-msg' }, err.message))));
        }
      });
    });

    function showSecret(created) {
      const box = secretBox(created.secret, 'Секрет вебхука');
      m.setTitle('Вебхук додано');
      m.setSubtitle(created.url);
      m.setBody(
        banner('warning', h('div', null,
          h('div', { class: 'banner-title' }, 'Скопіюйте секрет зараз'),
          h('div', { class: 'banner-msg' }, 'Секрет показується лише один раз. Ним підписується кожен запит (X-Hub-Signature), тож приймач має знати його, щоб перевіряти підпис.'))),
        box.el);
      m.setFooter(
        h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Готово'),
        copyAction(m, created.secret, 'Скопіювати секрет', 'Секрет'));
      requestAnimationFrame(() => { if (m.isOpen) box.input.focus(); });
    }
    return m;
  }

  return { el, load, openCreate };
}

// ---------------------------------------------------------------- endpoint cheat sheet

function pathNode(path) {
  return path.split(/(\{[^}]+\}|\?.*)/).filter(Boolean).map((part) => {
    if (part.startsWith('{')) return h('span', { class: 'ab-ph' }, part);
    if (part.startsWith('?')) return h('span', { class: 'ab-opt-q' }, part);
    return part;
  });
}

function createEndpoints(ctx) {
  const { origin } = ctx;
  const rows = ENDPOINTS.flatMap((g) => [
    h('tr', { class: 'ab-group', role: 'row' }, h('th', { colspan: '4', scope: 'colgroup', role: 'columnheader' }, g.group)),
    ...g.rows.map(([method, path, need, text]) => h('tr', { role: 'row' },
      td('ab-c-method', '', methodBadge(method)),
      td('ab-c-path', '', h('code', null, pathNode(path))),
      td('ab-c-scope', '', need ? scopeChip(need) : h('span', { class: 'muted' }, 'будь-який')),
      td('ab-c-desc', '', text))),
  ]);
  const head = h('tr', { role: 'row' }, th('Метод', 'ab-c-method'), th('Шлях', 'ab-c-path'), th('Дозвіл', 'ab-c-scope'), th('Опис', 'ab-c-desc'));
  const intro = h('div', { class: 'ab-ep-intro' },
    h('div', { class: 'copy-field-wrap' },
      h('div', { class: 'copy-field-label' }, 'Базова адреса'),
      h('div', { class: 'copy-field' }, h('code', { class: 'copy-field-value', title: origin }, origin),
        copyButton(origin, { label: 'Копіювати: базова адреса', what: 'Адресу' }))),
    h('div', { class: 'ab-ep-auth' },
      h('div', { class: 'copy-field-label' }, 'Авторизація ключем'),
      h('div', { class: 'ab-auth-list' },
        h('code', { class: 'ab-auth-item' }, 'X-API-Key: <KEY>'),
        h('code', { class: 'ab-auth-item' }, 'Authorization: Bearer <KEY>'),
        h('code', { class: 'ab-auth-item' }, '?key=<KEY>'),
        h('code', { class: 'ab-auth-item' }, '/k/<KEY>/…'))));
  const body = h('div', null, intro, tableOf('ab-ep', head, rows));
  return { el: card({ title: 'Довідник запитів', sub: 'Головні ендпоінти та потрібні дозволи', body, cls: 'ab-endpoints' }) };
}

// ---------------------------------------------------------------- page

function build(root, scope) {
  const ctx = {
    scope,
    origin: location.origin,
    key: '', keyName: '', keyId: null, newKeyId: null,
    snippets: [],
    listeners: new Set(),
    onKey(fn) { ctx.listeners.add(fn); },
    setKey(value, meta = {}) {
      ctx.key = value;
      ctx.keyName = value ? meta.name || '' : '';
      ctx.keyId = value ? meta.id ?? null : null;
      ctx.listeners.forEach((fn) => fn());
    },
    showGuide() {},
  };
  scope.add(() => {
    ctx.key = '';
    ctx.listeners.clear();
  });

  const keys = createKeys(ctx);
  const hooks = createHooks(ctx);
  const guide = createGuide(ctx, { onCreateKey: () => keys.openCreate() });
  ctx.showGuide = () => guide.el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const endpoints = createEndpoints(ctx);

  mount(root, h('div', { class: 'ab-page' }, guide.el, keys.el, hooks.el, endpoints.el));
  keys.load();
  hooks.load();
  scope.poll(() => Promise.all([keys.load({ silent: true }), hooks.load({ silent: true })]), POLL_MS);
}

export function render(root, { scope }) {
  ensureStyles().then(() => {
    if (scope.disposed) return;
    try {
      build(root, scope);
    } catch (err) {
      console.error(err);
      mount(root, errorBanner({ title: 'Не вдалося відкрити сторінку', message: String(err && err.message ? err.message : err) }));
    }
  });
}
