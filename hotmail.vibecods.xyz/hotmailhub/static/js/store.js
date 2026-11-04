// Shared app state, a tiny event bus and the theme preference.
import { api } from './api.js';

export const store = { me: null, stats: null };

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event, data) {
  for (const fn of [...(listeners.get(event) || [])]) {
    try { fn(data); } catch (err) { console.error(err); }
  }
}

let statsInFlight = null;

/** Loads /stats once even if several widgets ask at the same time. May reject. */
export function loadStats() {
  if (!statsInFlight) {
    statsInFlight = api.get('/api/v1/stats')
      .then((stats) => {
        store.stats = stats;
        emit('stats', stats);
        return stats;
      })
      .finally(() => { statsInFlight = null; });
  }
  return statsInFlight;
}

export function refreshStats() {
  loadStats().catch(() => { /* widgets show their own errors */ });
}

/** Call after any mutation of mailboxes so every visible widget refreshes. */
export function mailboxesChanged(reason = '') {
  emit('mailboxes:changed', { reason });
  refreshStats();
}

// ---------------------------------------------------------------- theme

const THEME_KEY = 'hh-theme';
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');

export function themePref() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme() {
  const pref = themePref();
  const light = pref === 'light' || (pref === 'system' && lightQuery.matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
}

export function setThemePref(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch { /* storage disabled: apply for this session only */ }
  applyTheme();
  emit('theme', pref);
}

lightQuery.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });

export const THEME_OPTIONS = [
  { value: 'system', label: 'Системна', icon: 'monitor' },
  { value: 'dark', label: 'Темна', icon: 'moon' },
  { value: 'light', label: 'Світла', icon: 'sun' },
];
