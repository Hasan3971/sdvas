// DOM helpers and generic UI primitives: scopes, modal/drawer/menu stack, toasts, clipboard.
import { icon } from './icons.js';
import { absTime, relTime } from './format.js';

export { icon };

// Properties assigned directly; everything else becomes an attribute. Never innerHTML.
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'readOnly', 'multiple',
  'required', 'hidden', 'textContent', 'tabIndex', 'open']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = Array.isArray(val) ? val.filter(Boolean).join(' ') : val;
      else if (key === 'dataset') {
        for (const [dk, dv] of Object.entries(val)) if (dv !== null && dv !== undefined) el.dataset[dk] = dv;
      } else if (key === 'ref') val(el);
      else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2).toLowerCase(), val);
      else if (PROPS.has(key)) el[key] = val;
      else el.setAttribute(key, val === true ? '' : String(val));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

let uidCounter = 0;
export const uid = (prefix = 'id') => `${prefix}-${++uidCounter}`;

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function debounce(fn, ms) {
  let timer = 0;
  const d = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(timer);
  return d;
}

// ---------------------------------------------------------------- scopes (lifecycle of timers/listeners/fetches)

export function createScope() {
  const cleanups = [];
  const ctrl = new AbortController();
  let disposed = false;
  const scope = {
    signal: ctrl.signal,
    get disposed() { return disposed; },
    add(fn) {
      if (disposed) fn();
      else cleanups.push(fn);
      return fn;
    },
    on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      scope.add(() => target.removeEventListener(type, fn, opts));
    },
    timeout(fn, ms) {
      const id = setTimeout(fn, ms);
      scope.add(() => clearTimeout(id));
      return id;
    },
    // Skips ticks while the tab is hidden.
    interval(fn, ms) {
      const id = setInterval(() => { if (!document.hidden) fn(); }, ms);
      scope.add(() => clearInterval(id));
      return id;
    },
    // Async polling without overlap; paused while hidden, catches up when the tab becomes visible.
    poll(fn, ms) {
      let running = false;
      let last = Date.now();
      const run = async () => {
        if (disposed || running || document.hidden) return;
        running = true;
        last = Date.now();
        try { await fn(); } catch { /* the callback reports its own errors */ } finally { running = false; }
      };
      const id = setInterval(run, ms);
      const onVisible = () => { if (!document.hidden && Date.now() - last >= ms) run(); };
      document.addEventListener('visibilitychange', onVisible);
      scope.add(() => {
        clearInterval(id);
        document.removeEventListener('visibilitychange', onVisible);
      });
      return { run };
    },
    child() {
      const sub = createScope();
      scope.add(() => sub.dispose());
      return sub;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      ctrl.abort();
      while (cleanups.length) {
        const fn = cleanups.pop();
        try { fn(); } catch { /* keep disposing */ }
      }
    },
  };
  return scope;
}

// ---------------------------------------------------------------- overlay stack (modal, drawer, menu)

const stack = [];
let overlayRoot = null;

function layerRoot() {
  if (!overlayRoot) {
    overlayRoot = h('div', { class: 'overlays' });
    document.body.appendChild(overlayRoot);
  }
  return overlayRoot;
}

function pushLayer(layer) {
  stack.push(layer);
  syncLayers();
}

function removeLayer(layer) {
  const i = stack.indexOf(layer);
  if (i >= 0) stack.splice(i, 1);
  syncLayers();
}

function syncLayers() {
  document.documentElement.classList.toggle('has-overlay', stack.some((l) => l.lock));
  stack.forEach((l, i) => l.el.classList.toggle('is-top', i === stack.length - 1));
}

export const overlayOpen = () => stack.length > 0;
export const modalOpen = () => stack.some((l) => l.lock);

export function closeAllOverlays() {
  for (const layer of [...stack].reverse()) layer.close();
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), '
  + 'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function focusables(rootEl) {
  return [...rootEl.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[hidden]') && el.getClientRects().length > 0);
}

