// Classic (non-module) script loaded in <head>: applies the saved theme before first paint.
(function () {
  var pref = 'system';
  try { pref = localStorage.getItem('hh-theme') || 'system'; } catch (e) { /* storage disabled */ }
  var light = pref === 'light' ||
    (pref === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
}());
