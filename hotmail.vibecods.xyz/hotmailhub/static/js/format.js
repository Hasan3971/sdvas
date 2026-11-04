// Formatting helpers and Ukrainian labels.

export const STATUSES = ['available', 'leased', 'used', 'burned', 'invalid', 'disabled'];

export const STATUS = {
  available: { label: 'Вільна', plural: 'Вільні', hint: 'Готова до видачі BAS', icon: 'checkCircle' },
  leased: { label: 'В оренді', plural: 'В оренді', hint: 'Видана BAS; після закінчення оренди повернеться у вільні', icon: 'clock' },
  used: { label: 'Використана', plural: 'Використані', hint: 'Реєстрація пройшла успішно', icon: 'userCheck' },
  burned: { label: 'Спалена', plural: 'Спалені', hint: 'TikTok відхилив адресу або досягнуто ліміту', icon: 'flame' },
  invalid: { label: 'Недійсна', plural: 'Недійсні', hint: 'Вхід у пошту не працює', icon: 'alertCircle' },
  disabled: { label: 'Вимкнена', plural: 'Вимкнені', hint: 'Вимкнена вручну', icon: 'ban' },
};

export const statusLabel = (s) => (STATUS[s] ? STATUS[s].label : s || '—');

export const HEALTH = {
  ok: { label: 'Вхід працює', short: 'Працює' },
  error: { label: 'Помилка входу', short: 'Помилка' },
  unknown: { label: 'Не перевірялась', short: 'Не перевірялась' },
};

export function healthKey(health) {
  if (!health || health.ok === null || health.ok === undefined) return 'unknown';
  return health.ok ? 'ok' : 'error';
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export const nBoxes = (n) => `${fmtNum(n)} ${plural(n, 'скринька', 'скриньки', 'скриньок')}`;

const numFmt = new Intl.NumberFormat('uk-UA');
export const fmtNum = (n) => numFmt.format(Number(n) || 0);

export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const t = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const absFmt = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const hmFmt = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' });
const shortDateFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short' });
const shortDateYearFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' });
const longDateFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', weekday: 'long' });
const longDateYearFmt = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });

export function absTime(value) {
  const t = parseTime(value);
  return t === null ? '' : absFmt.format(t);
}

