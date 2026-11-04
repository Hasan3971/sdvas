// Settings (#/settings): hub settings with dirty tracking and a code-pattern tester, password change, theme.
import { h, icon, mount, skel, toast, errorBanner, switchEl, segmented, withBusy, uid, debounce } from '../ui.js';
import { api, setCsrf, isAbort } from '../api.js';
import { store, on, themePref, setThemePref, THEME_OPTIONS } from '../store.js';
import { fmtNum, fmtDuration, plural } from '../format.js';
import { codeChip } from '../components.js';

const STYLE_ID = 'pg-styles';
const BAR_CLASS = 'pg-savebar-on';
const MAX_TEXT = 20000;
const MAX_MARKERS = 500;
const MAX_PATTERNS = 10;

// Server clamps these silently (hotmailhub/hub.py SETTING_BOUNDS); the API does not expose them, so they are mirrored here.
const NUMBERS = {
  lease_ttl: {
    label: 'TTL оренди', unit: 'с', min: 30, max: 86400, long: true,
    hint: 'Скільки секунд скринька лишається в оренді, якщо BAS не повернув її раніше. Потім вона знову стає вільною. У запиті pool/acquire можна вказати власний ttl.',
  },
  default_wait: {
    label: 'Очікування коду', unit: 'с', min: 0, max: 900, long: true,
    hint: 'Скільки секунд чекати лист із кодом, якщо в запиті немає wait чи timeout. 0 — відповісти одразу.',
  },
  poll_interval: {
    label: 'Інтервал опитування', unit: 'с', min: 1, max: 60, long: false,
    hint: 'Як часто хаб перевіряє пошту, поки очікує на код.',
  },
  watch_interval: {
    label: 'Інтервал стеження', unit: 'с', min: 5, max: 600, long: true,
    hint: 'Як часто хаб перевіряє орендовані скриньки.',
  },
  messages_keep: {
    label: 'Листів на скриньку', unit: 'шт.', min: 5, max: 500, long: false,
    hint: 'Скільки останніх листів зберігається для кожної скриньки; старіші видаляються.',
  },
};

const LABELS = {
  lease_ttl: 'TTL оренди', default_wait: 'очікування коду', poll_interval: 'інтервал опитування',
  code_markers: 'слова-маркери', code_patterns: 'регулярні вирази', auto_invalidate: 'автопозначення недійсних',
  watch_leased: 'стеження за орендою', watch_interval: 'інтервал стеження', messages_keep: 'листів на скриньку',
};

const SAMPLE_TEXT = [
  'TikTok',
  '482910 is your verification code',
  'This code expires in 10 minutes. Do not share it with anyone.',
  'If you did not request this, ignore this email. Ref: A1B2C3, order 123456.',
].join('\n');

const cap = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');

// pages.css is shared by the Activity and Settings views; the id keeps the link unique.
function ensureStyles() {
  let link = document.getElementById(STYLE_ID);
  if (!link) {
    link = h('link', { id: STYLE_ID, rel: 'stylesheet', href: '/css/pages.css' });
    document.head.appendChild(link);
  }
  return link;
}
ensureStyles();

function useStyles(root) {
  const link = ensureStyles();
  if (link.sheet) return;
  root.hidden = true;
  const show = () => { root.hidden = false; };
  link.addEventListener('load', show, { once: true });
  link.addEventListener('error', show, { once: true });
}

// ---------------------------------------------------------------- code-pattern tester (client side, mirrors hotmailhub/codes.py)

const KEYWORDS = /code|код|verif|confirm|security|пароль|підтверд|подтверд/gi;

