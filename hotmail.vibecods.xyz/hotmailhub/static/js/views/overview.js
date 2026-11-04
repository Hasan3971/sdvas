// Overview (#/): stats, distribution, BAS connection, quick actions, leases, recent codes, activity.
import { h, icon, mount, timeEl, skel, emptyState, errorBanner, copyButton, confirmDialog } from '../ui.js';
import { api, isAbort } from '../api.js';
import { STATUS, STATUSES, fmtNum, fmtPct, eventInfo, eventSubject, eventDetail, actorLabel, looksLikeEmail } from '../format.js';
import { codeChip, leaseCountdown, leaseBar, updateCountdowns } from '../components.js';
import { on, loadStats, store } from '../store.js';
import { navigate, mailboxHash } from '../router.js';
import { openImport } from './import.js';
import { openMailboxForm } from './mailbox-form.js';
import { openExport } from './export.js';
import { startCheck } from './check-job.js';

const STAT_CARDS = [
  { key: 'total', label: 'Усього', icon: 'inbox', tone: 'accent', href: '#/mailboxes' },
  { key: 'available', label: 'Вільні', icon: 'checkCircle', tone: 'available', href: '#/mailboxes?status=available' },
  { key: 'leased', label: 'В оренді', icon: 'clock', tone: 'leased', href: '#/mailboxes?status=leased' },
  { key: 'used', label: 'Використані', icon: 'userCheck', tone: 'used', href: '#/mailboxes?status=used' },
  { key: 'burned', label: 'Спалені', icon: 'flame', tone: 'burned', href: '#/mailboxes?status=burned' },
  { key: 'invalid', label: 'Недійсні', icon: 'alertCircle', tone: 'invalid', href: '#/mailboxes?status=invalid' },
  { key: 'codes_24h', label: 'Коди за 24 год', icon: 'hash', tone: 'codes', href: '#/activity?kind=code.*' },
];

export function card({ title, sub = '', action = null, body, cls = '', count = null }) {
  return h('section', { class: `card ${cls}` },
    h('header', { class: 'card-head' },
      h('div', { class: 'card-titles' }, h('h2', { class: 'card-title' }, title, count), sub ? h('p', { class: 'card-sub' }, sub) : null),
      action),
    body);
}

const headLink = (label, href) => h('a', { class: 'card-link', href }, label, icon('arrowRight', { size: 14 }));

function listSkeleton(n) {
  return Array.from({ length: n }, () => h('div', { class: 'list-row is-skel' }, skel('skel-circle'), h('div', { class: 'grow' }, skel('skel-line w-60'), skel('skel-line w-40 sm'))));
}

