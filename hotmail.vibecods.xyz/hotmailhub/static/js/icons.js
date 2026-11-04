// Stroke icons on a 24×24 grid, built with createElementNS (no innerHTML).
const NS = 'http://www.w3.org/2000/svg';

const p = (d) => ['path', { d }];
const c = (cx, cy, r) => ['circle', { cx, cy, r }];
const r = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }];
const dot = (cx, cy) => ['circle', { cx, cy, r: 1.35, fill: 'currentColor', stroke: 'none' }];

const ICONS = {
  overview: [r(3, 3, 7.5, 9, 1.8), r(13.5, 3, 7.5, 5.5, 1.8), r(13.5, 11.5, 7.5, 9.5, 1.8), r(3, 15, 7.5, 6, 1.8)],
  mail: [r(2.75, 5, 18.5, 14, 2.5), p('m3.6 7.1 8.4 6.1 8.4-6.1')],
  mailOpen: [p('M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0Z'), p('m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10')],
  inbox: [p('M22 12h-6l-2 3h-4l-2-3H2'), p('M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z')],
  plug: [p('M12 22v-5'), p('M9 8V2'), p('M15 8V2'), p('M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z')],
  activity: [p('M22 12h-4l-3 9L9 3l-3 9H2')],
  settings: [p('M20 7h-9'), p('M14 17H4'), c(17, 17, 3), c(7, 7, 3)],
  search: [c(11, 11, 7), p('m20.5 20.5-4.3-4.3')],
  plus: [p('M12 5v14'), p('M5 12h14')],
  minus: [p('M5 12h14')],
  upload: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m17 8-5-5-5 5'), p('M12 3v12')],
  download: [p('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), p('m7 10 5 5 5-5'), p('M12 15V3')],
  refresh: [p('M21 12a9 9 0 0 1-15.36 6.36L3 16'), p('M3 12a9 9 0 0 1 15.36-6.36L21 8'), p('M21 3v5h-5'), p('M3 21v-5h5')],
  shieldCheck: [p('M12 22s8-3.6 8-10V5.2L12 2 4 5.2V12c0 6.4 8 10 8 10Z'), p('m9 12 2 2 4-4')],
  check: [p('M20 6 9 17l-5-5')],
  copy: [r(9, 9, 12, 12, 2.2), p('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  eye: [p('M2.06 12.35a1 1 0 0 1 0-.7C3.42 8.36 7.38 5 12 5s8.58 3.36 9.94 6.65a1 1 0 0 1 0 .7C20.58 15.64 16.62 19 12 19s-8.58-3.36-9.94-6.65'), c(12, 12, 3)],
  eyeOff: [p('M10.73 5.08A10.43 10.43 0 0 1 12 5c4.62 0 8.58 3.36 9.94 6.65a1 1 0 0 1 0 .7 13.16 13.16 0 0 1-1.67 2.68'), p('M14.08 14.16a3 3 0 0 1-4.24-4.24'), p('M17.48 17.5A10.75 10.75 0 0 1 12 19c-4.62 0-8.58-3.36-9.94-6.65a1 1 0 0 1 0-.7 13.36 13.36 0 0 1 4.4-5.32'), p('m2 2 20 20')],
  trash: [p('M3 6h18'), p('M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6'), p('m19 6-.9 13.2A2 2 0 0 1 16.1 21H7.9a2 2 0 0 1-2-1.8L5 6'), p('M10 11v5.5'), p('M14 11v5.5')],
  edit: [p('M12 20h9'), p('M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3.5 19.5l1-4Z')],
  more: [dot(5, 12), dot(12, 12), dot(19, 12)],
  moreV: [dot(12, 5), dot(12, 12), dot(12, 19)],
  x: [p('M18 6 6 18'), p('m6 6 12 12')],
  chevronDown: [p('m6 9 6 6 6-6')],
  chevronUp: [p('m18 15-6-6-6 6')],
  chevronLeft: [p('m15 18-6-6 6-6')],
  chevronRight: [p('m9 18 6-6-6-6')],
  arrowUp: [p('M12 19V5'), p('m5 12 7-7 7 7')],
  arrowDown: [p('M12 5v14'), p('m19 12-7 7-7-7')],
  arrowRight: [p('M5 12h14'), p('m12 5 7 7-7 7')],
  sort: [p('m7 15 5 5 5-5'), p('m7 9 5-5 5 5')],
  menu: [p('M4 6h16'), p('M4 12h16'), p('M4 18h16')],
  sun: [c(12, 12, 4), p('M12 2v2'), p('M12 20v2'), p('m4.93 4.93 1.41 1.41'), p('m17.66 17.66 1.41 1.41'), p('M2 12h2'), p('M20 12h2'), p('m6.34 17.66-1.41 1.41'), p('m19.07 4.93-1.41 1.41')],
  moon: [p('M20.98 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.77 9.79Z')],
  monitor: [r(2, 3.5, 20, 13.5, 2.2), p('M8 21h8'), p('M12 17v4')],
  logout: [p('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), p('m16 17 5-5-5-5'), p('M21 12H9')],
  key: [c(7.5, 15.5, 5), p('m11 12 9.5-9.5'), p('m17 6 3 3'), p('m14.5 8.5 2.5 2.5')],
  link: [p('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71'), p('M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71')],
  webhook: [p('M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2'), p('m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06'), p('m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8')],
  clock: [c(12, 12, 9), p('M12 7v5l3 2')],
  alert: [p('M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z'), p('M12 9v4'), p('M12 17h.01')],
  alertCircle: [c(12, 12, 9), p('M12 8v4.5'), p('M12 16h.01')],
  checkCircle: [c(12, 12, 9), p('m8.5 12.2 2.4 2.4 4.6-5')],
  xCircle: [c(12, 12, 9), p('m15 9-6 6'), p('m9 9 6 6')],
  info: [c(12, 12, 9), p('M12 16v-4.5'), p('M12 8h.01')],
  filter: [p('M22 3H2l8 9.46V19l4 2v-8.54Z')],
  tag: [p('M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42Z'), dot(7.5, 7.5)],
  user: [c(12, 8, 4), p('M4.5 21a7.5 7.5 0 0 1 15 0')],
  userCheck: [c(9, 8, 4), p('M2 21a7 7 0 0 1 12.2-4.7'), p('m16 19 2 2 4-4')],
  lock: [r(4, 11, 16, 10, 2.2), p('M8 11V7a4 4 0 0 1 8 0v4')],
  external: [p('M15 3h6v6'), p('M10 14 21 3'), p('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6')],
  file: [p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z'), p('M14 2v6h6')],
  fileText: [p('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z'), p('M14 2v6h6'), p('M8 13h8'), p('M8 17h5')],
  hourglass: [p('M6 2h12'), p('M6 22h12'), p('M7 2v4a5 5 0 0 0 10 0V2'), p('M7 22v-4a5 5 0 0 1 10 0v4')],
  zap: [p('M13 2 3 14h9l-1 8 10-12h-9Z')],
  terminal: [p('m4 17 6-6-6-6'), p('M12 19h8')],
  code: [p('m16 18 6-6-6-6'), p('m8 6-6 6 6 6')],
  book: [p('M4 19.5A2.5 2.5 0 0 1 6.5 17H20'), p('M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z')],
  hash: [p('M4 9h16'), p('M4 15h16'), p('M10 3 8 21'), p('m16 3-2 18')],
  keyboard: [r(2, 5, 20, 14, 2.2), p('M6 9h.01'), p('M10 9h.01'), p('M14 9h.01'), p('M18 9h.01'), p('M6 13h.01'), p('M18 13h.01'), p('M10 13h4'), p('M8 16.5h8')],
  send: [p('M22 2 11 13'), p('m22 2-7 20-4-9-9-4Z')],
  ban: [c(12, 12, 9), p('m5.7 5.7 12.6 12.6')],
  flame: [p('M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5Z')],
  layers: [p('m12 2 10 5-10 5L2 7Z'), p('m2 17 10 5 10-5'), p('m2 12 10 5 10-5')],
  list: [p('M8 6h13'), p('M8 12h13'), p('M8 18h13'), dot(3.5, 6), dot(3.5, 12), dot(3.5, 18)],
  server: [r(3, 3, 18, 8, 2), r(3, 13, 18, 8, 2), dot(7, 7), dot(7, 17)],
  sparkle: [p('M12 3v4'), p('M12 17v4'), p('M3 12h4'), p('M17 12h4'), p('m6 6 2.5 2.5'), p('m15.5 15.5 2.5 2.5'), p('m6 18 2.5-2.5'), p('m15.5 8.5 2.5-2.5')],
  dotCircle: [c(12, 12, 9), ['circle', { cx: 12, cy: 12, r: 3, fill: 'currentColor', stroke: 'none' }]],
  grip: [dot(9, 6), dot(15, 6), dot(9, 12), dot(15, 12), dot(9, 18), dot(15, 18)],
  help: [c(12, 12, 9), p('M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3'), p('M12 17h.01')],
  pulse: [c(12, 12, 3), p('M12 3v2'), p('M12 19v2'), p('M3 12h2'), p('M19 12h2')],
};

export function icon(name, { size = 16, cls = '', stroke = 1.75, label } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(stroke));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', ('icon ' + cls).trim());
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of ICONS[name] || ICONS.dotCircle) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    svg.appendChild(node);
  }
  return svg;
}