document.addEventListener('keydown', (e) => {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    if (top.dismissible) {
      e.preventDefault();
      e.stopPropagation();
      top.close();
    }
    return;
  }
  if (e.key === 'Tab' && top.trap) {
    const items = focusables(top.panel);
    if (!items.length) {
      e.preventDefault();
      top.panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !top.panel.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !top.panel.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }
}, true);

document.addEventListener('focusin', (e) => {
  const top = stack[stack.length - 1];
  if (top && top.trap && !top.panel.contains(e.target) && !e.target.closest('.toasts, .menu')) {
    (focusables(top.panel)[0] || top.panel).focus({ preventScroll: true });
  }
});

function restoreFocus(el) {
  if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true });
}

function animateOut(el) {
  el.classList.remove('is-open');
  el.classList.add('is-closing');
  const done = () => el.remove();
  if (reducedMotion()) done();
  else {
    el.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 280);
  }
}

function initialFocusIn(panel, preferred) {
  requestAnimationFrame(() => {
    const target = (typeof preferred === 'function' ? preferred() : preferred)
      || panel.querySelector('[autofocus]')
      || panel.querySelector('.modal-body input:not([type="checkbox"]):not([type="radio"]):not([disabled]), .modal-body textarea, .modal-body select')
      || panel;
    if (target && target.isConnected) target.focus({ preventScroll: true });
  });
}

/**
 * Modal dialog. Returns {body, foot, scope, setTitle, setSubtitle, setBody, setFooter, setDismissible, close, closed}.
 */
export function openModal({ title = '', subtitle = '', size = 'md', dismissible = true, onClose, className = '',
  initialFocus, role = 'dialog' } = {}) {
  const scope = createScope();
  const prevFocus = document.activeElement;
  const titleId = uid('modal-title');
  const titleEl = h('h2', { class: 'modal-title', id: titleId }, title);
  const subEl = h('p', { class: 'modal-sub', hidden: !subtitle }, subtitle);
  const closeBtn = h('button', { type: 'button', class: 'icon-btn modal-x', 'aria-label': 'Закрити', title: 'Закрити (Esc)' },
    icon('x', { size: 18 }));
  const bodyEl = h('div', { class: 'modal-body' });
  const footEl = h('div', { class: 'modal-foot', hidden: true });
  const panel = h('div', {
    class: `modal modal-${size} ${className}`, role, 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
  }, h('div', { class: 'modal-head' }, h('div', { class: 'modal-titles' }, titleEl, subEl), closeBtn), bodyEl, footEl);
  const backdrop = h('div', { class: 'backdrop' });
  const el = h('div', { class: 'layer layer-modal' }, backdrop, panel);

  let resolveClosed;
  const closed = new Promise((res) => { resolveClosed = res; });
  let isClosed = false;
  const layer = { el, panel, trap: true, lock: true, dismissible, close: () => api.close() };

  const api = {
    el, panel, body: bodyEl, foot: footEl, scope, closed,
    get isOpen() { return !isClosed; },
    setTitle(text) { titleEl.textContent = text; },
    setSubtitle(text) { subEl.textContent = text || ''; subEl.hidden = !text; },
    setBody(...nodes) { mount(bodyEl, ...nodes); },
    setFooter(...nodes) {
      mount(footEl, ...nodes);
      footEl.hidden = !footEl.childNodes.length;
    },
    setDismissible(value) {
      layer.dismissible = value;
      closeBtn.disabled = !value;
    },
    close(result) {
      if (isClosed) return;
      isClosed = true;
      scope.dispose();
      removeLayer(layer);
      animateOut(el);
      restoreFocus(prevFocus);
      resolveClosed(result);
      if (onClose) onClose(result);
    },
  };
  closeBtn.addEventListener('click', () => { if (layer.dismissible) api.close(); });
  backdrop.addEventListener('click', () => { if (layer.dismissible) api.close(); });

  layerRoot().appendChild(el);
  pushLayer(layer);
  requestAnimationFrame(() => el.classList.add('is-open'));
  initialFocusIn(panel, initialFocus);
  return api;
}

