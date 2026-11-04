// Domain-specific UI pieces: status pills, health, code chips, tags, secrets, countdowns.
import { h, icon, copy, copyButton, mount } from './ui.js';
import { STATUS, STATUSES, HEALTH, healthKey, absTime, relTime, fmtCountdown, parseTime } from './format.js';

export function statusPill(status, { onClick, title } = {}) {
  const info = STATUS[status];
  const label = info ? info.label : status;
  if (onClick) {
    return h('button', {
      type: 'button', class: `pill pill-btn st-${status}`, title: title || 'Змінити статус', 'aria-haspopup': 'menu',
      'aria-label': `Статус: ${label}. Змінити`, onClick,
    }, h('span', { class: 'dot' }), label, icon('chevronDown', { size: 12, cls: 'pill-caret' }));
  }
  return h('span', { class: `pill st-${status}`, title: title || (info ? info.hint : '') }, h('span', { class: 'dot' }), label);
}

export function statusMenuItems(current, onSelect) {
  return [
    { heading: 'Змінити статус' },
    ...STATUSES.map((s) => ({
      label: STATUS[s].label, dot: s, checked: s === current, hint: s === 'leased' ? 'TTL з налаштувань' : '',
      onSelect: () => { if (s !== current) onSelect(s); },
    })),
  ];
}

export function healthTitle(health) {
  const key = healthKey(health);
  let text = HEALTH[key].label;
  if (health && health.checked_at) text += ` · перевірено ${absTime(health.checked_at)}`;
  if (key === 'error' && health.error) text += `\n${health.error}`;
  return text;
}

export function healthDot(health, { withTitle = true } = {}) {
  const key = healthKey(health);
  return h('span', { class: `hdot hdot-${key}`, role: 'img', 'aria-label': HEALTH[key].label, title: withTitle ? healthTitle(health) : null });
}

export function healthCell(health) {
  const checked = health && health.checked_at;
  return h('span', { class: `health health-${healthKey(health)}`, title: healthTitle(health) },
    healthDot(health, { withTitle: false }),
    checked ? h('time', { datetime: checked, 'data-rel': checked, class: 'rel' }, relTime(checked)) : h('span', { class: 'muted' }, 'не перевірялась'));
}

export function codeChip(code, { size = 'md', title = '' } = {}) {
  return h('button', {
    type: 'button', class: `code-chip code-chip-${size}`, title: title || 'Натисніть, щоб скопіювати',
    'aria-label': `Код ${code} — копіювати`,
    onClick: (e) => {
      e.stopPropagation();
      copy(code, `Код ${code}`);
    },
  }, h('span', { class: 'code-chip-text' }, code), size === 'lg' ? icon('copy', { size: 18, cls: 'code-chip-ico' }) : null);
}

export function tagChip(tag, { onClick, onRemove, active = false } = {}) {
  if (onRemove) {
    return h('span', { class: 'tag tag-removable' }, h('span', { class: 'tag-text' }, tag),
      h('button', {
        type: 'button', class: 'tag-x', 'aria-label': `Прибрати «${tag}»`,
        onClick: (e) => { e.stopPropagation(); onRemove(tag); },
      }, icon('x', { size: 11, stroke: 2.2 })));
  }
  if (onClick) {
    return h('button', {
      type: 'button', class: ['tag', 'tag-btn', active && 'is-active'], title: `Фільтр за тегом «${tag}»`,
      onClick: (e) => { e.stopPropagation(); onClick(tag); },
    }, tag);
  }
  return h('span', { class: 'tag' }, tag);
}

const splitTags = (text) => String(text).split(/[,;\s]+/).map((s) => s.trim().toLowerCase().slice(0, 32)).filter(Boolean);

function normalizeTags(list) {
  const out = [];
  for (const t of list.flatMap((x) => splitTags(x))) if (!out.includes(t) && out.length < 20) out.push(t);
  return out;
}

/** Tag input: Enter, comma or paste adds; Backspace on empty input removes the last tag. */
export function chipInput({ value = [], placeholder = 'Додайте тег і натисніть Enter', id, onChange, suggestions = [] } = {}) {
  let tags = normalizeTags(value);
  const input = h('input', { type: 'text', class: 'chip-input-field', id, autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'enter' });
  const list = h('span', { class: 'chip-input-tags' });
  const el = h('div', { class: 'chip-input' }, list, input);
  const sugEl = suggestions.length ? h('div', { class: 'chip-suggest' }) : null;
  el.addEventListener('click', (e) => { if (e.target === el || e.target === list) input.focus(); });

  const changed = () => { if (onChange) onChange(tags.slice()); };
  function render() {
    mount(list, tags.map((t) => tagChip(t, { onRemove: remove })));
    input.placeholder = tags.length ? '' : placeholder;
    if (sugEl) {
      const rest = suggestions.filter((s) => !tags.includes(s));
      mount(sugEl, rest.length ? [h('span', { class: 'chip-suggest-label' }, 'Наявні:'), rest.map((s) => tagChip(s, { onClick: () => add(s) }))] : []);
      sugEl.hidden = !rest.length;
    }
  }
  function add(raw) {
    let any = false;
    for (const t of splitTags(raw)) {
      if (!tags.includes(t) && tags.length < 20) {
        tags.push(t);
        any = true;
      }
    }
    if (any) {
      render();
      changed();
    }
  }
  function remove(tag) {
    tags = tags.filter((t) => t !== tag);
    render();
    changed();
    input.focus();
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (input.value.trim()) {
        e.preventDefault();
        add(input.value);
        input.value = '';
      } else if (e.key !== 'Enter') e.preventDefault();
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      e.preventDefault();
      remove(tags[tags.length - 1]);
    }
  });
  input.addEventListener('paste', (e) => {
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (/[,;\s]/.test(text.trim())) {
      e.preventDefault();
      add(text);
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      add(input.value);
      input.value = '';
    }
  });
  render();
  return {
    el: sugEl ? h('div', { class: 'chip-input-wrap' }, el, sugEl) : el,
    input,
    get value() { return normalizeTags([...tags, input.value]); },
    set value(v) { tags = normalizeTags(v); render(); },
    focus: () => input.focus(),
  };
}

