// Activity log (#/activity): kind filter, day-grouped event feed, «Завантажити ще» and a live refresh of the top.
import { h, icon, mount, skel, timeEl, emptyState, errorBanner, openMenu, withBusy, uid } from '../ui.js';
import { api, isAbort } from '../api.js';
import { dayLabel, fmtNum, plural, parseTime, eventInfo, eventSubject, eventDetail, actorLabel, looksLikeEmail } from '../format.js';
import { replaceHash, mailboxHash } from '../router.js';

const STYLE_ID = 'pg-styles';
const PAGE = 50;
const REFRESH_MS = 15000;
const MAX_CATCH_UP_PAGES = 6;

const FILTERS = [
  { mask: '', label: 'Усі' },
  { mask: 'mailbox.*', label: 'Скриньки' },
  { mask: 'code.*', label: 'Коди' },
  { mask: 'lease.*', label: 'Оренда' },
  { mask: 'import', label: 'Імпорт' },
  { mask: 'key.*', label: 'Ключі' },
  { mask: 'auth.*', label: 'Вхід' },
];
const MORE_FILTERS = [
  { mask: 'pool.*', label: 'Пул BAS' },
  { mask: 'check.*', label: 'Перевірки' },
  { mask: 'webhook.*', label: 'Вебхуки' },
  { mask: 'settings.*', label: 'Налаштування' },
];

const SETTING_LABELS = {
  lease_ttl: 'TTL оренди', poll_interval: 'інтервал опитування', default_wait: 'очікування коду',
  code_markers: 'слова-маркери', code_patterns: 'регулярні вирази', auto_invalidate: 'автопозначення недійсних',
  watch_leased: 'стеження за орендою', watch_interval: 'інтервал стеження', messages_keep: 'кількість листів',
};

const clockFmt = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const clock = (value) => {
  const t = parseTime(value);
  return t === null ? '' : clockFmt.format(t);
};