/** Side drawer from the right. The caller fills `panel`. */
export function openDrawer({ labelledBy, className = '', onClose } = {}) {
  const scope = createScope();
  const prevFocus = document.activeElement;
  const panel = h('aside', {
    class: `drawer ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy, tabindex: '-1',
  });
  const backdrop = h('div', { class: 'backdrop' });
  const el = h('div', { class: 'layer layer-drawer' }, backdrop, panel);
  let isClosed = false;
  const layer = { el, panel, trap: true, lock: true, dismissible: true, close: () => api.close() };
  const api = {
    el, panel, scope,
    get isOpen() { return !isClosed; },
    close() {
      if (isClosed) return;
      isClosed = true;
      scope.dispose();
      removeLayer(layer);
      animateOut(el);
      restoreFocus(prevFocus);
      if (onClose) onClose();
    },
  };
  backdrop.addEventListener('click', () => api.close());
  layerRoot().appendChild(el);
  pushLayer(layer);
  requestAnimationFrame(() => el.classList.add('is-open'));
  requestAnimationFrame(() => panel.focus({ preventScroll: true }));
  return api;
}

export function confirmDialog({ title, message, confirmText = 'Підтвердити', cancelText = 'Скасувати', danger = false,
  details = null } = {}) {
  return new Promise((resolve) => {
    let result = false;
    let okBtn = null;
    let cancelBtn = null;
    const m = openModal({
      title, size: 'sm', role: 'alertdialog', className: 'modal-confirm',
      initialFocus: () => (danger ? cancelBtn : okBtn),
      onClose: () => resolve(result),
    });
    cancelBtn = h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, cancelText);
    okBtn = h('button', {
      type: 'button', class: danger ? 'btn btn-danger' : 'btn btn-primary',
      onClick: () => { result = true; m.close(); },
    }, confirmText);
    m.setBody(h('p', { class: 'confirm-text' }, message), details);
    m.setFooter(cancelBtn, okBtn);
  });
}

// ---------------------------------------------------------------- dropdown menu

let activeMenu = null;

export function closeMenu() {
  if (activeMenu) activeMenu.close(false);
}

/**
 * items: [{label, icon, dot, hint, danger, checked, disabled, onSelect}] | '-' | {heading}
 */
export function openMenu(anchor, items, { align = 'end', className = '', label = 'Меню' } = {}) {
  if (activeMenu) {
    const same = activeMenu.anchor === anchor;
    activeMenu.close(same);
    if (same) return null;
  }
  const scope = createScope();
  const buttons = [];
  const menu = h('div', { class: `menu ${className}`, role: 'menu', 'aria-label': label, tabindex: '-1' });
  for (const item of items) {
    if (!item) continue;
    if (item === '-') {
      menu.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if (item.heading) {
      menu.appendChild(h('div', { class: 'menu-heading', role: 'presentation' }, item.heading));
      continue;
    }
    const lead = item.icon ? icon(item.icon, { size: 15, cls: 'menu-ico' })
      : item.dot ? h('span', { class: `dot dot-${item.dot}` }) : h('span', { class: 'menu-ico-spacer' });
    const btn = h('button', {
      type: 'button',
      class: ['menu-item', item.danger && 'is-danger', item.checked && 'is-checked'],
      role: item.checked !== undefined ? 'menuitemradio' : 'menuitem',
      'aria-checked': item.checked !== undefined ? String(Boolean(item.checked)) : null,
      disabled: item.disabled,
      tabindex: '-1',
      onClick: () => {
        close(true);
        if (item.onSelect) item.onSelect();
      },
    }, lead, h('span', { class: 'menu-label' }, item.label),
    item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null,
    item.checked ? icon('check', { size: 14, cls: 'menu-check' }) : null);
    buttons.push(btn);
    menu.appendChild(btn);
  }
  layerRoot().appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8 && rect.top - mh - 6 > 8) top = rect.top - mh - 6;
  let left = align === 'end' ? rect.right - mw : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${left}px`;
  requestAnimationFrame(() => menu.classList.add('is-open'));

  anchor.setAttribute('aria-expanded', 'true');
  const layer = { el: menu, panel: menu, trap: false, lock: false, dismissible: true, close: () => close(true) };
  pushLayer(layer);

  const enabled = () => buttons.filter((b) => !b.disabled);
  const move = (delta) => {
    const list = enabled();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    list[(i + delta + list.length) % list.length].focus();
  };
  scope.on(menu, 'keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); enabled()[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); enabled().at(-1)?.focus(); }
    else if (e.key === 'Tab') { e.preventDefault(); close(true); }
  });
  scope.on(document, 'pointerdown', (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close(false);
  }, true);
  scope.on(window, 'resize', () => close(false));
  scope.on(window, 'scroll', (e) => { if (!menu.contains(e.target)) close(false); }, true);
  (buttons.find((b) => b.classList.contains('is-checked') && !b.disabled) || enabled()[0] || menu).focus({ preventScroll: true });

  let isClosed = false;
  function close(restore) {
    if (isClosed) return;
    isClosed = true;
    scope.dispose();
    removeLayer(layer);
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    if (activeMenu && activeMenu.menu === menu) activeMenu = null;
    if (restore) restoreFocus(anchor);
  }
  activeMenu = { anchor, menu, close };
  return activeMenu;
}

// ---------------------------------------------------------------- toasts

let toastRoot = null;

function toastContainer() {
  if (!toastRoot) {
    toastRoot = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    document.body.appendChild(toastRoot);
  }
  return toastRoot;
}

const TOAST_ICON = { success: 'checkCircle', error: 'alertCircle', info: 'info', warning: 'alert' };

export function toast(message, { type = 'info', title = '', timeout, action } = {}) {
  const container = toastContainer();
  const life = timeout ?? (type === 'error' ? 7000 : 4000);
  let timer = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 180);
  };
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(TOAST_ICON[type] || 'info', { size: 18, cls: 'toast-ico' }),
    h('div', { class: 'toast-body' }, title ? h('div', { class: 'toast-title' }, title) : null, h('div', { class: 'toast-msg' }, message)),
    action ? h('button', { type: 'button', class: 'toast-action', onClick: () => { dismiss(); action.onClick(); } }, action.label) : null,
    h('button', { type: 'button', class: 'icon-btn toast-x', 'aria-label': 'Закрити сповіщення', onClick: dismiss }, icon('x', { size: 14 })));
  const arm = () => { if (life > 0) timer = setTimeout(dismiss, life); };
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  container.appendChild(el);
  while (container.children.length > 4) container.firstElementChild.remove();
  arm();
  return dismiss;
}
toast.success = (msg, opts) => toast(msg, { ...opts, type: 'success' });
toast.error = (msg, opts) => toast(msg, { ...opts, type: 'error' });
toast.info = (msg, opts) => toast(msg, { ...opts, type: 'info' });
toast.warning = (msg, opts) => toast(msg, { ...opts, type: 'warning' });