/** Python `re` → JavaScript RegExp: leading inline flags and named groups. Returns {re} or {error}. */
function compilePattern(source) {
  let body = source;
  let flags = '';
  const lead = /^\(\?([aiLmsux]+)\)/.exec(body);
  if (lead) {
    body = body.slice(lead[0].length);
    for (const f of lead[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f;
  }
  body = body.replace(/\(\?P<([A-Za-z_]\w*)>/g, '(?<$1>').replace(/\(\?P=([A-Za-z_]\w*)\)/g, '\\k<$1>');
  try {
    return { re: new RegExp(body, `${flags}g`) };
  } catch (err) {
    return { error: String(err && err.message ? err.message : err).replace(/^Invalid regular expression: \/[\s\S]*\/[a-z]*: /, '') };
  }
}

/** Distance in characters to the closest "code/verify" keyword near [start, end); 999 when none (as the server does). */
function keywordNear(flat, start, end) {
  const lo = Math.max(0, start - 70);
  const slice = flat.slice(lo, Math.min(flat.length, end + 40));
  let best = { distance: 999, word: '' };
  KEYWORDS.lastIndex = 0;
  for (let k = KEYWORDS.exec(slice); k; k = KEYWORDS.exec(slice)) {
    const from = lo + k.index;
    const to = from + k[0].length;
    const distance = Math.max(0, to <= start ? start - to : from - end);
    if (distance < best.distance) best = { distance, word: k[0] };
  }
  return best;
}

function markerVerdict(markers, sender, subject) {
  const words = markers.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return { eligible: true, word: '' };
  const haystack = `${subject} ${sender}`.toLowerCase();
  const word = words.find((w) => haystack.includes(w));
  return { eligible: Boolean(word), word: word || '' };
}

/**
 * What the server would extract from a message: codes ordered by closeness to a keyword, then by pattern order,
 * then by position; the text is "subject\nbody" with whitespace collapsed. Exported for tests.
 */
export function analyzeSample({ patterns, text, subject = '', sender = '', markers = null, limit = 5 }) {
  const full = `${subject}\n${text}`;
  const clipped = full.length > MAX_TEXT;
  const flat = full.slice(0, MAX_TEXT).replace(/\s+/g, ' ');
  const compiled = patterns.map((source, index) => ({ index, source, count: 0, ...compilePattern(source) }));
  const found = [];
  for (const p of compiled) {
    if (!p.re) continue;
    p.re.lastIndex = 0;
    for (let m = p.re.exec(flat), guard = 0; m && guard < 500; m = p.re.exec(flat), guard += 1) {
      if (m[0] === '') {
        p.re.lastIndex += 1;
        continue;
      }
      const code = m.length > 1 ? m[1] : m[0];
      if (!code) continue;
      const near = keywordNear(flat, m.index, m.index + m[0].length);
      p.count += 1;
      found.push({ index: p.index, start: m.index, end: m.index + m[0].length, code, distance: near.distance, word: near.word });
    }
  }
  found.sort((a, b) => a.distance - b.distance || a.index - b.index || a.start - b.start);
  const codes = [];
  for (const f of found) {
    if (!codes.some((c) => c.code === f.code)) codes.push({ ...f, rank: codes.length + 1 });
  }
  return {
    flat, clipped, patterns: compiled, found, codes: codes.slice(0, limit), extra: Math.max(0, codes.length - limit),
    verdict: markers === null ? null : markerVerdict(markers, sender, subject),
  };
}

function highlightNodes(result) {
  const best = result.codes.length ? result.codes[0].code : null;
  const spans = result.found.map((f) => ({ start: f.start, end: f.end, top: f.code === best })).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      last.top = last.top || s.top;
    } else merged.push({ ...s });
  }
  const nodes = [];
  let at = 0;
  for (const s of merged) {
    if (s.start > at) nodes.push(result.flat.slice(at, s.start));
    nodes.push(h('mark', { class: ['pg-hit', s.top && 'pg-hit-top'] }, result.flat.slice(s.start, s.end)));
    at = s.end;
  }
  if (at < result.flat.length) nodes.push(result.flat.slice(at));
  return nodes;
}

function describeDistance(c) {
  if (c.distance >= 999) return 'поруч немає слів code / verify';
  if (c.distance === 0) return `впритул до «${c.word}»`;
  return `${c.distance} ${plural(c.distance, 'символ', 'символи', 'символів')} від «${c.word}»`;
}

function buildTester({ getPatterns, getMarkers, scope }) {
  const sampleId = uid('pg-sample');
  const sample = h('textarea', {
    class: 'textarea mono pg-sample', id: sampleId, rows: 6, spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Вставте сюди текст листа з кодом…', 'aria-describedby': 'pg-tester-note',
  });
  const senderId = uid('pg-sender');
  const subjectId = uid('pg-subject');
  const sender = h('input', { class: 'input', id: senderId, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'register@account.tiktok.com' });
  const subject = h('input', { class: 'input', id: subjectId, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '482910 is your verification code' });
  const extra = h('details', { class: 'pg-extra' },
    h('summary', null, 'Додатково: відправник і тема (для слів-маркерів)'),
    h('div', { class: 'pg-extra-grid' },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: senderId }, 'Відправник'), sender),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: subjectId }, 'Тема листа'), subject)),
    h('p', { class: 'field-hint' }, 'Сервер перевіряє слова-маркери лише в темі та відправнику; тема також входить у текст, де шукаються коди.'));
  const out = h('div', { class: 'pg-result', 'aria-live': 'polite' });

  function resultNodes(res, filled) {
    if (!filled) return [h('p', { class: 'pg-result-empty' }, 'Вставте текст листа — тут з’явиться результат.')];
    const nodes = [];
    if (res.verdict && (sender.value.trim() || subject.value.trim())) {
      nodes.push(res.verdict.eligible
        ? h('div', { class: 'pg-note pg-note-ok' }, icon('checkCircle', { size: 15 }),
          h('span', null, res.verdict.word ? `Лист пройде фільтр слів-маркерів: збіг за «${res.verdict.word}».` : 'Слова-маркери порожні — перевіряються всі листи.'))
        : h('div', { class: 'pg-note pg-note-warn' }, icon('alert', { size: 15 }),
          h('span', null, 'Жодне зі слів-маркерів не зустрілось у темі чи відправнику — сервер пропустить такий лист (якщо в запиті немає any=1). Нижче — що знайшли б вирази, якби лист пройшов фільтр.')));
    }
    if (!res.codes.length) {
      nodes.push(h('div', { class: 'pg-note pg-note-warn' }, icon('alertCircle', { size: 15 }),
        h('span', null, res.patterns.some((p) => p.re) ? 'Жоден вираз не знайшов код у цьому тексті.' : 'Немає жодного робочого виразу.')));
    } else {
      nodes.push(h('div', { class: 'pg-block-title' }, 'Знайдені коди', h('span', { class: 'pg-block-sub' }, 'за порядком, у якому їх віддасть сервер')));
      nodes.push(h('ol', { class: ['pg-codes', res.verdict && !res.verdict.eligible && 'is-muted'] }, res.codes.map((c) => h('li', { class: ['pg-code', c.rank === 1 && 'is-first'] },
        h('span', { class: 'pg-rank', 'aria-label': `№${c.rank}` }, String(c.rank)),
        codeChip(c.code),
        h('span', { class: 'pg-code-meta' }, `вираз №${c.index + 1} · ${describeDistance(c)}`),
        c.rank === 1 ? h('span', { class: 'pg-pick', title: 'Саме цей код віддасть API для такого листа' }, icon('check', { size: 12 }), 'видасть API') : null))));
      if (res.extra) nodes.push(h('p', { class: 'pg-more' }, `і ще ${res.extra} ${plural(res.extra, 'код', 'коди', 'кодів')} (сервер віддає до 5)`));
    }
    nodes.push(h('div', { class: 'pg-block-title' }, 'Вирази'));
    nodes.push(h('ul', { class: 'pg-pats' }, res.patterns.map((p) => h('li', { class: ['pg-pat', p.error && 'is-bad'] },
      icon(p.error ? 'alertCircle' : p.count ? 'checkCircle' : 'minus', { size: 14, cls: 'pg-pat-ico' }),
      h('span', { class: 'pg-pat-n' }, `№${p.index + 1}`),
      h('code', { class: 'pg-pat-src', title: p.source }, p.source),
      h('span', { class: 'pg-pat-res' }, p.error ? `помилка: ${p.error}` : p.count ? `${p.count} ${plural(p.count, 'збіг', 'збіги', 'збігів')}` : 'збігів немає')))));
    if (res.found.length) {
      nodes.push(h('div', { class: 'pg-block-title' }, 'Текст, як його бачить сервер', h('span', { class: 'pg-block-sub' }, 'пробіли стиснуто, збіги підсвічено')));
      nodes.push(h('p', { class: 'pg-preview' }, highlightNodes(res)));
    }
    if (res.clipped) nodes.push(h('p', { class: 'pg-more' }, `Для швидкості перевіряються перші ${fmtNum(MAX_TEXT)} символів.`));
    return nodes;
  }

  function run() {
    const filled = Boolean(sample.value.trim() || subject.value.trim());
    const patterns = getPatterns();
    if (!patterns.length) {
      mount(out, h('div', { class: 'pg-note pg-note-warn' }, icon('alertCircle', { size: 15 }), h('span', null, 'Додайте хоча б один регулярний вираз.')));
      return;
    }
    const res = analyzeSample({ patterns, text: sample.value, subject: subject.value, sender: sender.value, markers: getMarkers() });
    mount(out, resultNodes(res, filled));
  }
  const runSoon = debounce(run, 160);
  scope.add(runSoon.cancel);
  for (const el of [sample, sender, subject]) el.addEventListener('input', runSoon);

  const el = h('div', { class: 'pg-tester' },
    h('div', { class: 'pg-tester-head' },
      h('label', { class: 'pg-tester-title', for: sampleId }, icon('terminal', { size: 15 }), 'Тест на тексті'),
      h('div', { class: 'pg-tester-actions' },
        h('button', { type: 'button', class: 'btn btn-sm', onClick: () => { sample.value = SAMPLE_TEXT; run(); sample.focus(); } }, 'Вставити приклад'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => { sample.value = ''; sender.value = ''; subject.value = ''; run(); sample.focus(); } }, 'Очистити'))),
    h('p', { class: 'field-hint', id: 'pg-tester-note' },
      'Працює в браузері, без збереження: беруться вирази з поля зліва, навіть незбережені. Це наближення — рушій сервера (Python) може трохи відрізнятись.'),
    sample, extra, out);
  // Enter in the tester inputs must not submit the settings form around them.
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') e.preventDefault(); });
  run();
  return { el, refresh: runSoon };
}

