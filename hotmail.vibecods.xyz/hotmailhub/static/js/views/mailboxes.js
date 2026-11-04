// Mailboxes (#/mailboxes, #/mailboxes/<email>): filters, server-side sort/pagination, selection, bulk actions.
import {
  h, icon, mount, timeEl, skel, emptyState, errorBanner, debounce, openMenu, confirmDialog, toast, copy,
  selectEl, openModal, overlayOpen, withBusy, field,
} from '../ui.js';
import { api, isAbort, mbPath } from '../api.js';
import { STATUS, STATUSES, HEALTH, fmtNum, nBoxes, statusLabel } from '../format.js';
import { statusPill, statusMenuItems, healthCell, codeChip, tagChip, chipInput, providerText } from '../components.js';
import { store, on, refreshStats, mailboxesChanged } from '../store.js';
import { navigate, replaceHash, mailboxHash, leaveTo } from '../router.js';
import { openMailboxDrawer } from './drawer.js';
import { openMailboxForm } from './mailbox-form.js';
import { openImport } from './import.js';
import { openExport } from './export.js';
import { startCheck } from './check-job.js';

const SORT_KEYS = ['email', 'status', 'checked_at', 'last_code_at', 'uses', 'updated_at'];
const SIZES = [25, 50, 100];
const SIZE_KEY = 'hh-page-size';

function storedSize() {
  try {
    const v = parseInt(localStorage.getItem(SIZE_KEY), 10);
    return SIZES.includes(v) ? v : 50;
  } catch {
    return 50;
  }
}

function stateFromQuery(query) {
  const sort = SORT_KEYS.includes(query.sort) ? query.sort : 'updated_at';
  const size = parseInt(query.size, 10);
  return {
    q: (query.q || '').trim(),
    status: (query.status || '').split(',').filter((s) => STATUSES.includes(s)),
    type: ['oauth2', 'imap'].includes(query.type) ? query.type : '',
    health: ['ok', 'error', 'unknown'].includes(query.health) ? query.health : '',
    tag: (query.tag || '').trim().toLowerCase(),
    sort,
    order: query.order === 'asc' || query.order === 'desc' ? query.order : (sort === 'email' || sort === 'status' ? 'asc' : 'desc'),
    page: Math.max(1, parseInt(query.page, 10) || 1),
    size: SIZES.includes(size) ? size : storedSize(),
  };
}

