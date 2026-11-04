// Hash router: #/, #/mailboxes, #/mailboxes/<email>, #/api, #/activity, #/settings (+ optional ?query).

let handler = null;
let lastHash = null;

export function parseRoute(hash = location.hash) {
  let raw = hash.replace(/^#/, '');
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const qi = raw.indexOf('?');
  const path = qi >= 0 ? raw.slice(0, qi) : raw;
  const query = Object.fromEntries(new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : ''));
  const seg = path.split('/').filter(Boolean);
  if (!seg.length) return { name: 'overview', params: {}, query };
  if (seg[0] === 'mailboxes') {
    const params = {};
    if (seg.length > 1) {
      const enc = seg.slice(1).join('/');
      try { params.email = decodeURIComponent(enc); } catch { params.email = enc; }
    }
    return { name: 'mailboxes', params, query };
  }
  if (seg.length === 1 && ['api', 'activity', 'settings'].includes(seg[0])) return { name: seg[0], params: {}, query };
  return { name: 'overview', params: {}, query: {}, unknown: true };
}

export function startRouter(fn) {
  handler = fn;
  lastHash = null;
  window.addEventListener('popstate', run);
  window.addEventListener('hashchange', run);
  run();
}

export function stopRouter() {
  handler = null;
  window.removeEventListener('popstate', run);
  window.removeEventListener('hashchange', run);
}

function run() {
  if (!handler || location.hash === lastHash) return;
  const route = parseRoute();
  if (route.unknown) {
    history.replaceState(history.state, '', '#/');
  }
  lastHash = location.hash;
  handler(route);
}

/** Pushes a new history entry (marked as in-app so "close" can go back). */
export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  // Replacing keeps the current entry's state, so leaveTo() never steps back out of the app.
  if (replace) history.replaceState(history.state, '', target);
  else if (target !== location.hash) history.pushState({ app: 1 }, '', target);
  run();
}

/** Updates the address bar without routing (filters, pagination). */
export function replaceHash(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (target === location.hash) return;
  history.replaceState(history.state, '', target);
  lastHash = location.hash;
}

/** Leaves a sub-route: history.back() when we pushed it, otherwise replace. */
export function leaveTo(hash) {
  if (history.state && history.state.app) history.back();
  else navigate(hash, { replace: true });
}

export const mailboxHash = (email, query = '') => `#/mailboxes/${encodeURIComponent(email)}${query}`;