export function render(root, { scope }) {
  const alertSlot = h('div', { class: 'alert-slot' });
  const statsEl = h('section', { class: 'stat-grid', 'aria-label': 'Зведення пулу' },
    STAT_CARDS.map(() => h('div', { class: 'stat is-skel' }, skel('skel-line w-50 sm'), skel('skel-num'), skel('skel-line w-40 sm'))));
  const distBody = h('div', { class: 'dist' }, skel('skel-bar'), h('div', { class: 'dist-legend' }, Array.from({ length: 6 }, () => skel('skel-line w-80'))));
  const leasedBody = h('div', { class: 'list' }, listSkeleton(3));
  const codesBody = h('div', { class: 'list' }, listSkeleton(4));
  const eventsBody = h('div', { class: 'list list-events' }, listSkeleton(5));
  const leasedCount = h('span', { class: 'card-count', hidden: true });

  mount(root,
    alertSlot,
    statsEl,
    h('div', { class: 'ov-row' },
      card({ title: 'Розподіл пулу', sub: 'Статуси, стан входу й типи скриньок', body: distBody, cls: 'ov-dist', action: headLink('Усі скриньки', '#/mailboxes') }),
      basCard()),
    quickActions(),
    h('div', { class: 'ov-lists' },
      card({ title: 'Орендовані зараз', count: leasedCount, action: headLink('Усі', '#/mailboxes?status=leased'), body: leasedBody, cls: 'ov-list' }),
      card({ title: 'Останні коди', action: headLink('Скриньки', '#/mailboxes?sort=last_code_at&order=desc'), body: codesBody, cls: 'ov-list' }),
      card({ title: 'Остання активність', action: headLink('Журнал', '#/activity'), body: eventsBody, cls: 'ov-list' })));

  let loadedOnce = false;
  async function load() {
    try {
      const [stats, leased, codes, events] = await Promise.all([
        loadStats(),
        api.get('/api/v1/mailboxes', { status: 'leased', sort: 'updated_at', order: 'desc', limit: 100 }, { signal: scope.signal }),
        api.get('/api/v1/mailboxes', { sort: 'last_code_at', order: 'desc', limit: 7 }, { signal: scope.signal }),
        api.get('/api/v1/events', { limit: 10 }, { signal: scope.signal }),
      ]);
      if (scope.disposed) return;
      mount(alertSlot);
      renderStats(stats);
      renderDist(stats);
      renderLeased(leased);
      renderCodes(codes.items.filter((m) => m.last_code));
      renderEvents(events.items);
      loadedOnce = true;
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      mount(alertSlot, errorBanner({ title: loadedOnce ? 'Не вдалося оновити дані' : 'Не вдалося завантажити огляд', message: err.message, onRetry: load }));
      if (!loadedOnce) {
        for (const body of [leasedBody, codesBody, eventsBody]) mount(body, h('p', { class: 'list-empty' }, 'Дані недоступні'));
      }
    }
  }

  function renderStats(stats) {
    const value = (key) => (key === 'total' ? stats.total : key === 'codes_24h' ? stats.codes_24h : stats.by_status[key] || 0);
    mount(statsEl, STAT_CARDS.map((c) => {
      const v = value(c.key);
      const sub = c.key === 'total' ? `${fmtNum(stats.types.oauth2)} OAuth2 · ${fmtNum(stats.types.imap)} IMAP`
        : c.key === 'codes_24h' ? 'видано через API' : `${fmtPct(v, stats.total)} пулу`;
      return h('a', { class: `stat tone-${c.tone}`, href: c.href, 'aria-label': `${c.label}: ${fmtNum(v)}` },
        h('div', { class: 'stat-top' }, h('span', { class: 'stat-label' }, c.label), h('span', { class: 'stat-ico' }, icon(c.icon, { size: 15 }))),
        h('div', { class: 'stat-value' }, fmtNum(v)),
        h('div', { class: 'stat-sub' }, sub));
    }));
  }

  function renderDist(stats) {
    const total = stats.total || 0;
    const bar = h('div', { class: 'dist-bar', role: 'img', 'aria-label': STATUSES.map((s) => `${STATUS[s].plural}: ${stats.by_status[s] || 0}`).join(', ') });
    if (!total) bar.appendChild(h('span', { class: 'dist-seg is-empty' }));
    for (const s of STATUSES) {
      const n = stats.by_status[s] || 0;
      if (!n) continue;
      const seg = h('span', { class: `dist-seg st-bg-${s}`, title: `${STATUS[s].plural}: ${fmtNum(n)} (${fmtPct(n, total)})` });
      seg.style.flexGrow = String(n);
      bar.appendChild(seg);
    }
    const legend = h('div', { class: 'dist-legend' }, STATUSES.map((s) => {
      const n = stats.by_status[s] || 0;
      return h('a', { class: 'dist-item', href: `#/mailboxes?status=${s}` },
        h('span', { class: `dot dot-${s}` }), h('span', { class: 'dist-name' }, STATUS[s].plural),
        h('span', { class: 'dist-num' }, fmtNum(n)), h('span', { class: 'dist-pct' }, fmtPct(n, total)));
    }));
    const hs = stats.health;
    const metric = (label, n, dotCls, href) => h('a', { class: 'dist-metric', href }, h('span', { class: `hdot ${dotCls}` }), h('b', null, fmtNum(n)), label);
    const meta = h('div', { class: 'dist-meta' },
      h('div', { class: 'dist-meta-group' }, h('span', { class: 'dist-meta-label' }, 'Вхід'),
        metric('працює', hs.ok, 'hdot-ok', '#/mailboxes?health=ok'),
        metric('помилка', hs.error, 'hdot-error', '#/mailboxes?health=error'),
        metric('не перевірялись', hs.unknown, 'hdot-unknown', '#/mailboxes?health=unknown')),
      h('div', { class: 'dist-meta-group' }, h('span', { class: 'dist-meta-label' }, 'Типи'),
        h('a', { class: 'dist-metric', href: '#/mailboxes?type=oauth2' }, h('b', null, fmtNum(stats.types.oauth2)), 'OAuth2'),
        h('a', { class: 'dist-metric', href: '#/mailboxes?type=imap' }, h('b', null, fmtNum(stats.types.imap)), 'IMAP')));
    mount(distBody, bar, legend, meta);
  }

  function renderLeased(data) {
    const items = data.items.filter((m) => m.lease).sort((a, b) => Date.parse(a.lease.until) - Date.parse(b.lease.until));
    leasedCount.textContent = fmtNum(data.total);
    leasedCount.hidden = !data.total;
    if (!items.length) {
      mount(leasedBody, emptyState({ iconName: 'clock', title: 'Зараз нічого не орендовано', text: 'Коли BAS візьме скриньку з пулу, тут з’явиться відлік оренди.', compact: true }));
      return;
    }
    const shown = items.slice(0, 6);
    mount(leasedBody, shown.map((m) => h('a', { class: 'list-row list-link', href: mailboxHash(m.email) },
      h('div', { class: 'grow min0' },
        h('div', { class: 'list-main mono truncate', title: m.email }, m.email),
        h('div', { class: 'list-sub' }, icon('user', { size: 12 }), h('span', { class: 'truncate' }, m.lease.owner || 'без власника')),
        leaseBar(m.lease)),
      leaseCountdown(m.lease))),
    items.length > shown.length ? h('a', { class: 'list-more', href: '#/mailboxes?status=leased' }, `і ще ${items.length - shown.length}`) : null);
  }

  function renderCodes(items) {
    if (!items.length) {
      mount(codesBody, emptyState({ iconName: 'hash', title: 'Кодів ще не було', text: 'Коди з’являться, щойно в скриньки надійдуть листи з підтвердженням.', compact: true }));
      return;
    }
    mount(codesBody, items.map((m) => h('div', {
      class: 'list-row list-link', role: 'link', tabindex: '0', 'aria-label': `Відкрити ${m.email}`,
      onClick: () => navigate(mailboxHash(m.email)),
      onKeydown: (e) => { if (e.key === 'Enter') navigate(mailboxHash(m.email)); },
    },
    codeChip(m.last_code.code),
    h('div', { class: 'grow min0' },
      h('div', { class: 'list-main mono truncate', title: m.email }, m.email),
      h('div', { class: 'list-sub truncate', title: m.last_code.subject || '' }, m.last_code.subject || 'без теми')),
    timeEl(m.last_code.at, { cls: 'list-time' }))));
  }

  function renderEvents(items) {
    if (!items.length) {
      mount(eventsBody, emptyState({ iconName: 'activity', title: 'Подій ще немає', compact: true }));
      return;
    }
    mount(eventsBody, items.map((ev) => eventRow(ev, { compact: true })));
  }

  load();
  scope.poll(load, 10000);
  scope.interval(() => updateCountdowns(root), 1000);
  scope.add(on('mailboxes:changed', () => load()));
}