// ---------------------------------------------------------------- settings form

const sameValue = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b));

function normalize(key, value) {
  if (key === 'code_patterns') {
    const lines = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
    return lines.map((s) => String(s).trim()).filter(Boolean);
  }
  if (key === 'code_markers') return String(value ?? '').trim();
  if (key === 'auto_invalidate' || key === 'watch_leased') return Boolean(value);
  return Number(value);
}

function formatDefault(key, value) {
  if (key in NUMBERS) {
    const spec = NUMBERS[key];
    const human = spec.long && value >= 60 ? ` (${fmtDuration(value)})` : '';
    return `${fmtNum(value)} ${spec.unit}${human}`;
  }
  if (typeof value === 'boolean') return value ? 'увімкнено' : 'вимкнено';
  if (key === 'code_patterns') return `${value.length} ${plural(value.length, 'вираз', 'вирази', 'виразів')}`;
  return value === '' ? 'порожньо' : value;
}

function skeletonCards() {
  const fieldSkel = () => h('div', { class: 'pg-skel-field' }, skel('skel-line w-40'), skel('skel-line w-90 pg-skel-input'), skel('skel-line w-70 sm'));
  return Array.from({ length: 3 }, (_, i) => h('section', { class: 'card', 'aria-hidden': 'true' },
    h('header', { class: 'card-head' }, h('div', { class: 'card-titles' }, skel('skel-line w-30'), skel('skel-line w-50 sm'))),
    h('div', { class: 'card-body pg-grid3' }, fieldSkel(), fieldSkel(), i === 1 ? null : fieldSkel())));
}

