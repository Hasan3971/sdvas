// Entry point: session check, login screen, app shell (sidebar + top bar), routing and shortcuts.
import { h, icon, mount, createScope, toast, openModal, overlayOpen, closeAllOverlays, closeMenu, kbd, segmented, errorBanner } from './ui.js';
import { api, setCsrf, onUnauthorized } from './api.js';
import { store, on, refreshStats, themePref, setThemePref, THEME_OPTIONS } from './store.js';
import { startRouter, stopRouter, navigate } from './router.js';
import { fmtNum } from './format.js';
import { renderLogin } from './views/login.js';
import * as overview from './views/overview.js';
import * as mailboxes from './views/mailboxes.js';
import * as apiPage from './views/api-bas.js';
import * as activity from './views/activity.js';
import * as settings from './views/settings.js';
import { openMailboxForm } from './views/mailbox-form.js';
import { openImport } from './views/import.js';

const VIEWS = {
  overview: { title: 'Огляд', module: overview },
  mailboxes: { title: 'Скриньки', module: mailboxes },
  api: { title: 'API та BAS', module: apiPage },
  activity: { title: 'Журнал', module: activity },
  settings: { title: 'Налаштування', module: settings },
};

const NAV = [
  { name: 'overview', href: '#/', label: 'Огляд', icon: 'overview' },
  { name: 'mailboxes', href: '#/mailboxes', label: 'Скриньки', icon: 'mail' },
  { name: 'api', href: '#/api', label: 'API та BAS', icon: 'plug' },
  { name: 'activity', href: '#/activity', label: 'Журнал', icon: 'activity' },
  { name: 'settings', href: '#/settings', label: 'Налаштування', icon: 'settings' },
];

const GOTO = { o: '#/', m: '#/mailboxes', a: '#/api', j: '#/activity', s: '#/settings' };

const appEl = document.getElementById('app');
let shell = null;
let current = null;
let loginScope = null;

function setMode(mode) {
  appEl.className = mode;
  appEl.removeAttribute('aria-busy');
}