// ---------------------------------------------------------------- clipboard

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall back below */ }
  // Plain http: navigator.clipboard is unavailable, use a temporary textarea.
  const active = document.activeElement;
  const ta = h('textarea', { class: 'copy-buffer', readonly: '', 'aria-hidden': 'true', tabindex: '-1' });
  ta.value = text;
  const host = stack.length ? stack[stack.length - 1].panel : document.body;
  host.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  restoreFocus(active);
  return ok;
}

export async function copy(text, what = '') {
  const ok = await copyText(String(text));
  if (ok) toast.success(what ? `${what} скопійовано` : 'Скопійовано в буфер обміну', { timeout: 2200 });
  else toast.error('Не вдалося скопіювати автоматично — виділіть текст і скопіюйте вручну.');
  return ok;
}

export function copyButton(getText, { label = 'Копіювати', what = '', cls = '', size = 15, text = '' } = {}) {
  const btn = h('button', {
    type: 'button', class: `${text ? 'btn btn-sm' : 'icon-btn'} copy-btn ${cls}`, 'aria-label': label, title: label,
    onClick: async (e) => {
      e.stopPropagation();
      const value = typeof getText === 'function' ? getText() : getText;
      if (!value) return;
      if (await copy(value, what)) {
        btn.classList.add('is-copied');
        setTimeout(() => btn.classList.remove('is-copied'), 1400);
      }
    },
  }, icon('copy', { size, cls: 'ico-copy' }), icon('check', { size, cls: 'ico-done' }), text || null);
  return btn;
}