function settingsCard({ title, sub, body }) {
  return h('section', { class: 'card' },
    h('header', { class: 'card-head' }, h('div', { class: 'card-titles' }, h('h2', { class: 'card-title' }, title), h('p', { class: 'card-sub' }, sub))),
    h('div', { class: 'card-body' }, body));
}

function buildForm({ settings, defaults }, scope) {
  const state = { saved: {}, defaults: {} };
  const fields = {};
  const KEYS = Object.keys(LABELS);
  let saving = false;
  let tester = null;

  const setData = (data) => {
    for (const key of KEYS) {
      state.saved[key] = normalize(key, data.settings[key]);
      state.defaults[key] = normalize(key, data.defaults[key]);
    }
  };
  setData({ settings, defaults });

  const dirtyKeys = () => KEYS.filter((k) => !sameValue(fields[k].read(), state.saved[k]));

  // Shared bits of every field: the "змінено" badge, "За замовчуванням" line and the "скинути" link.
  function chrome(key, { unit = false } = {}) {
    const dirty = h('span', { class: 'pg-dirty', hidden: true }, 'змінено');
    const human = h('span', { class: 'pg-human' });
    const def = h('span', { class: 'pg-def' }, 'За замовчуванням: ', h('b', null, formatDefault(key, state.defaults[key])));
    const reset = h('button', { type: 'button', class: 'link-btn pg-reset', hidden: true, 'aria-label': `Скинути «${LABELS[key]}» до значення за замовчуванням` }, 'скинути');
    const meta = h('div', { class: 'pg-meta' }, def, reset);
    return { dirty, human, meta, reset, unit };
  }

  function bindCommon(key, api2, c, control) {
    const errorEl = h('div', { class: 'field-error', id: `${control.id}-err`, hidden: true });
    const describedBy = (extra = '') => [extra, c.meta.id, errorEl.id].filter(Boolean).join(' ');
    c.meta.id = `${control.id}-def`;
    control.setAttribute('aria-describedby', describedBy(api2.hintId));
    api2.errorEl = errorEl;
    api2.setError = (msg) => {
      errorEl.textContent = msg || '';
      errorEl.hidden = !msg;
      api2.el.classList.toggle('has-error', Boolean(msg));
      if (msg) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    };
    api2.sync = () => {
      c.dirty.hidden = sameValue(api2.read(), state.saved[key]);
      c.reset.hidden = sameValue(api2.read(), state.defaults[key]);
      api2.el.classList.toggle('is-dirty', !c.dirty.hidden);
      if (api2.onSync) api2.onSync();
    };
    api2.focus = () => control.focus();
    c.reset.addEventListener('click', () => {
      api2.write(state.defaults[key]);
      api2.setError('');
      control.focus();
      changed(key);
    });
    return errorEl;
  }

  function numberField(key) {
    const spec = NUMBERS[key];
    const id = `pg-${key}`;
    const c = chrome(key, { unit: true });
    const input = h('input', {
      class: 'input pg-num', id, type: 'number', inputmode: 'numeric', min: spec.min, max: spec.max, step: 1,
      autocomplete: 'off',
    });
    input.value = String(state.saved[key]);
    const hintEl = h('div', { class: 'field-hint', id: `${id}-hint` }, spec.hint);
    const api2 = {
      key, hintId: hintEl.id,
      read: () => (input.value.trim() === '' ? NaN : Number(input.value)),
      write: (v) => { input.value = String(v); },
      validate: () => {
        const v = api2.read();
        if (!Number.isInteger(v)) return `Вкажіть ціле число від ${fmtNum(spec.min)} до ${fmtNum(spec.max)}.`;
        if (v < spec.min || v > spec.max) return `Допустимо від ${fmtNum(spec.min)} до ${fmtNum(spec.max)} ${spec.unit}.`;
        return '';
      },
      onSync: () => {
        const v = api2.read();
        c.human.textContent = spec.long && Number.isInteger(v) && v >= 60 ? `≈ ${fmtDuration(v)}` : '';
      },
    };
    api2.el = h('div', { class: 'field pg-field' },
      h('label', { class: 'field-label', for: id }, spec.label, c.dirty, c.human),
      h('div', { class: 'input-suffix-wrap' }, input, h('span', { class: 'input-suffix' }, spec.unit)));
    const errorEl = bindCommon(key, api2, c, input);
    api2.el.append(errorEl, hintEl, c.meta);
    input.addEventListener('input', () => { if (!errorEl.hidden) api2.setError(api2.validate()); changed(key); });
    input.addEventListener('blur', () => api2.setError(api2.validate()));
    return api2;
  }

  function markersField() {
    const key = 'code_markers';
    const id = 'pg-code_markers';
    const c = chrome(key);
    const input = h('input', { class: 'input', id, type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'tiktok, verify, код' });
    input.value = state.saved[key];
    const hintEl = h('div', { class: 'field-hint', id: `${id}-hint` },
      'Через кому. Лист розглядається, лише якщо його тема або відправник містить одне з цих слів (регістр не важливий). Порожнє поле — усі листи.');
    const api2 = {
      key, hintId: hintEl.id,
      read: () => input.value.trim(),
      write: (v) => { input.value = v; },
      validate: () => (input.value.trim().length > MAX_MARKERS ? `Не більше ${MAX_MARKERS} символів.` : ''),
    };
    api2.el = h('div', { class: 'field pg-field' }, h('label', { class: 'field-label', for: id }, 'Слова-маркери', c.dirty), input);
    const errorEl = bindCommon(key, api2, c, input);
    api2.el.append(errorEl, hintEl, c.meta);
    input.addEventListener('input', () => { if (!errorEl.hidden) api2.setError(api2.validate()); changed(key); });
    return api2;
  }

  function patternsField() {
    const key = 'code_patterns';
    const id = 'pg-code_patterns';
    const c = chrome(key);
    const area = h('textarea', { class: 'textarea mono pg-patterns', id, rows: 5, spellcheck: 'false', autocomplete: 'off', wrap: 'off', placeholder: '(?<!\\d)(\\d{6})(?!\\d)' });
    area.value = state.saved[key].join('\n');
    const hintEl = h('div', { class: 'field-hint', id: `${id}-hint` },
      `По одному регулярному виразу на рядок (від 1 до ${MAX_PATTERNS}). Якщо у виразі є група в дужках — кодом стає перша група, інакше весь збіг. `
      + 'Сервер збирає збіги з усіх виразів і сортує: спершу найближчі до слів code, verify, підтвердження…, потім за порядком виразів і позицією в тексті; першим іде код, який віддасть API.');
    const defaultsList = h('details', { class: 'pg-defaults' },
      h('summary', null, 'Показати значення за замовчуванням'),
      h('pre', { class: 'pg-defaults-pre' }, state.defaults[key].join('\n')));
    const api2 = {
      key, hintId: hintEl.id,
      read: () => normalize(key, area.value),
      write: (v) => { area.value = v.join('\n'); },
      validate: () => {
        const lines = api2.read();
        if (!lines.length) return 'Потрібен принаймні один регулярний вираз.';
        if (lines.length > MAX_PATTERNS) return `Не більше ${MAX_PATTERNS} виразів — зараз ${lines.length}.`;
        return '';
      },
    };
    api2.el = h('div', { class: 'field pg-field' }, h('label', { class: 'field-label', for: id }, 'Регулярні вирази', c.dirty), area);
    const errorEl = bindCommon(key, api2, c, area);
    api2.el.append(errorEl, hintEl, c.meta, defaultsList);
    area.addEventListener('input', () => { if (!errorEl.hidden) api2.setError(api2.validate()); changed(key); });
    area.addEventListener('blur', () => { if (errorEl.hidden) api2.setError(api2.validate()); });
    return api2;
  }

  function toggleField(key, { title, text }) {
    const id = `pg-${key}`;
    const c = chrome(key);
    const titleEl = h('div', { class: 'pg-toggle-title', id: `${id}-title` }, title, c.dirty);
    const descEl = h('p', { class: 'pg-toggle-desc', id: `${id}-desc` }, text);
    const sw = switchEl({ checked: state.saved[key], id, describedBy: `${descEl.id}` });
    sw.input.setAttribute('aria-labelledby', titleEl.id);
    const api2 = {
      key, hintId: descEl.id,
      read: () => sw.input.checked,
      write: (v) => { sw.input.checked = v; },
      validate: () => '',
    };
    api2.el = h('div', { class: 'pg-toggle' },
      h('div', { class: 'pg-toggle-text' }, titleEl, descEl, c.meta),
      sw.el);
    bindCommon(key, api2, c, sw.input);
    sw.input.setAttribute('aria-describedby', `${descEl.id} ${c.meta.id}`);
    sw.input.addEventListener('change', () => changed(key));
    return api2;
  }

  fields.lease_ttl = numberField('lease_ttl');
  fields.default_wait = numberField('default_wait');
  fields.poll_interval = numberField('poll_interval');
  fields.code_markers = markersField();
  fields.code_patterns = patternsField();
  fields.auto_invalidate = toggleField('auto_invalidate', {
    title: 'Позначати недійсні скриньки',
    text: 'Якщо вхід у скриньку не вдався через помилку авторизації, вона отримує статус «Недійсна». Успішна перевірка повертає її у «Вільні».',
  });
  fields.watch_leased = toggleField('watch_leased', {
    title: 'Стежити за орендованими скриньками',
    text: 'Хаб сам перевіряє пошту орендованих скриньок і одразу надсилає вебхук code.received, щойно надходить код.',
  });
  fields.watch_interval = numberField('watch_interval');
  fields.messages_keep = numberField('messages_keep');

  tester = buildTester({
    getPatterns: () => fields.code_patterns.read(),
    getMarkers: () => fields.code_markers.read(),
    scope,
  });

  // ------------------------------------------------------------ bar, dirty tracking
  const barText = h('span', { class: 'pg-bar-text' });
  const cancelBtn = h('button', { type: 'button', class: 'btn', onClick: () => cancel() }, 'Скасувати');
  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('check', { size: 15, stroke: 2.2 }), 'Зберегти');
  const bar = h('div', { class: 'pg-savebar', role: 'region', 'aria-label': 'Незбережені зміни', hidden: true },
    h('span', { class: 'pg-bar-dot', 'aria-hidden': 'true' }), barText, h('span', { class: 'pg-bar-actions' }, cancelBtn, saveBtn));

  function updateBar() {
    const n = dirtyKeys().length;
    bar.hidden = n === 0;
    barText.textContent = `Незбережено: ${n} ${plural(n, 'зміна', 'зміни', 'змін')}`;
    document.documentElement.classList.toggle(BAR_CLASS, n > 0);
  }
  scope.add(() => document.documentElement.classList.remove(BAR_CLASS));

  function changed(key) {
    fields[key].sync();
    if (key === 'code_patterns' || key === 'code_markers') tester.refresh();
    updateBar();
  }

  function syncAll() {
    for (const key of KEYS) fields[key].sync();
    updateBar();
  }

  function cancel() {
    for (const key of KEYS) {
      fields[key].write(state.saved[key]);
      fields[key].setError('');
    }
    syncAll();
    tester.refresh();
  }

  async function save() {
    if (saving) return;
    const keys = dirtyKeys();
    if (!keys.length) return;
    let firstBad = null;
    for (const key of keys) {
      const message = fields[key].validate();
      fields[key].setError(message);
      if (message && !firstBad) firstBad = key;
    }
    if (firstBad) {
      fields[firstBad].focus();
      toast.error('Перевірте підсвічені поля.', { title: 'Налаштування не збережено' });
      return;
    }
    const patch = Object.fromEntries(keys.map((k) => [k, fields[k].read()]));
    saving = true;
    try {
      await withBusy(saveBtn, async () => {
        const data = await api.put('/api/v1/settings', patch, { signal: scope.signal });
        if (scope.disposed) return;
        setData(data);
        for (const key of keys) {
          if (sameValue(fields[key].read(), patch[key])) fields[key].write(state.saved[key]);
          fields[key].setError('');
        }
        syncAll();
        tester.refresh();
        toast.success(`Оновлено: ${keys.map((k) => LABELS[k]).join(', ')}.`, { title: 'Налаштування збережено' });
      });
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      if (err.code === 'bad_patterns') {
        fields.code_patterns.setError(cap(err.message));
        fields.code_patterns.focus();
        toast.error('Сервер не прийняв регулярні вирази — деталі під полем.', { title: 'Налаштування не збережено' });
      } else {
        toast.error(err.message, { title: 'Не вдалося зберегти налаштування' });
      }
    } finally {
      saving = false;
    }
  }

  const form = h('form', { class: 'pg-form', novalidate: true, autocomplete: 'off' },
    settingsCard({
      title: 'Оренда та очікування коду',
      sub: 'Як довго скринька лишається за BAS і як хаб чекає на лист',
      body: h('div', { class: 'pg-grid3' }, fields.lease_ttl.el, fields.default_wait.el, fields.poll_interval.el),
    }),
    settingsCard({
      title: 'Розпізнавання кодів',
      sub: 'Які листи перевіряються і як із них дістається код',
      body: h('div', { class: 'pg-codes-body' },
        fields.code_markers.el,
        h('div', { class: 'pg-split' }, fields.code_patterns.el, tester.el)),
    }),
    settingsCard({
      title: 'Автоматика та зберігання',
      sub: 'Фонові перевірки скриньок і обсяг збережених листів',
      body: h('div', { class: 'pg-auto' },
        fields.auto_invalidate.el,
        h('div', { class: 'pg-toggle-group' }, fields.watch_leased.el, h('div', { class: 'pg-toggle-sub' }, fields.watch_interval.el)),
        h('div', { class: 'pg-auto-keep' }, fields.messages_keep.el)),
    }),
    bar);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  scope.on(document, 'keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's' && dirtyKeys().length) {
      e.preventDefault();
      save();
    }
  });
  scope.on(window, 'beforeunload', (e) => {
    if (dirtyKeys().length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  syncAll();
  return form;
}

// ---------------------------------------------------------------- password

function passwordInput(id, label, autocomplete, hint) {
  const input = h('input', { class: 'input', id, type: 'password', autocomplete, spellcheck: 'false', required: true });
  const eye = h('button', { type: 'button', class: 'icon-btn input-affix', 'aria-label': `Показати: ${label.toLowerCase()}`, 'aria-pressed': 'false' }, icon('eye', { size: 16 }));
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', `${show ? 'Сховати' : 'Показати'}: ${label.toLowerCase()}`);
    mount(eye, icon(show ? 'eyeOff' : 'eye', { size: 16 }));
    input.focus();
  });
  const hintEl = hint ? h('div', { class: 'field-hint', id: `${id}-hint` }, hint) : null;
  const errorEl = h('div', { class: 'field-error', id: `${id}-err`, hidden: true });
  input.setAttribute('aria-describedby', [hintEl && hintEl.id, errorEl.id].filter(Boolean).join(' '));
  const el = h('div', { class: 'field' }, h('label', { class: 'field-label', for: id }, label), h('div', { class: 'input-wrap' }, input, eye), errorEl, hintEl);
  return {
    el, input,
    setError(msg) {
      errorEl.textContent = msg || '';
      errorEl.hidden = !msg;
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    },
  };
}