// ---------------------------------------------------------------- lease countdowns

export function leaseCountdown(lease) {
  const el = h('span', { class: 'countdown', 'data-countdown': '', 'data-until': lease.until || '', 'data-since': lease.since || '' });
  updateCountdown(el);
  return el;
}

export function leaseBar(lease) {
  const fill = h('span', { class: 'lease-bar-fill' });
  const el = h('span', { class: 'lease-bar', 'data-leasebar': '', 'data-until': lease.until || '', 'data-since': lease.since || '', 'aria-hidden': 'true' }, fill);
  updateCountdown(el);
  return el;
}

function updateCountdown(el) {
  const until = parseTime(el.dataset.until);
  if (until === null) return;
  const left = until - Date.now();
  if (el.hasAttribute('data-leasebar')) {
    const since = parseTime(el.dataset.since) ?? until - 900000;
    const ratio = Math.max(0, Math.min(1, left / Math.max(1, until - since)));
    el.firstChild.style.width = `${(ratio * 100).toFixed(1)}%`;
    el.classList.toggle('is-low', left < 120000);
    return;
  }
  el.textContent = left > 0 ? fmtCountdown(left) : 'завершується';
  el.classList.toggle('is-low', left < 120000);
  el.title = `Оренда до ${absTime(el.dataset.until)}`;
}

export function updateCountdowns(root) {
  for (const el of root.querySelectorAll('[data-countdown], [data-leasebar]')) updateCountdown(el);
}

// ---------------------------------------------------------------- secrets, key/value lists, badges

const mask = (v) => '•'.repeat(Math.min(28, Math.max(10, String(v).length)));

export function secretField(label, value, { wide = false } = {}) {
  if (!value) {
    return h('div', { class: 'secret' }, h('div', { class: 'secret-label' }, label), h('div', { class: 'secret-row' }, h('span', { class: 'muted' }, '— не задано')));
  }
  let shown = false;
  const valEl = h('code', { class: ['secret-value', 'is-masked', wide && 'is-wide'] }, mask(value));
  const eye = h('button', { type: 'button', class: 'icon-btn', 'aria-pressed': 'false', 'aria-label': `Показати: ${label}`, title: 'Показати' }, icon('eye', { size: 15 }));
  eye.addEventListener('click', () => {
    shown = !shown;
    valEl.textContent = shown ? value : mask(value);
    valEl.classList.toggle('is-masked', !shown);
    eye.setAttribute('aria-pressed', String(shown));
    eye.setAttribute('aria-label', `${shown ? 'Сховати' : 'Показати'}: ${label}`);
    eye.title = shown ? 'Сховати' : 'Показати';
    mount(eye, icon(shown ? 'eyeOff' : 'eye', { size: 15 }));
  });
  return h('div', { class: 'secret' }, h('div', { class: 'secret-label' }, label),
    h('div', { class: 'secret-row' }, valEl, eye, copyButton(value, { label: `Копіювати: ${label}`, what: label })));
}

export function kvList(rows, cls = '') {
  return h('dl', { class: `kv ${cls}` }, rows.filter(Boolean).map(([k, v]) => h('div', { class: 'kv-row' },
    h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? h('span', { class: 'muted' }, '—') : v))));
}

export const methodBadge = (method) => h('span', { class: `method method-${method.toLowerCase().split(/[^a-z]/)[0]}` }, method);

export const SCOPE_INFO = {
  read: { label: 'read', text: 'Читання скриньок, листів, статистики й журналу' },
  code: { label: 'code', text: 'Коди, оренда з пулу, зміна статусу й перевірка входу' },
  write: { label: 'write', text: 'Додавання, редагування, видалення та імпорт скриньок' },
  secrets: { label: 'secrets', text: 'Паролі й refresh_token у відповідях та експорті' },
  admin: { label: 'admin', text: 'Ключі, вебхуки, налаштування — і всі інші дозволи' },
};

export const scopeChip = (scope) => h('span', { class: `scope scope-${scope}`, title: SCOPE_INFO[scope] ? SCOPE_INFO[scope].text : '' }, scope);

export function providerText(m) {
  if (m.type === 'oauth2') return m.provider || 'OAuth2';
  return m.provider ? `IMAP · ${m.provider}` : 'IMAP';
}