export function eventRow(ev, { compact = false } = {}) {
  const info = eventInfo(ev.kind);
  const subject = eventSubject(ev);
  const detail = eventDetail(ev);
  const actor = actorLabel(ev.actor);
  const subjectEl = subject
    ? (looksLikeEmail(subject)
      ? h('a', { class: 'ev-subject mono', href: mailboxHash(subject) }, subject)
      : h('span', { class: 'ev-subject' }, subject))
    : null;
  return h('div', { class: ['ev', compact && 'ev-compact'], dataset: { id: String(ev.id) } },
    h('span', { class: `ev-ico tone-${info.tone}` }, icon(info.icon, { size: 14 })),
    h('div', { class: 'ev-body' },
      h('div', { class: 'ev-line' }, h('span', { class: 'ev-label' }, info.label), subjectEl),
      detail || actor ? h('div', { class: 'ev-meta' },
        detail ? h('span', { class: 'ev-detail', title: detail }, detail) : null,
        actor ? h('span', { class: 'ev-actor' }, actor) : null) : null),
    timeEl(ev.at, { cls: 'ev-time' }));
}

function basCard() {
  const origin = location.origin;
  const field = (label, value, hint) => h('div', { class: 'copy-field-wrap' },
    h('div', { class: 'copy-field-label' }, label),
    h('div', { class: 'copy-field' }, h('code', { class: 'copy-field-value', title: value }, value), copyButton(value, { label: `Копіювати: ${label}`, what: label })),
    hint ? h('div', { class: 'field-hint' }, hint) : null);
  return card({
    title: 'Підключення BAS',
    sub: 'Скрипт BAS працює з хабом без змін',
    cls: 'ov-bas',
    action: headLink('Налаштувати', '#/api'),
    body: h('div', { class: 'bas-body' },
      field('Базова адреса', origin),
      field('mail_bridge_url', `${origin}/k/<KEY>`, 'Замініть <KEY> на API-ключ із пресетом BAS. Скрипт сам додає /code?email=…&timeout=120.')),
  });
}

function quickActions() {
  const tile = (iconName, title, text, onClick, tone) => h('button', { type: 'button', class: `qa tone-${tone}`, onClick },
    h('span', { class: 'qa-ico' }, icon(iconName, { size: 18 })),
    h('span', { class: 'qa-text' }, h('span', { class: 'qa-title' }, title), h('span', { class: 'qa-sub' }, text)));
  return h('section', { class: 'qa-grid', 'aria-label': 'Швидкі дії' },
    tile('upload', 'Імпорт', 'mails.txt, CSV або JSON', () => openImport(), 'accent'),
    tile('plus', 'Додати скриньку', 'Вручну або одним рядком', () => openMailboxForm(), 'green'),
    tile('shieldCheck', 'Перевірити всі', 'Вхід у кожну скриньку', async () => {
      const total = store.stats ? store.stats.total : 0;
      const ok = await confirmDialog({
        title: 'Перевірити всі скриньки?',
        message: `Сервер спробує увійти в кожну з ${fmtNum(total)} скриньок. Для великого пулу це може зайняти кілька хвилин; скриньки з помилкою авторизації стануть «Недійсними».`,
        confirmText: 'Перевірити',
      });
      if (ok) startCheck({ body: {}, label: 'Усі скриньки' });
    }, 'teal'),
    tile('download', 'Експорт', 'TXT для BAS, CSV, JSON', () => openExport({}), 'indigo'));
}