function passwordCard(scope) {
  const current = passwordInput('pg-pass-current', 'Поточний пароль', 'current-password');
  const next = passwordInput('pg-pass-new', 'Новий пароль', 'new-password', 'Щонайменше 8 символів.');
  const again = passwordInput('pg-pass-again', 'Повторіть новий пароль', 'new-password');
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('lock', { size: 15 }), 'Змінити пароль');
  const all = [current, next, again];

  function validate() {
    for (const f of all) f.setError('');
    let bad = null;
    const fail = (field, msg) => { field.setError(msg); bad = bad || field; };
    if (!current.input.value) fail(current, 'Введіть поточний пароль.');
    if (next.input.value.length < 8) fail(next, 'Новий пароль має містити щонайменше 8 символів.');
    else if (next.input.value === current.input.value) fail(next, 'Новий пароль збігається з поточним.');
    if (again.input.value !== next.input.value) fail(again, 'Паролі не збігаються.');
    if (bad) bad.input.focus();
    return !bad;
  }

  async function adoptSession(res) {
    let token = res && res.csrf;
    if (!token) token = (await api.get('/api/v1/me')).csrf;
    setCsrf(token);
    if (store.me) store.me.csrf = token;
  }

  const form = h('form', { class: 'pg-pass', novalidate: true },
    h('div', { class: 'card-body form-stack' }, current.el, next.el, again.el,
      h('p', { class: 'field-hint' }, 'Після зміни пароля інші відкриті сесії буде завершено — вас це не стосується.')),
    h('footer', { class: 'card-foot' }, submit));
  again.input.addEventListener('input', () => { if (again.input.value === next.input.value) again.setError(''); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate()) return;
    try {
      await withBusy(submit, async () => {
        const res = await api.post('/api/v1/auth/password', { current: current.input.value, new: next.input.value }, { signal: scope.signal });
        await adoptSession(res);
        for (const f of all) {
          f.input.value = '';
          f.setError('');
        }
        toast.success('Інші сесії завершено. Для нових входів використовуйте новий пароль.', { title: 'Пароль змінено' });
      });
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      if (err.code === 'bad_password') {
        current.setError(cap(err.message));
        current.input.focus();
        current.input.select();
      } else if (err.code === 'weak_password') {
        next.setError(cap(err.message));
        next.input.focus();
      } else {
        toast.error(err.message, { title: 'Не вдалося змінити пароль' });
      }
    }
  });

  return h('section', { class: 'card pg-card-pass' },
    h('header', { class: 'card-head' }, h('div', { class: 'card-titles' },
      h('h2', { class: 'card-title' }, 'Змінити пароль'), h('p', { class: 'card-sub' }, 'Пароль адміністратора для входу в цю панель'))),
    form);
}