const isTyping = (el) => Boolean(el && el.closest && el.closest(
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"]'));

// ---------------------------------------------------------------- shell

function buildShell() {
  const scope = createScope();
  const links = {};

  const brand = h('a', { href: '#/', class: 'brand', 'aria-label': 'Hotmail Hub — на огляд' },
    h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
    h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, 'Hotmail Hub'), h('span', { class: 'brand-sub' }, 'vibecods')));

  const countEl = h('span', { class: 'sb-count', hidden: true });
  const nav = h('nav', { class: 'sb-nav', 'aria-label': 'Розділи' }, NAV.map((item) => {
    const link = h('a', { href: item.href, class: 'sb-link', title: item.label, dataset: { route: item.name } },
      icon(item.icon, { size: 18 }), h('span', { class: 'sb-label' }, item.label), item.name === 'mailboxes' ? countEl : null);
    links[item.name] = link;
    return link;
  }));

  const themeSeg = segmented({
    options: THEME_OPTIONS.map((o) => ({ value: o.value, icon: o.icon, ariaLabel: `Тема: ${o.label}`, title: o.label })),
    value: themePref(), onChange: setThemePref, label: 'Тема оформлення', size: 'sm',
  });
  const cycleBtn = h('button', { type: 'button', class: 'sb-link sb-theme-cycle' });
  const syncCycle = () => {
    const opt = THEME_OPTIONS.find((o) => o.value === themePref()) || THEME_OPTIONS[0];
    mount(cycleBtn, icon(opt.icon, { size: 18 }), h('span', { class: 'sb-label' }, `Тема: ${opt.label.toLowerCase()}`));
    cycleBtn.title = `Тема: ${opt.label} (натисніть, щоб змінити)`;
    cycleBtn.setAttribute('aria-label', cycleBtn.title);
  };
  cycleBtn.addEventListener('click', () => {
    const i = THEME_OPTIONS.findIndex((o) => o.value === themePref());
    setThemePref(THEME_OPTIONS[(i + 1) % THEME_OPTIONS.length].value);
  });
  syncCycle();
  scope.add(on('theme', (pref) => { themeSeg.set(pref); syncCycle(); }));

  const logoutBtn = h('button', { type: 'button', class: 'sb-link sb-logout', title: 'Вийти', onClick: logout },
    icon('logout', { size: 18 }), h('span', { class: 'sb-label' }, 'Вийти'));
  const version = h('div', { class: 'sb-version', title: `Hotmail Hub ${store.me.version}` },
    h('span', { class: 'hdot hdot-ok', 'aria-hidden': 'true' }), h('span', { class: 'sb-label' }, `Hotmail Hub v${store.me.version}`));

  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Бічна панель' },
    h('div', { class: 'sb-top' }, brand),
    nav,
    h('div', { class: 'sb-foot' },
      h('div', { class: 'sb-theme' }, h('span', { class: 'sb-foot-label' }, 'Тема'), themeSeg.el), cycleBtn, logoutBtn, version));
  const sbBackdrop = h('div', { class: 'sb-backdrop', onClick: () => closeSidebar() });

  // top bar
  const menuBtn = h('button', {
    type: 'button', class: 'icon-btn tb-menu', 'aria-label': 'Відкрити меню', 'aria-controls': 'sidebar', 'aria-expanded': 'false',
    onClick: () => (appEl.classList.contains('sb-open') ? closeSidebar() : openSidebar()),
  }, icon('menu', { size: 20 }));
  const titleEl = h('h1', { class: 'tb-title' });
  const search = h('input', {
    type: 'search', class: 'tb-search-input', id: 'global-search', placeholder: 'Пошук скриньок…', autocomplete: 'off',
    spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Пошук скриньок (Enter — перейти до результатів)',
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = search.value.trim();
      search.value = '';
      search.blur();
      navigate(`#/mailboxes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    } else if (e.key === 'Escape') {
      search.value = '';
      search.blur();
    }
  });
  const searchWrap = h('div', { class: 'tb-search', role: 'search' }, icon('search', { size: 16, cls: 'tb-search-ico' }), search, kbd('/'));
  const mobileSearch = h('button', {
    type: 'button', class: 'icon-btn tb-search-btn', 'aria-label': 'Пошук скриньок',
    onClick: () => focusSearch(),
  }, icon('search', { size: 19 }));
  const importBtn = h('button', { type: 'button', class: 'btn tb-import', title: 'Імпорт (I)', onClick: () => openImport() },
    icon('upload', { size: 16 }), h('span', { class: 'btn-label' }, 'Імпорт'));
  const addBtn = h('button', { type: 'button', class: 'btn btn-primary tb-add', title: 'Додати скриньку (N)', onClick: () => openMailboxForm() },
    icon('plus', { size: 16, stroke: 2.2 }), h('span', { class: 'btn-label' }, 'Додати'));
  const topbar = h('header', { class: 'topbar' }, menuBtn, titleEl, h('div', { class: 'tb-spacer' }), searchWrap, mobileSearch,
    h('div', { class: 'tb-actions' }, importBtn, addBtn));
  const content = h('main', { class: 'content', id: 'main', tabindex: '-1' });
  const skip = h('button', { type: 'button', class: 'skip-link', onClick: () => content.focus() }, 'Перейти до вмісту');
  mount(appEl, skip, sidebar, sbBackdrop, h('div', { class: 'main' }, topbar, content));

  scope.add(on('stats', (stats) => {
    countEl.textContent = fmtNum(stats.total);
    countEl.hidden = false;
  }));

  function openSidebar() {
    appEl.classList.add('sb-open');
    menuBtn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => (nav.querySelector('[aria-current="page"]') || nav.querySelector('a')).focus());
  }
  function closeSidebar(restore = false) {
    if (!appEl.classList.contains('sb-open')) return;
    appEl.classList.remove('sb-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    if (restore) menuBtn.focus();
  }
  function focusSearch() {
    const pageSearch = content.querySelector('[data-page-search]');
    if (pageSearch && pageSearch.getClientRects().length) {
      pageSearch.focus();
      pageSearch.select();
    } else if (search.getClientRects().length) search.focus();
    else navigate('#/mailboxes?focus=search');
  }

  let pendingG = 0;
  scope.on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && appEl.classList.contains('sb-open') && !overlayOpen()) {
      closeSidebar(true);
      return;
    }
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || overlayOpen() || isTyping(e.target)) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (pendingG) {
      clearTimeout(pendingG);
      pendingG = 0;
      if (GOTO[key]) {
        e.preventDefault();
        navigate(GOTO[key]);
      }
      return;
    }
    if (e.key === '/') { e.preventDefault(); focusSearch(); }
    else if (key === 'n' || key === 'т') { e.preventDefault(); openMailboxForm(); }
    else if (key === 'i' || key === 'ш') { e.preventDefault(); openImport(); }
    else if (key === 'g' || key === 'п') { pendingG = setTimeout(() => { pendingG = 0; }, 1200); }
    else if (e.key === '?') { e.preventDefault(); showShortcuts(); }
  });
  scope.add(() => clearTimeout(pendingG));

  return {
    scope,
    content,
    closeSidebar,
    setTitle(text) {
      titleEl.textContent = text;
      document.title = `${text} · Hotmail Hub`;
    },
    setActive(name) {
      appEl.dataset.route = name;
      for (const [key, link] of Object.entries(links)) {
        if (key === name) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
  };
}

function showShortcuts() {
  const rows = [
    [['/'], 'Пошук скриньок'], [['N'], 'Додати скриньку'], [['I'], 'Імпорт'],
    [['G', 'O'], 'Огляд'], [['G', 'M'], 'Скриньки'], [['G', 'A'], 'API та BAS'], [['G', 'J'], 'Журнал'], [['G', 'S'], 'Налаштування'],
    [['Esc'], 'Закрити вікно або панель'], [['?'], 'Ця довідка'],
  ];
  const m = openModal({ title: 'Клавіатурні скорочення', size: 'sm' });
  m.setBody(h('dl', { class: 'shortcuts' }, rows.map(([keys, label]) => h('div', { class: 'shortcut-row' },
    h('dt', null, label),
    h('dd', null, keys.map((k, i) => [i ? h('span', { class: 'shortcut-then' }, 'потім') : null, kbd(k)]))))));
}

function showRoute(route) {
  closeMenu();
  shell.closeSidebar();
  if (current && current.name === route.name && current.view.update) {
    current.view.update(route);
    return;
  }
  if (current) current.scope.dispose();
  const def = VIEWS[route.name];
  const scope = createScope();
  const root = h('div', { class: `page page-${route.name}` });
  mount(shell.content, root);
  shell.setActive(route.name);
  shell.setTitle(def.title);
  let view = {};
  try {
    view = def.module.mount(root, { scope, route }) || {};
  } catch (err) {
    console.error(err);
    mount(root, errorBanner({ title: 'Не вдалося відкрити сторінку', message: String(err && err.message ? err.message : err) }));
  }
  current = { name: route.name, scope, view };
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- session

function startShell(me) {
  store.me = me;
  setCsrf(me.csrf);
  setMode('app');
  shell = buildShell();
  startRouter(showRoute);
  refreshStats();
}

function teardownShell() {
  stopRouter();
  closeAllOverlays();
  if (current) {
    current.scope.dispose();
    current = null;
  }
  if (shell) {
    shell.scope.dispose();
    shell = null;
  }
}

function showLogin(notice = '') {
  if (loginScope) return;
  teardownShell();
  setMode('auth');
  loginScope = renderLogin(appEl, {
    notice,
    onSuccess: async (csrf) => {
      setCsrf(csrf);
      const me = await api.get('/api/v1/me', null, { authRedirect: false });
      loginScope.dispose();
      loginScope = null;
      startShell(me);
    },
  });
}

async function logout() {
  try {
    await api.post('/api/v1/auth/logout', {});
  } catch { /* the cookie is cleared either way */ }
  store.me = null;
  setCsrf('');
  showLogin();
  toast.info('Ви вийшли з панелі.');
}

function showBootError(err, retry) {
  setMode('auth');
  mount(appEl, h('main', { class: 'login' },
    h('div', { class: 'login-card' },
      h('div', { class: 'login-brand' }, h('span', { class: 'brand-mark brand-mark-lg', 'aria-hidden': 'true' })),
      errorBanner({ title: 'Не вдалося з’єднатися із сервером', message: err.message, onRetry: retry }))));
}

async function boot() {
  onUnauthorized(() => {
    if (shell) showLogin('Сесія завершилась. Увійдіть знову.');
  });
  try {
    const me = await api.get('/api/v1/me', null, { authRedirect: false });
    startShell(me);
  } catch (err) {
    if (err.status === 401) showLogin();
    else showBootError(err, boot);
  }
}

boot();