// ---------------------------------------------------------------- small building blocks

export function spinner(cls = '') {
  return h('span', { class: `spinner ${cls}`, 'aria-hidden': 'true' });
}

export async function withBusy(btn, fn) {
  if (!btn) return fn();
  if (btn.classList.contains('is-busy')) return undefined;
  btn.classList.add('is-busy');
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-busy');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

export function timeEl(iso, { cls = '', empty = '—' } = {}) {
  if (!iso) return h('span', { class: `muted ${cls}` }, empty);
  return h('time', { class: `rel ${cls}`, datetime: iso, title: absTime(iso), 'data-rel': iso }, relTime(iso));
}

// One global ticker keeps every relative timestamp fresh.
setInterval(() => {
  if (document.hidden) return;
  const now = Date.now();
  for (const el of document.querySelectorAll('time[data-rel]')) el.textContent = relTime(el.dataset.rel, now);
}, 30000);

export function skel(cls = '') {
  return h('span', { class: `skel ${cls}`, 'aria-hidden': 'true' });
}

export function emptyState({ iconName = 'inbox', title, text = '', actions = [], compact = false } = {}) {
  return h('div', { class: ['empty', compact && 'empty-compact'] },
    h('div', { class: 'empty-ico' }, icon(iconName, { size: compact ? 18 : 22 })),
    h('div', { class: 'empty-title' }, title),
    text ? h('p', { class: 'empty-text' }, text) : null,
    actions.length ? h('div', { class: 'empty-actions' }, actions) : null);
}

export function errorBanner({ title = 'Не вдалося завантажити дані', message = '', onRetry } = {}) {
  const retry = onRetry ? h('button', { type: 'button', class: 'btn btn-sm', onClick: onRetry }, icon('refresh', { size: 14 }), 'Повторити') : null;
  return h('div', { class: 'banner banner-error', role: 'alert' },
    icon('alertCircle', { size: 18, cls: 'banner-ico' }),
    h('div', { class: 'banner-body' }, h('div', { class: 'banner-title' }, title), message ? h('div', { class: 'banner-msg' }, message) : null),
    retry);
}

export function banner(type, content, iconName) {
  const ico = iconName || { info: 'info', warning: 'alert', success: 'checkCircle', error: 'alertCircle' }[type];
  return h('div', { class: `banner banner-${type}` }, icon(ico, { size: 17, cls: 'banner-ico' }), h('div', { class: 'banner-body' }, content));
}

/**
 * Labelled form field. `control` receives the id/aria wiring; `widget` (optional) is rendered instead of it
 * when the control lives inside a composite element (e.g. a tag input). Returns {el, control, setError}.
 */
export function field({ label, control, widget = null, hint = '', id, optional = false, className = '', after = null }) {
  const cid = id || control.id || uid('f');
  control.id = cid;
  const hintId = `${cid}-hint`;
  const errId = `${cid}-err`;
  const errEl = h('div', { class: 'field-error', id: errId, hidden: true });
  const hintEl = hint ? h('div', { class: 'field-hint', id: hintId }, hint) : null;
  control.setAttribute('aria-describedby', [hint ? hintId : '', errId].filter(Boolean).join(' '));
  const el = h('div', { class: `field ${className}` },
    h('label', { class: 'field-label', for: cid }, label, optional ? h('span', { class: 'field-opt' }, 'необов’язково') : null),
    widget || control, after, hintEl, errEl);
  return {
    el,
    control,
    setError(msg) {
      errEl.textContent = msg || '';
      errEl.hidden = !msg;
      el.classList.toggle('has-error', Boolean(msg));
      if (msg) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
  };
}

export function selectEl(options, { value = '', label, id, cls = '', onChange } = {}) {
  const select = h('select', { class: `select ${cls}`, id, 'aria-label': label || null, onChange: onChange ? (e) => onChange(e.target.value) : null },
    options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text)));
  return { wrap: h('span', { class: 'select-wrap' }, select, icon('chevronDown', { size: 14, cls: 'select-caret' })), select };
}