// ---------------------------------------------------------------- appearance

function appearanceCard(scope) {
  const seg = segmented({
    options: THEME_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: o.icon })),
    value: themePref(), onChange: setThemePref, label: 'Тема оформлення',
  });
  const now = h('b', null);
  const sync = () => {
    now.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? 'світла' : 'темна';
  };
  sync();
  scope.add(on('theme', (pref) => { seg.set(pref); sync(); }));
  const media = window.matchMedia('(prefers-color-scheme: light)');
  scope.on(media, 'change', sync);

  return h('section', { class: 'card pg-card-theme' },
    h('header', { class: 'card-head' }, h('div', { class: 'card-titles' },
      h('h2', { class: 'card-title' }, 'Вигляд'), h('p', { class: 'card-sub' }, 'Тема оформлення панелі'))),
    h('div', { class: 'card-body form-stack' },
      seg.el,
      h('p', { class: 'field-hint' }, '«Системна» повторює тему пристрою і змінюється разом із нею. Вибір зберігається в цьому браузері.'),
      h('p', { class: 'pg-theme-now' }, 'Зараз застосовано: ', now, ' тема')));
}

// ---------------------------------------------------------------- view

export function render(root, { scope }) {
  useStyles(root);

  const slot = h('div', { class: 'pg-stack' }, skeletonCards());

  async function load() {
    mount(slot, skeletonCards());
    try {
      const data = await api.get('/api/v1/settings', null, { signal: scope.signal });
      if (scope.disposed) return;
      mount(slot, buildForm(data, scope));
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      mount(slot, errorBanner({ title: 'Не вдалося завантажити налаштування', message: err.message, onRetry: () => load() }));
    }
  }

  mount(root,
    h('p', { class: 'pg-lead' }, 'Параметри хаба. Зміни діють протягом кількох секунд після збереження — перезапуск не потрібен.'),
    slot,
    h('div', { class: 'pg-pair' }, passwordCard(scope), appearanceCard(scope)));
  load();
}