function dayKey(value) {
  const t = parseTime(value);
  if (t === null) return '?';
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function maskFrom(route) {
  const raw = route && route.query ? String(route.query.kind || '').trim() : '';
  return /^[\w.*-]{1,40}$/.test(raw) ? raw : '';
}

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

// ---------------------------------------------------------------- rows

function subjectNode(ev) {
  const raw = String(ev.subject || '');
  if (!raw) return null;
  if (ev.kind === 'settings.updated') {
    return h('span', { class: 'ev-subject' }, raw.split(',').map((k) => SETTING_LABELS[k] || k).join(', '));
  }
  if (looksLikeEmail(raw)) return h('a', { class: 'ev-subject mono', href: mailboxHash(raw) }, raw);
  const mono = ev.kind.startsWith('auth.') || ev.kind === 'webhook.created';
  return h('span', { class: ['ev-subject', mono && 'mono'] }, eventSubject(ev));
}

function detailText(ev) {
  const text = eventDetail(ev);
  return ev.kind === 'pool.acquire' ? text.replace(/,\s*/g, ', ') : text;
}

function eventRow(ev, { fresh = false } = {}) {
  const info = eventInfo(ev.kind);
  const subject = subjectNode(ev);
  const detail = detailText(ev);
  const actor = actorLabel(ev.actor);
  return h('li', { class: ['pg-ev', fresh && 'pg-ev-new'], dataset: { id: String(ev.id) } },
    h('span', { class: `ev-ico tone-${info.tone}`, title: ev.kind }, icon(info.icon, { size: 14 })),
    h('div', { class: 'ev-line pg-ev-main' }, h('span', { class: 'ev-label', title: ev.kind }, info.label), subject),
    detail ? h('div', { class: 'pg-ev-detail', title: detail }, detail) : null,
    actor ? h('div', { class: 'pg-ev-actor' }, h('span', { class: 'pg-actor' }, actor)) : null,
    h('div', { class: 'pg-ev-time' }, timeEl(ev.at, { cls: 'pg-rel' }), h('span', { class: 'pg-ev-abs' }, clock(ev.at))));
}

function skeletonRows(n = 8) {
  return h('ul', { class: 'pg-evs', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('li', { class: 'pg-ev is-skel' },
    skel('skel-circle'),
    h('div', { class: 'pg-ev-main' }, skel('skel-line w-70')),
    h('div', { class: 'pg-ev-detail' }, skel('skel-line w-80')),
    h('div', { class: 'pg-ev-actor' }, skel('skel-line w-50')),
    h('div', { class: 'pg-ev-time' }, skel('skel-line w-80')))));
}

// ---------------------------------------------------------------- view

export function render(root, { scope, route }) {
  useStyles(root);

  const state = { mask: maskFrom(route), items: [], ids: new Set(), hasMore: false, loading: false, loadingMore: false, gen: 0 };
  let groups = [];
  let inflight = null;
  let refreshing = false;
  let alertKind = '';
  scope.add(() => { if (inflight) inflight.abort(); });

  // filter chips
  const chipByMask = new Map();
  const chipEls = FILTERS.map((f) => {
    const btn = h('button', {
      type: 'button', class: 'pg-chip', 'aria-pressed': 'false', title: f.mask ? `Події за маскою kind=${f.mask}` : 'Усі події',
      onClick: () => setMask(f.mask),
    }, h('span', { class: 'pg-chip-label' }, f.label), f.mask ? h('span', { class: 'pg-chip-mask' }, f.mask) : null);
    chipByMask.set(f.mask, btn);
    return btn;
  });
  const customMask = h('span', { class: 'pg-chip-mask' });
  const customChip = h('button', { type: 'button', class: 'pg-chip is-active', 'aria-pressed': 'true', hidden: true, title: 'Власна маска з адреси сторінки' },
    h('span', { class: 'pg-chip-label' }, 'Маска'), customMask);
  const moreLabel = h('span', { class: 'pg-chip-label' }, 'Ще');
  const moreChip = h('button', {
    type: 'button', class: 'pg-chip pg-chip-more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Інші типи подій',
    onClick: () => openMenu(moreChip, MORE_FILTERS.map((m) => ({
      label: m.label, hint: m.mask, checked: m.mask === state.mask, onSelect: () => setMask(m.mask),
    })), { align: 'start', label: 'Інші типи подій' }),
  }, moreLabel, icon('chevronDown', { size: 13 }));

  // live status + manual refresh
  const liveDot = h('span', { class: 'hdot hdot-unknown' });
  const liveText = h('span', { class: 'pg-live-text' }, 'Завантаження…');
  const live = h('span', { class: 'pg-live', title: `Журнал оновлюється сам кожні ${REFRESH_MS / 1000} с, поки вкладка відкрита` }, liveDot, liveText);
  const refreshBtn = h('button', {
    type: 'button', class: 'icon-btn pg-refresh', 'aria-label': 'Оновити журнал', title: 'Оновити зараз',
    onClick: () => refreshTop({ manual: true }),
  }, icon('refresh', { size: 16 }));
  const announce = h('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

  // body
  const alertSlot = h('div', { class: 'pg-alert' });
  const listEl = h('div', { class: 'pg-list' });
  const countEl = h('span', { class: 'pg-count' });
  const endEl = h('span', { class: 'pg-end' }, 'Це всі події');
  const moreBtn = h('button', { type: 'button', class: 'btn', onClick: () => loadMore() }, icon('arrowDown', { size: 15 }), 'Завантажити ще');
  const footError = h('div', { class: 'pg-foot-error' });
  const footEl = h('div', { class: 'pg-foot', hidden: true }, footError, h('div', { class: 'pg-foot-row' }, moreBtn, endEl, countEl));

  mount(root,
    h('p', { class: 'pg-lead' }, 'Усі зміни в хабі: скриньки, оренда, видані коди, ключі та входи в панель. Зберігаються останні 5000 подій.'),
    h('section', { class: 'card pg-feed', 'aria-label': 'Журнал подій' },
      h('div', { class: 'pg-feed-head' },
        h('div', { class: 'pg-chips', role: 'group', 'aria-label': 'Фільтр за типом події' }, chipEls, customChip, moreChip),
        h('div', { class: 'pg-tools' }, live, refreshBtn)),
      alertSlot, listEl, footEl, announce));

  // ------------------------------------------------------------ rendering helpers

  function syncChips() {
    for (const [mask, btn] of chipByMask) {
      const on = mask === state.mask;
      btn.setAttribute('aria-pressed', String(on));
      btn.classList.toggle('is-active', on);
    }
    const more = MORE_FILTERS.find((m) => m.mask === state.mask);
    moreChip.classList.toggle('is-active', Boolean(more));
    moreLabel.textContent = more ? more.label : 'Ще';
    moreChip.setAttribute('aria-label', more ? `Інші типи подій: ${more.label}` : 'Інші типи подій');
    const custom = !chipByMask.has(state.mask) && !more;
    customChip.hidden = !custom;
    customMask.textContent = custom ? state.mask : '';
  }

  function setLive(kind) {
    liveDot.className = `hdot ${kind === 'error' ? 'hdot-error' : kind === 'loading' ? 'hdot-unknown' : 'hdot-ok'}`;
    liveText.textContent = kind === 'error' ? 'Немає зв’язку' : kind === 'loading' ? 'Завантаження…' : `Оновлено ${clock(Date.now())}`;
  }

  function showAlert(kind, node) {
    if (kind && alertKind === kind) return;
    alertKind = kind;
    mount(alertSlot, node);
  }

  function makeGroup(key, at) {
    const headId = uid('pg-day');
    const head = h('h3', { class: 'pg-day', id: headId }, dayLabel(at));
    const list = h('ul', { class: 'pg-evs' });
    return { key, at, head, list, el: h('section', { class: 'pg-group', 'aria-labelledby': headId }, head, list) };
  }

  // Items arrive newest → oldest. 'top' keeps that order by inserting oldest-first above the current top.
  function insertItems(items, where, fresh) {
    if (where === 'top') {
      for (const ev of [...items].reverse()) {
        const key = dayKey(ev.at);
        let g = groups[0];
        if (!g || g.key !== key) {
          g = makeGroup(key, ev.at);
          groups.unshift(g);
          listEl.prepend(g.el);
        }
        g.list.prepend(eventRow(ev, { fresh }));
      }
      return;
    }
    for (const ev of items) {
      const key = dayKey(ev.at);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) {
        g = makeGroup(key, ev.at);
        groups.push(g);
        listEl.appendChild(g.el);
      }
      g.list.appendChild(eventRow(ev));
    }
  }

  // Keeps what the user is reading in place when rows land above the viewport (browsers without scroll anchoring).
  function keepScroll(change) {
    if (window.scrollY < 4) {
      change();
      return;
    }
    const topbar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 60;
    const anchor = [...listEl.querySelectorAll('.pg-ev')].find((el) => el.getBoundingClientRect().bottom > topbar + 4);
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    change();
    if (!anchor) return;
    const delta = anchor.getBoundingClientRect().top - before;
    if (Math.abs(delta) > 0.5) window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
  }

  function emptyBlock() {
    if (state.mask) {
      return emptyState({
        iconName: 'filter', title: 'Немає подій за цим фільтром', text: 'Спробуйте інший тип подій або покажіть усе.',
        actions: [h('button', { type: 'button', class: 'btn', onClick: () => setMask('') }, 'Показати всі події')],
      });
    }
    return emptyState({
      iconName: 'activity', title: 'Подій ще немає',
      text: 'Тут з’являтимуться імпорт, оренда, видані коди, зміни статусів і входи в панель.',
    });
  }

  function setItems(items) {
    state.items = items;
    state.ids = new Set(items.map((ev) => ev.id));
    state.hasMore = items.length >= PAGE;
  }

  function renderList() {
    groups = [];
    mount(listEl);
    if (!state.items.length) {
      mount(listEl, emptyBlock());
      return;
    }
    insertItems(state.items, 'bottom', false);
  }

  function renderFoot() {
    const n = state.items.length;
    footEl.hidden = n === 0;
    countEl.textContent = `Показано ${fmtNum(n)} ${plural(n, 'подію', 'події', 'подій')}`;
    moreBtn.hidden = !state.hasMore;
    endEl.hidden = state.hasMore;
  }

  // ------------------------------------------------------------ data

  async function load() {
    const gen = ++state.gen;
    if (inflight) inflight.abort();
    const ctrl = new AbortController();
    inflight = ctrl;
    state.loading = true;
    state.loadingMore = false;
    alertKind = '';
    mount(alertSlot);
    mount(footError);
    footEl.hidden = true;
    mount(listEl, skeletonRows());
    listEl.setAttribute('aria-busy', 'true');
    setLive('loading');
    try {
      const res = await api.get('/api/v1/events', { limit: PAGE, kind: state.mask }, { signal: ctrl.signal });
      if (gen !== state.gen || scope.disposed) return;
      setItems(res.items);
      renderList();
      renderFoot();
      setLive('ok');
    } catch (err) {
      if (isAbort(err) || gen !== state.gen || scope.disposed) return;
      mount(listEl);
      showAlert('load', errorBanner({ title: 'Не вдалося завантажити журнал', message: err.message, onRetry: () => load() }));
      setLive('error');
    } finally {
      if (gen === state.gen) {
        state.loading = false;
        listEl.removeAttribute('aria-busy');
      }
    }
  }

  // New events since the newest one we know; walks back page by page when more than a page arrived at once.
  async function fetchNewer(gen) {
    const topId = state.items[0].id;
    const found = [];
    let before;
    for (let i = 0; i < MAX_CATCH_UP_PAGES; i += 1) {
      const res = await api.get('/api/v1/events', { limit: PAGE, before, kind: state.mask }, { signal: scope.signal });
      if (gen !== state.gen) return null;
      const page = res.items;
      for (const ev of page) if (ev.id > topId) found.push(ev);
      const last = page[page.length - 1];
      if (page.length < PAGE || last.id <= topId) return { items: found };
      before = last.id;
    }
    return { items: found, gap: true };
  }

  async function refreshTop({ manual = false } = {}) {
    if (state.loading || refreshing) return;
    const gen = state.gen;
    refreshing = true;
    refreshBtn.classList.add('is-spinning');
    try {
      if (!state.items.length) {
        // Nothing shown yet (empty log or failed first load): treat the answer as the first page.
        const res = await api.get('/api/v1/events', { limit: PAGE, kind: state.mask }, { signal: scope.signal });
        if (gen !== state.gen || scope.disposed) return;
        if (res.items.length) {
          setItems(res.items);
          renderList();
          renderFoot();
        }
        showAlert('', null);
        setLive('ok');
        return;
      }
      const found = await fetchNewer(gen);
      if (!found || gen !== state.gen || scope.disposed) return;
      if (found.gap) {
        load();
        return;
      }
      const fresh = found.items.filter((ev) => !state.ids.has(ev.id));
      if (fresh.length) {
        for (const ev of fresh) state.ids.add(ev.id);
        state.items = [...fresh, ...state.items];
        keepScroll(() => insertItems(fresh, 'top', true));
        renderFoot();
        announce.textContent = `Нових подій: ${fresh.length}`;
      }
      for (const g of groups) g.head.textContent = dayLabel(g.at);
      showAlert('', null);
      setLive('ok');
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      setLive('error');
      if (state.items.length) {
        showAlert('refresh', errorBanner({ title: 'Не вдалося оновити журнал', message: err.message, onRetry: () => refreshTop({ manual: true }) }));
      } else if (manual) {
        showAlert('load', errorBanner({ title: 'Не вдалося завантажити журнал', message: err.message, onRetry: () => load() }));
      }
    } finally {
      refreshing = false;
      refreshBtn.classList.remove('is-spinning');
    }
  }

  async function loadMore() {
    if (state.loadingMore || state.loading || !state.hasMore || !state.items.length) return;
    const gen = state.gen;
    const before = state.items[state.items.length - 1].id;
    state.loadingMore = true;
    mount(footError);
    try {
      await withBusy(moreBtn, async () => {
        const res = await api.get('/api/v1/events', { limit: PAGE, before, kind: state.mask }, { signal: scope.signal });
        if (gen !== state.gen || scope.disposed) return;
        const older = res.items.filter((ev) => !state.ids.has(ev.id));
        for (const ev of older) state.ids.add(ev.id);
        state.items.push(...older);
        state.hasMore = res.items.length >= PAGE;
        insertItems(older, 'bottom', false);
        renderFoot();
      });
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      mount(footError, errorBanner({ title: 'Не вдалося завантажити ще', message: err.message, onRetry: () => loadMore() }));
    } finally {
      state.loadingMore = false;
    }
  }

  function setMask(mask) {
    if (mask === state.mask) return;
    state.mask = mask;
    syncChips();
    replaceHash(mask ? `#/activity?kind=${encodeURIComponent(mask)}` : '#/activity');
    load();
  }

  syncChips();
  load();
  scope.poll(() => refreshTop(), REFRESH_MS);

  return {
    update(next) {
      setMask(maskFrom(next));
    },
  };
}