export function switchEl({ checked = false, label = '', onChange, id, describedBy } = {}) {
  const input = h('input', {
    type: 'checkbox', role: 'switch', class: 'switch-input', id, checked,
    'aria-describedby': describedBy || null,
    onChange: onChange ? (e) => onChange(e.target.checked) : null,
  });
  const el = h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
    label ? h('span', { class: 'switch-label' }, label) : null);
  return { el, input };
}

export function checkboxEl({ checked = false, label = '', onChange, id, name, value, hint } = {}) {
  const input = h('input', { type: 'checkbox', class: 'checkbox', id, name, value, checked, onChange: onChange ? (e) => onChange(e.target.checked, e) : null });
  const el = h('label', { class: 'check' }, input, h('span', { class: 'check-text' }, label, hint ? h('span', { class: 'check-hint' }, hint) : null));
  return { el, input };
}

/** Segmented control (radio group semantics). */
export function segmented({ options, value, onChange, label, size = '' }) {
  let current = value;
  const buttons = options.map((opt) => h('button', {
    type: 'button', role: 'radio', class: 'seg-btn', 'aria-checked': String(opt.value === current),
    title: opt.title || null, 'aria-label': opt.ariaLabel || null, tabindex: opt.value === current ? '0' : '-1',
    onClick: () => set(opt.value, true),
  }, opt.icon ? icon(opt.icon, { size: 15 }) : null, opt.label ? h('span', { class: 'seg-label' }, opt.label) : null));
  const el = h('div', { class: `seg ${size ? `seg-${size}` : ''}`, role: 'radiogroup', 'aria-label': label }, buttons);
  el.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === current);
    const next = (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + options.length) % options.length;
    set(options[next].value, true);
    buttons[next].focus();
  });
  function set(v, notify) {
    current = v;
    buttons.forEach((b, i) => {
      const on = options[i].value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (notify && onChange) onChange(v);
  }
  return { el, set: (v) => set(v, false), get value() { return current; } };
}

/** Accessible tabs. tabs: [{id, label, count?}] */
export function tabsEl({ tabs, value, onChange, label, cls = '' }) {
  let current = value;
  const btns = tabs.map((t) => h('button', {
    type: 'button', role: 'tab', class: 'tab', id: `tab-${t.id}`, 'aria-selected': String(t.id === current),
    'aria-controls': `panel-${t.id}`, tabindex: t.id === current ? '0' : '-1', onClick: () => select(t.id, true),
  }, t.icon ? icon(t.icon, { size: 15 }) : null, t.label, t.count !== undefined ? h('span', { class: 'tab-count' }, t.count) : null));
  const el = h('div', { class: `tabs ${cls}`, role: 'tablist', 'aria-label': label }, btns);
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = tabs.findIndex((t) => t.id === current);
    const next = (i + (e.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    select(tabs[next].id, true);
    btns[next].focus();
  });
  function select(id, notify) {
    current = id;
    btns.forEach((b, i) => {
      const on = tabs[i].id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (notify && onChange) onChange(id);
  }
  return { el, select: (id) => select(id, false), setCount(id, n) { const b = btns[tabs.findIndex((t) => t.id === id)]; const c = b && b.querySelector('.tab-count'); if (c) c.textContent = n; } };
}

export function progressBar(value = 0, max = 100, { label = 'Прогрес' } = {}) {
  const fill = h('div', { class: 'progress-fill' });
  const el = h('div', { class: 'progress', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuenow': String(value) }, fill);
  const set = (v, m = max) => {
    const ratio = m ? Math.min(1, Math.max(0, v / m)) : 0;
    fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    el.setAttribute('aria-valuenow', String(v));
    el.setAttribute('aria-valuemax', String(m));
  };
  set(value, max);
  return { el, set };
}

export const kbd = (text) => h('kbd', { class: 'kbd' }, text);