export const hhmm = (value) => {
  const t = parseTime(value);
  return t === null ? '' : hmFmt.format(t);
};

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function relTime(value, now = Date.now()) {
  const t = parseTime(value);
  if (t === null) return '—';
  const diff = Math.round((now - t) / 1000);
  if (diff < 0) return inFuture(-diff);
  if (diff < 45) return 'щойно';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} хв тому`;
  const d = new Date(t);
  const today = new Date(now);
  if (diff < 4 * 3600 || sameDay(d, today)) return `${Math.max(1, Math.floor(diff / 3600))} год тому`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, yesterday)) return 'вчора';
  const days = Math.max(2, Math.round(diff / 86400));
  if (days < 7) return `${days} ${plural(days, 'день', 'дні', 'днів')} тому`;
  return d.getFullYear() === today.getFullYear() ? shortDateFmt.format(d) : shortDateYearFmt.format(d);
}

function inFuture(sec) {
  if (sec < 45) return 'за мить';
  if (sec < 3600) return `через ${Math.round(sec / 60)} хв`;
  if (sec < 86400) return `через ${Math.round(sec / 3600)} год`;
  const days = Math.round(sec / 86400);
  return `через ${days} ${plural(days, 'день', 'дні', 'днів')}`;
}

export function dayLabel(value, now = Date.now()) {
  const t = parseTime(value);
  if (t === null) return '';
  const d = new Date(t);
  const today = new Date(now);
  if (sameDay(d, today)) return 'Сьогодні';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (sameDay(d, y)) return 'Вчора';
  const text = d.getFullYear() === today.getFullYear() ? longDateFmt.format(d) : longDateYearFmt.format(d);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function fmtCountdown(ms) {
  if (ms <= 0) return '0:00';
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtDuration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (sec < 60) return `${sec} с`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m} хв ${s} с` : `${m} хв`;
  }
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h} год ${m} хв` : `${h} год`;
}

export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} Б`;
  const units = ['КБ', 'МБ', 'ГБ'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toLocaleString('uk-UA', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

export const pct = (part, total) => (total ? Math.round((part / total) * 1000) / 10 : 0);

export function fmtPct(part, total) {
  const v = pct(part, total);
  return `${v.toLocaleString('uk-UA', { maximumFractionDigits: v < 10 && v > 0 ? 1 : 0 })}%`;
}

// ---------------------------------------------------------------- activity log

const FIELD_LABELS = {
  email: 'email', password: 'пароль', refresh_token: 'refresh_token', client_id: 'client_id',
  imap_host: 'IMAP-сервер', imap_port: 'порт', login: 'логін', note: 'нотатка', tags: 'теги', status: 'статус',
};

export const EVENT_KINDS = {
  'mailbox.added': { label: 'Додано скриньку', tone: 'accent', icon: 'plus' },
  'mailbox.updated': { label: 'Змінено скриньку', tone: 'accent', icon: 'edit' },
  'mailbox.deleted': { label: 'Видалено скриньки', tone: 'red', icon: 'trash' },
  'mailbox.status': { label: 'Зміна статусу', tone: 'indigo', icon: 'dotCircle' },
  'mailbox.invalid': { label: 'Вхід не працює', tone: 'red', icon: 'alertCircle' },
  'code.delivered': { label: 'Видано код', tone: 'green', icon: 'hash' },
  'lease.expired': { label: 'Оренда завершилась', tone: 'amber', icon: 'hourglass' },
  'pool.acquire': { label: 'Видано з пулу', tone: 'amber', icon: 'clock' },
  import: { label: 'Імпорт', tone: 'indigo', icon: 'upload' },
  'check.started': { label: 'Запущено перевірку', tone: 'teal', icon: 'shieldCheck' },
  'key.created': { label: 'Створено API-ключ', tone: 'accent', icon: 'key' },
  'key.revoked': { label: 'Відкликано API-ключ', tone: 'red', icon: 'key' },
  'webhook.created': { label: 'Додано вебхук', tone: 'accent', icon: 'webhook' },
  'settings.updated': { label: 'Змінено налаштування', tone: 'grey', icon: 'settings' },
  'auth.login': { label: 'Вхід у панель', tone: 'grey', icon: 'lock' },
  'auth.failed': { label: 'Невдала спроба входу', tone: 'red', icon: 'lock' },
  'auth.password': { label: 'Змінено пароль', tone: 'grey', icon: 'lock' },
};

export function eventInfo(kind) {
  return EVENT_KINDS[kind] || { label: kind, tone: 'grey', icon: 'activity' };
}

const STATUS_WORD = new RegExp(`\\b(${STATUSES.join('|')})\\b`, 'g');

export function eventDetail(ev) {
  const detail = String(ev.detail || '');
  if (!detail) return '';
  if (ev.kind === 'mailbox.status') return detail.replace(STATUS_WORD, (m) => statusLabel(m).toLowerCase());
  if (ev.kind === 'mailbox.updated') return detail.split(',').filter(Boolean).map((f) => FIELD_LABELS[f] || f).join(', ');
  if (ev.kind === 'import') {
    const m = /skipped=(\d+)\s+invalid=(\d+)/.exec(detail);
    if (m) return `пропущено ${m[1]}, помилкових ${m[2]}`;
  }
  if (ev.kind === 'code.delivered') return detail.replace('лист #', 'лист №');
  if (ev.kind === 'key.created') return `дозволи: ${detail.replace(/,/g, ', ')}`;
  if (ev.kind === 'settings.updated') return detail.replace(/,/g, ', ');
  return detail;
}

export function eventSubject(ev) {
  const subject = String(ev.subject || '');
  if (ev.kind === 'import') {
    const m = /^\+(\d+)\s+~(\d+)$/.exec(subject);
    if (m) return `додано ${m[1]}, оновлено ${m[2]}`;
  }
  if (ev.kind === 'key.revoked') return `ключ №${subject}`;
  return subject;
}

export function actorLabel(actor) {
  if (!actor) return '';
  if (actor === 'admin') return 'адмін';
  if (actor === 'seed') return 'система';
  if (actor.startsWith('key:')) return `ключ «${actor.slice(4)}»`;
  return actor;
}

export const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