function queryString(state) {
  const sp = new URLSearchParams();
  if (state.q) sp.set('q', state.q);
  if (state.status.length) sp.set('status', state.status.join(','));
  if (state.type) sp.set('type', state.type);
  if (state.health) sp.set('health', state.health);
  if (state.tag) sp.set('tag', state.tag);
  if (state.sort !== 'updated_at' || state.order !== 'desc') {
    sp.set('sort', state.sort);
    sp.set('order', state.order);
  }
  if (state.page > 1) sp.set('page', String(state.page));
  if (state.size !== storedSize()) sp.set('size', String(state.size));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** Non-empty filter fields of the current view (for export/check/bulk). */
function filterOf(state) {
  const f = {};
  if (state.q) f.q = state.q;
  if (state.status.length) f.status = state.status.join(',');
  if (state.type) f.type = state.type;
  if (state.tag) f.tag = state.tag;
  if (state.health) f.health = state.health;
  return f;
}

export function render(root, { scope, route }) {
  let state = stateFromQuery(route.query);
  let data = null;
  let reqId = 0;
  const selected = new Set();
  let allMatching = false;
  let lastIndex = null;
  let drawerCtl = null;
  const sortHeaders = [];

  // ------------------------------------------------------------ toolbar
  const searchInput = h('input', {
    type: 'search', class: 'input', value: state.q, placeholder: 'Пошук: email, нотатка або тег', autocomplete: 'off',
    spellcheck: 'false', 'aria-label': 'Пошук скриньок', 'data-page-search': '', enterkeyhint: 'search',
  });
  const searchClear = h('button', { type: 'button', class: 'icon-btn icon-btn-sm search-clear', 'aria-label': 'Очистити пошук', hidden: !state.q }, icon('x', { size: 14 }));
  const applySearchSoon = debounce((v) => applySearch(v), 320);
  searchInput.addEventListener('input', () => {
    searchClear.hidden = !searchInput.value;
    applySearchSoon(searchInput.value.trim());
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      applySearchSoon.cancel();
      applySearch(searchInput.value.trim());
    } else if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      clearSearch();
    }
  });
  searchClear.addEventListener('click', () => {
    clearSearch();
    searchInput.focus();
  });
  scope.add(() => applySearchSoon.cancel());

  const typeSel = selectEl([['', 'Усі типи'], ['oauth2', 'OAuth2'], ['imap', 'IMAP']], { value: state.type, label: 'Тип скриньки', onChange: (v) => setFilter({ type: v }) });
  const healthSel = selectEl([['', 'Будь-який стан входу'], ['ok', 'Вхід працює'], ['error', 'Помилка входу'], ['unknown', 'Не перевірялись']],
    { value: state.health, label: 'Стан входу', onChange: (v) => setFilter({ health: v }) });

  const checkBtn = h('button', { type: 'button', class: 'btn', title: 'Перевірити вхід у всі скриньки за поточним фільтром', onClick: checkByFilter },
    icon('shieldCheck', { size: 16 }), h('span', { class: 'btn-label' }, 'Перевірити всі'));
  const exportBtn = h('button', { type: 'button', class: 'btn', onClick: () => openExport({ filter: filterOf(state) }) },
    icon('download', { size: 16 }), h('span', { class: 'btn-label' }, 'Експорт'));

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search-box' }, icon('search', { size: 16, cls: 'search-box-ico' }), searchInput, searchClear),
    h('div', { class: 'toolbar-filters' }, typeSel.wrap, healthSel.wrap),
    h('div', { class: 'toolbar-spacer' }),
    h('div', { class: 'toolbar-actions' }, checkBtn, exportBtn));

  const chipsEl = h('div', { class: 'chips', role: 'group', 'aria-label': 'Фільтр за статусом (Ctrl+клік — кілька)' });
  const activeEl = h('div', { class: 'active-filters', hidden: true });

  // ------------------------------------------------------------ table
  const headCheck = h('input', { type: 'checkbox', class: 'checkbox', 'aria-label': 'Вибрати всі на сторінці' });
  headCheck.addEventListener('change', () => toggleAllOnPage(headCheck.checked));
  const sortTh = (label, key, cls, title = '') => {
    const btn = h('button', { type: 'button', class: 'th-sort', title: title || `Сортувати: ${label}`, onClick: () => setSort(key) });
    const th = h('th', { class: cls, scope: 'col', 'aria-sort': 'none' }, btn);
    sortHeaders.push({ key, label, th, btn });
    return th;
  };
  const thead = h('thead', null, h('tr', null,
    h('th', { class: 'c-check', scope: 'col' }, headCheck),
    sortTh('Email', 'email', 'c-email'),
    sortTh('Статус', 'status', 'c-status'),
    sortTh('Здоров’я', 'checked_at', 'c-health', 'Сортувати за часом останньої перевірки входу'),
    sortTh('Останній код', 'last_code_at', 'c-code'),
    h('th', { class: 'c-msgs num', scope: 'col', title: 'Листів у скриньці за останньою перевіркою' }, 'Листів'),
    sortTh('Видач', 'uses', 'c-uses num', 'Скільки разів скриньку видавали BAS'),
    h('th', { class: 'c-note', scope: 'col' }, 'Нотатка'),
    sortTh('Оновлено', 'updated_at', 'c-updated'),
    h('th', { class: 'c-actions', scope: 'col' }, h('span', { class: 'sr-only' }, 'Дії'))));
  const tbody = h('tbody');
  const table = h('table', { class: 'table mtable' }, thead, tbody);
  const selectBanner = h('div', { class: 'select-banner', hidden: true, role: 'status' });
  const pager = h('div', { class: 'pager', hidden: true });
  const loadBar = h('div', { class: 'load-bar', 'aria-hidden': 'true' });
  const tableCard = h('div', { class: 'card table-card' }, loadBar, selectBanner, h('div', { class: 'table-scroll' }, table), pager);
  const alertSlot = h('div', { class: 'alert-slot' });
  const bulkBar = h('div', { class: 'bulkbar', role: 'region', 'aria-label': 'Дії з вибраними скриньками', hidden: true });

  mount(root, toolbar, chipsEl, activeEl, alertSlot, tableCard, bulkBar);

  // ------------------------------------------------------------ state changes
  function commit({ keepSelection = false } = {}) {
    if (!keepSelection) clearSelection(false);
    replaceHash((drawerCtl ? mailboxHash(drawerCtl.email) : '#/mailboxes') + queryString(state));
    syncControls();
    load();
  }

  function setFilter(patch) {
    Object.assign(state, patch, { page: 1 });
    commit();
  }

  function applySearch(q) {
    if (q === state.q) return;
    setFilter({ q });
  }

  function clearSearch() {
    applySearchSoon.cancel();
    searchInput.value = '';
    searchClear.hidden = true;
    applySearch('');
  }

  function resetFilters() {
    searchInput.value = '';
    searchClear.hidden = true;
    setFilter({ q: '', status: [], type: '', health: '', tag: '' });
  }

  function setSort(key) {
    if (state.sort === key) state.order = state.order === 'asc' ? 'desc' : 'asc';
    else {
      state.sort = key;
      state.order = key === 'email' || key === 'status' ? 'asc' : 'desc';
    }
    state.page = 1;
    commit();
  }

  function goPage(page) {
    state.page = page;
    commit();
    const top = tableCard.getBoundingClientRect().top + window.scrollY - 80;
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
  }

  function toggleStatus(s, multi) {
    let next;
    if (multi) next = state.status.includes(s) ? state.status.filter((x) => x !== s) : [...state.status, s];
    else next = state.status.length === 1 && state.status[0] === s ? [] : [s];
    setFilter({ status: STATUSES.filter((x) => next.includes(x)) });
  }

  function hasFilters() {
    return Object.keys(filterOf(state)).length > 0;
  }

  function syncControls() {
    if (document.activeElement !== searchInput) {
      searchInput.value = state.q;
      searchClear.hidden = !state.q;
    }
    typeSel.select.value = state.type;
    healthSel.select.value = state.health;
    renderChips();
    renderActive();
    renderSortHeaders();
  }

  function renderChips() {
    const stats = store.stats;
    const count = (n) => (stats ? h('span', { class: 'chip-count' }, fmtNum(n)) : null);
    mount(chipsEl,
      h('button', { type: 'button', class: 'chip', 'aria-pressed': String(!state.status.length), onClick: () => setFilter({ status: [] }) },
        'Усі', count(stats ? stats.total : 0)),
      STATUSES.map((s) => h('button', {
        type: 'button', class: `chip st-${s}`, 'aria-pressed': String(state.status.includes(s)),
        title: `${STATUS[s].hint}. Ctrl+клік — додати до вибору`,
        onClick: (e) => toggleStatus(s, e.ctrlKey || e.metaKey || e.shiftKey),
      }, h('span', { class: 'dot' }), STATUS[s].plural, count(stats ? stats.by_status[s] || 0 : 0))));
  }

  function renderActive() {
    const items = [];
    if (state.q) items.push(['Пошук', `«${state.q}»`, () => clearSearch()]);
    if (state.status.length) items.push(['Статус', state.status.map((s) => statusLabel(s).toLowerCase()).join(', '), () => setFilter({ status: [] })]);
    if (state.type) items.push(['Тип', state.type === 'oauth2' ? 'OAuth2' : 'IMAP', () => setFilter({ type: '' })]);
    if (state.health) items.push(['Вхід', HEALTH[state.health].short.toLowerCase(), () => setFilter({ health: '' })]);
    if (state.tag) items.push(['Тег', state.tag, () => setFilter({ tag: '' })]);
    activeEl.hidden = !items.length;
    mount(activeEl,
      h('span', { class: 'af-label' }, icon('filter', { size: 13 }), 'Фільтри'),
      items.map(([k, v, rm]) => h('span', { class: 'af-chip' }, h('span', { class: 'af-key' }, `${k}:`), h('b', null, v),
        h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': `Прибрати фільтр «${k}»`, onClick: rm }, icon('x', { size: 12 })))),
      items.length > 1 ? h('button', { type: 'button', class: 'link-btn af-reset', onClick: resetFilters }, 'Скинути всі') : null);
  }

  function renderSortHeaders() {
    for (const { key, label, th, btn } of sortHeaders) {
      const active = state.sort === key;
      th.setAttribute('aria-sort', active ? (state.order === 'asc' ? 'ascending' : 'descending') : 'none');
      mount(btn, label, icon(active ? (state.order === 'asc' ? 'arrowUp' : 'arrowDown') : 'sort', { size: 12, cls: 'sort-ico' }));
    }
  }

  // ------------------------------------------------------------ loading
  function showSkeleton() {
    mount(tbody, Array.from({ length: 8 }, () => h('tr', { class: 'is-skel' },
      h('td', { class: 'c-check' }, skel('skel-box')),
      h('td', { class: 'c-email' }, skel('skel-line w-70'), skel('skel-line sm w-40')),
      h('td', { class: 'c-status' }, skel('skel-pill')),
      h('td', { class: 'c-health' }, skel('skel-line w-70')),
      h('td', { class: 'c-code' }, skel('skel-line w-60')),
      h('td', { class: 'c-msgs' }, skel('skel-line w-50')),
      h('td', { class: 'c-uses' }, skel('skel-line w-50')),
      h('td', { class: 'c-note' }, skel('skel-line w-80')),
      h('td', { class: 'c-updated' }, skel('skel-line w-60')),
      h('td', { class: 'c-actions' }))));
  }

  async function load({ silent = false } = {}) {
    const id = ++reqId;
    if (!silent) {
      if (data) tableCard.classList.add('is-loading');
      else showSkeleton();
    }
    try {
      const res = await api.get('/api/v1/mailboxes', {
        ...filterOf(state), sort: state.sort, order: state.order, limit: state.size, offset: (state.page - 1) * state.size,
      }, { signal: scope.signal });
      if (id !== reqId || scope.disposed) return;
      if (!res.items.length && res.total > 0 && state.page > 1) {
        state.page = Math.max(1, Math.ceil(res.total / state.size));
        commit({ keepSelection: true });
        return;
      }
      data = res;
      mount(alertSlot);
      renderTable();
    } catch (err) {
      if (isAbort(err) || id !== reqId || scope.disposed) return;
      if (silent) return;
      mount(alertSlot, errorBanner({ title: 'Не вдалося завантажити скриньки', message: err.message, onRetry: () => load() }));
      if (!data) mount(tbody);
    } finally {
      if (id === reqId) tableCard.classList.remove('is-loading');
    }
  }

  function renderTable() {
    const { items, total } = data;
    if (!items.length) {
      pager.hidden = true;
      thead.hidden = true;
      const empty = hasFilters()
        ? emptyState({
          iconName: 'search', title: 'Нічого не знайдено', text: 'Немає скриньок, що відповідають фільтрам. Змініть запит або скиньте фільтри.',
          actions: [h('button', { type: 'button', class: 'btn', onClick: resetFilters }, icon('x', { size: 15 }), 'Скинути фільтри')],
        })
        : emptyState({
          iconName: 'inbox', title: 'Скриньок ще немає', text: 'Імпортуйте список (mails.txt, CSV або JSON) або додайте скриньку вручну — після цього BAS зможе брати їх із пулу.',
          actions: [
            h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openImport() }, icon('upload', { size: 15 }), 'Імпорт'),
            h('button', { type: 'button', class: 'btn', onClick: () => openMailboxForm() }, icon('plus', { size: 15 }), 'Додати скриньку'),
          ],
        });
      mount(tbody, h('tr', { class: 'empty-row' }, h('td', { colspan: '10' }, empty)));
      syncSelection();
      return;
    }
    thead.hidden = false;
    mount(tbody, items.map((m, i) => row(m, i)));
    pager.hidden = false;
    renderPager(total);
    syncSelection();
  }

  function row(m, index) {
    const on = allMatching || selected.has(m.email);
    const cb = h('input', { type: 'checkbox', class: 'checkbox', checked: on, 'aria-label': `Вибрати ${m.email}` });
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      onRowCheck(index, cb.checked, e.shiftKey);
    });
    const menuBtn = h('button', { type: 'button', class: 'icon-btn row-menu', 'aria-haspopup': 'menu', 'aria-label': `Дії: ${m.email}` }, icon('more', { size: 18 }));
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      rowMenu(menuBtn, m);
    });
    const pill = statusPill(m.status, {
      onClick: (e) => {
        e.stopPropagation();
        openMenu(e.currentTarget, statusMenuItems(m.status, (s) => changeStatus([m.email], s)), { label: 'Змінити статус', align: 'start' });
      },
    });
    const tr = h('tr', { class: on ? 'is-selected' : '', dataset: { email: m.email } },
      h('td', { class: 'c-check' }, cb),
      h('td', { class: 'c-email' }, h('div', { class: 'email-cell' },
        h('a', {
          class: 'email-link mono', href: mailboxHash(m.email, queryString(state)), title: m.email,
          onClick: (e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            openDrawer(m.email);
          },
        }, m.email),
        h('div', { class: 'email-meta' },
          h('span', { class: 'provider' }, providerText(m)),
          m.tags.map((t) => tagChip(t, { onClick: (tag) => setFilter({ tag }), active: state.tag === t }))))),
      h('td', { class: 'c-status' }, pill),
      h('td', { class: 'c-health' }, healthCell(m.health)),
      h('td', { class: 'c-code' }, m.last_code
        ? h('div', { class: 'code-cell' }, codeChip(m.last_code.code, { size: 'sm', title: `${m.last_code.subject || 'Код'} — натисніть, щоб скопіювати` }), timeEl(m.last_code.at, { cls: 'code-age' }))
        : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'c-msgs num' }, m.health && m.health.messages !== null && m.health.messages !== undefined ? fmtNum(m.health.messages) : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'c-uses num' }, fmtNum(m.uses)),
      h('td', { class: 'c-note' }, m.note ? h('span', { class: 'note', title: m.note }, m.note) : h('span', { class: 'muted' }, '—')),
      h('td', { class: 'c-updated' }, timeEl(m.updated_at)),
      h('td', { class: 'c-actions' }, menuBtn));
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a, input, label')) return;
      if (String(window.getSelection())) return;
      openDrawer(m.email);
    });
    return tr;
  }

  function renderPager(total) {
    const pages = Math.max(1, Math.ceil(total / state.size));
    const from = (state.page - 1) * state.size + 1;
    const to = Math.min(total, state.page * state.size);
    const sizeSel = selectEl(SIZES.map((n) => [String(n), String(n)]), {
      value: String(state.size), label: 'Рядків на сторінці',
      onChange: (v) => {
        state.size = parseInt(v, 10);
        try { localStorage.setItem(SIZE_KEY, v); } catch { /* ignore */ }
        state.page = 1;
        commit();
      },
    });
    mount(pager,
      h('div', { class: 'pager-range' }, h('b', null, `${fmtNum(from)}–${fmtNum(to)}`), ` з ${fmtNum(total)}`),
      h('div', { class: 'pager-controls' },
        h('span', { class: 'pager-size' }, h('span', { class: 'pager-size-label' }, 'На сторінці'), sizeSel.wrap),
        h('span', { class: 'pager-pages' }, `${fmtNum(state.page)} / ${fmtNum(pages)}`),
        h('button', { type: 'button', class: 'icon-btn pager-btn', 'aria-label': 'Попередня сторінка', disabled: state.page <= 1, onClick: () => goPage(state.page - 1) }, icon('chevronLeft', { size: 17 })),
        h('button', { type: 'button', class: 'icon-btn pager-btn', 'aria-label': 'Наступна сторінка', disabled: state.page >= pages, onClick: () => goPage(state.page + 1) }, icon('chevronRight', { size: 17 }))));
  }

  // ------------------------------------------------------------ selection
  function onRowCheck(index, checked, shift) {
    const items = data.items;
    if (allMatching) {
      allMatching = false;
      items.forEach((m) => selected.add(m.email));
    }
    if (shift && lastIndex !== null && lastIndex !== index) {
      const [a, b] = [Math.min(lastIndex, index), Math.max(lastIndex, index)];
      for (let i = a; i <= b; i += 1) {
        if (checked) selected.add(items[i].email);
        else selected.delete(items[i].email);
      }
    } else if (checked) selected.add(items[index].email);
    else selected.delete(items[index].email);
    lastIndex = index;
    syncSelection();
  }

  function toggleAllOnPage(checked) {
    allMatching = false;
    for (const m of data ? data.items : []) {
      if (checked) selected.add(m.email);
      else selected.delete(m.email);
    }
    syncSelection();
  }

  function clearSelection(sync = true) {
    selected.clear();
    allMatching = false;
    lastIndex = null;
    if (sync) syncSelection();
  }

  const selCount = () => (allMatching ? (data ? data.total : 0) : selected.size);

  function syncSelection() {
    const items = data ? data.items : [];
    for (const tr of tbody.querySelectorAll('tr[data-email]')) {
      const on = allMatching || selected.has(tr.dataset.email);
      tr.classList.toggle('is-selected', on);
      const cb = tr.querySelector('.c-check input');
      if (cb) cb.checked = on;
    }
    const onPage = items.filter((m) => selected.has(m.email)).length;
    headCheck.checked = items.length > 0 && (allMatching || onPage === items.length);
    headCheck.indeterminate = !allMatching && onPage > 0 && onPage < items.length;
    headCheck.disabled = !items.length;
    renderSelectBanner(items, onPage);
    renderBulk();
  }

  function renderSelectBanner(items, onPage) {
    const total = data ? data.total : 0;
    if (allMatching) {
      selectBanner.hidden = false;
      mount(selectBanner, icon('checkCircle', { size: 15 }),
        h('span', null, `Вибрано всі ${nBoxes(total)}${hasFilters() ? ' за поточним фільтром' : ''}.`),
        h('button', { type: 'button', class: 'link-btn', onClick: () => clearSelection() }, 'Скасувати вибір'));
    } else if (items.length && onPage === items.length && total > items.length) {
      selectBanner.hidden = false;
      mount(selectBanner, h('span', null, `Вибрано всі ${fmtNum(items.length)} на цій сторінці.`),
        h('button', {
          type: 'button', class: 'link-btn',
          onClick: () => {
            allMatching = true;
            syncSelection();
          },
        }, `Вибрати всі ${nBoxes(total)}${hasFilters() ? ' за фільтром' : ''}`));
    } else selectBanner.hidden = true;
  }

  function renderBulk() {
    const n = selCount();
    bulkBar.hidden = n === 0;
    if (!n) return;
    const b = (iconName, label, onClick, cls = 'btn btn-ghost btn-sm') => h('button', { type: 'button', class: cls, onClick }, icon(iconName, { size: 15 }), h('span', { class: 'btn-label' }, label));
    const statusBtn = b('dotCircle', 'Статус', () => openMenu(statusBtn, statusMenuItems(null, bulkStatus), { label: 'Змінити статус вибраних', align: 'start' }));
    statusBtn.setAttribute('aria-haspopup', 'menu');
    statusBtn.appendChild(icon('chevronDown', { size: 13, cls: 'btn-caret' }));
    mount(bulkBar,
      h('span', { class: 'bulk-count' }, h('span', { class: 'bulk-num' }, fmtNum(n)), allMatching ? 'вибрано (усі за фільтром)' : 'вибрано'),
      h('span', { class: 'bulk-sep' }),
      b('shieldCheck', 'Перевірити', bulkCheck),
      statusBtn,
      b('tag', 'Теги', bulkTags),
      b('download', 'Експорт', bulkExport),
      b('trash', 'Видалити', bulkDelete, 'btn btn-danger-ghost btn-sm'),
      h('span', { class: 'bulk-sep' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Скасувати вибір', title: 'Скасувати вибір (Esc)', onClick: () => clearSelection() }, icon('x', { size: 16 })));
  }

  /** Body fragment addressing the selection for POST /mailboxes/bulk. */
  function bulkTarget() {
    if (!allMatching) return { emails: [...selected] };
    const f = filterOf(state);
    return Object.keys(f).length ? { filter: f } : { all: true };
  }

  // ------------------------------------------------------------ actions
  function openDrawer(email) {
    navigate(mailboxHash(email, queryString(state)));
  }

  function syncDrawer(email) {
    if (!email) {
      if (drawerCtl) {
        drawerCtl.close();
        drawerCtl = null;
      }
      return;
    }
    if (drawerCtl && drawerCtl.email === email) return;
    if (drawerCtl) drawerCtl.close();
    drawerCtl = openMailboxDrawer(email, {
      onDismiss: () => {
        drawerCtl = null;
        leaveTo(`#/mailboxes${queryString(state)}`);
      },
      onChanged: () => load({ silent: true }),
      onRenamed: (newEmail) => {
        drawerCtl = null;
        navigate(mailboxHash(newEmail, queryString(state)), { replace: true });
      },
      onDeleted: () => {
        drawerCtl = null;
        leaveTo(`#/mailboxes${queryString(state)}`);
      },
    });
  }
  scope.add(() => {
    if (drawerCtl) drawerCtl.close();
    drawerCtl = null;
  });

  function rowMenu(anchor, m) {
    openMenu(anchor, [
      { label: 'Відкрити', icon: 'mailOpen', onSelect: () => openDrawer(m.email) },
      { label: 'Перевірити вхід', icon: 'shieldCheck', onSelect: () => checkOne(m.email) },
      { label: 'Редагувати', icon: 'edit', onSelect: () => openMailboxForm({ email: m.email }) },
      { label: 'Копіювати email', icon: 'copy', onSelect: () => copy(m.email, 'Email') },
      {
        label: 'Змінити статус…', icon: 'dotCircle',
        onSelect: () => openMenu(anchor, statusMenuItems(m.status, (s) => changeStatus([m.email], s)), { label: 'Змінити статус' }),
      },
      '-',
      { label: 'Видалити', icon: 'trash', danger: true, onSelect: () => deleteOne(m.email) },
    ], { label: `Дії: ${m.email}` });
  }

  async function checkOne(email) {
    const dismiss = toast.info(`Перевіряємо вхід у ${email}…`, { timeout: 0 });
    try {
      const r = await api.post(mbPath(email, '/check'), {});
      dismiss();
      if (r.ok) toast.success(`Вхід працює${r.messages !== null && r.messages !== undefined ? ` · листів: ${fmtNum(r.messages)}` : ''} · ${fmtNum(r.ms)} мс`, { title: email });
      else toast.error(`${r.kind === 'temp' ? 'Тимчасова помилка' : 'Помилка входу'}: ${r.error}${r.status === 'invalid' ? ' (статус → «Недійсна»)' : ''}`, { title: email });
      mailboxesChanged('check');
    } catch (err) {
      dismiss();
      toast.error(err.message, { title: email });
    }
  }

  async function changeStatus(emails, status) {
    try {
      if (emails.length === 1) await api.post(mbPath(emails[0], '/status'), { status });
      else await api.post('/api/v1/mailboxes/bulk', { action: 'status', status, emails });
      toast.success(emails.length === 1 ? `${emails[0]} → «${statusLabel(status)}»` : `Статус «${statusLabel(status)}» — ${nBoxes(emails.length)}`);
      mailboxesChanged('status');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function deleteOne(email) {
    const ok = await confirmDialog({
      title: 'Видалити скриньку?', danger: true, confirmText: 'Видалити',
      message: `${email} буде видалено разом зі збереженими листами. Цю дію не можна скасувати.`,
    });
    if (!ok) return;
    try {
      await api.del(mbPath(email));
      toast.success(`${email} видалено`);
      selected.delete(email);
      mailboxesChanged('delete');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function checkByFilter() {
    const total = data ? data.total : 0;
    if (!total) {
      toast.info('Немає скриньок для перевірки за поточним фільтром.');
      return;
    }
    const filtered = hasFilters();
    const ok = await confirmDialog({
      title: filtered ? 'Перевірити скриньки за фільтром?' : 'Перевірити всі скриньки?',
      message: `Сервер спробує увійти в ${nBoxes(total)}${filtered ? ' за поточним фільтром' : ''}. Для великої кількості це займе кілька хвилин; скриньки з помилкою авторизації стануть «Недійсними».`,
      confirmText: 'Перевірити',
    });
    if (ok) startCheck({ body: filterOf(state), label: filtered ? `${nBoxes(total)} за фільтром` : 'Усі скриньки' });
  }

  function bulkCheck() {
    const n = selCount();
    if (allMatching) startCheck({ body: filterOf(state), label: `${nBoxes(n)} за фільтром` });
    else startCheck({ body: { emails: [...selected] }, label: `Вибрані: ${nBoxes(n)}` });
  }

  async function bulkStatus(status) {
    const n = selCount();
    if (allMatching || n > 25) {
      const ok = await confirmDialog({
        title: 'Змінити статус?', confirmText: 'Змінити',
        message: `Статус «${statusLabel(status)}» буде встановлено для ${nBoxes(n)}.`,
      });
      if (!ok) return;
    }
    try {
      const res = await api.post('/api/v1/mailboxes/bulk', { action: 'status', status, ...bulkTarget() });
      toast.success(`Статус «${statusLabel(status)}» встановлено для ${nBoxes(res.updated)}`);
      clearSelection();
      mailboxesChanged('bulk');
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function bulkDelete() {
    const n = selCount();
    const ok = await confirmDialog({
      title: `Видалити ${nBoxes(n)}?`, danger: true, confirmText: 'Видалити',
      message: 'Скриньки разом зі збереженими листами буде видалено назавжди. Цю дію не можна скасувати.',
    });
    if (!ok) return;
    try {
      const res = await api.post('/api/v1/mailboxes/bulk', { action: 'delete', ...bulkTarget() });
      toast.success(`Видалено ${nBoxes(res.deleted)}`);
      clearSelection();
      mailboxesChanged('bulk');
    } catch (err) {
      toast.error(err.message);
    }
  }

  function bulkExport() {
    if (allMatching) openExport({ filter: filterOf(state) });
    else openExport({ emails: [...selected] });
  }

  function bulkTags() {
    const n = selCount();
    const present = new Set();
    if (data) for (const m of data.items) if (allMatching || selected.has(m.email)) m.tags.forEach((t) => present.add(t));
    const m = openModal({ title: 'Теги вибраних скриньок', subtitle: allMatching ? `${nBoxes(n)} за фільтром` : nBoxes(n), size: 'md' });
    const add = chipInput({ placeholder: 'Наприклад: batch-dec, vip' });
    const remove = chipInput({ placeholder: 'Теги, які треба прибрати', suggestions: [...present].sort() });
    const errEl = h('div', { class: 'form-error', hidden: true, role: 'alert' });
    const formId = `tags-${Date.now()}`;
    const form = h('form', { class: 'form-stack', id: formId, novalidate: true },
      field({ label: 'Додати теги', control: add.input, after: null, hint: 'Enter або кома — додати тег' }).el,
      field({ label: 'Прибрати теги', control: remove.input, hint: present.size ? 'Натисніть наявний тег нижче, щоб позначити його до видалення' : '' }).el,
      errEl);
    // chip inputs wrap their own <input>; swap the plain inputs for the full widgets
    form.children[0].replaceChild(add.el, add.input);
    form.children[1].replaceChild(remove.el, remove.input);
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', form: formId }, 'Застосувати');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const addTags = add.value;
      const removeTags = remove.value;
      if (!addTags.length && !removeTags.length) {
        errEl.textContent = 'Вкажіть теги, які треба додати або прибрати.';
        errEl.hidden = false;
        return;
      }
      withBusy(submit, async () => {
        try {
          const res = await api.post('/api/v1/mailboxes/bulk', { action: 'tags', add: addTags, remove: removeTags, ...bulkTarget() });
          toast.success(`Теги оновлено: ${nBoxes(res.updated)}`);
          m.close();
          clearSelection();
          mailboxesChanged('tags');
        } catch (err) {
          errEl.textContent = err.message;
          errEl.hidden = false;
        }
      });
    });
    m.setBody(form);
    m.setFooter(h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Скасувати'), submit);
  }

  // ------------------------------------------------------------ wiring
  scope.on(document, 'keydown', (e) => {
    if (e.key !== 'Escape' || overlayOpen() || !selCount()) return;
    const t = e.target;
    if (t && t.closest && t.closest('input:not([type="checkbox"]), textarea, select')) return;
    clearSelection();
  });
  scope.add(on('stats', () => renderChips()));
  scope.add(on('mailboxes:changed', () => load({ silent: true })));
  scope.poll(() => {
    if (!overlayOpen() && !selCount() && !tableCard.classList.contains('is-loading')) return load({ silent: true });
    return undefined;
  }, 30000);

  syncControls();
  refreshStats();
  load();
  syncDrawer(route.params.email || null);
  if (route.query.focus === 'search') {
    replaceHash(`#/mailboxes${queryString(state)}`);
    requestAnimationFrame(() => searchInput.focus());
  }

  return {
    update(next) {
      const nextState = stateFromQuery(next.query);
      if (queryString(nextState) !== queryString(state)) {
        state = nextState;
        clearSelection(false);
        syncControls();
        load();
      }
      syncDrawer(next.params.email || null);
      if (next.query.focus === 'search') {
        replaceHash(`#/mailboxes${queryString(state)}`);
        searchInput.focus();
      }
    },
  };
}
