// Import modal: paste text or upload a file, dry-run preview, real import (+ optional login check job).
import {
  h, icon, mount, openModal, uid, tabsEl, segmented, selectEl, checkboxEl, field, withBusy, errorBanner, debounce, banner, toast,
} from '../ui.js';
import { api } from '../api.js';
import { STATUS, fmtNum, fmtSize, plural, nBoxes } from '../format.js';
import { chipInput } from '../components.js';
import { mailboxesChanged } from '../store.js';
import { jobProgress } from './check-job.js';

const MAX_BYTES = 25 * 1024 * 1024;
const ACTIONS = {
  added: { label: 'додано', tone: 'green' },
  updated: { label: 'оновлено', tone: 'accent' },
  skipped: { label: 'пропущено', tone: 'grey' },
  duplicate_in_file: { label: 'дубль у файлі', tone: 'amber' },
  invalid: { label: 'помилка', tone: 'red' },
};
const COUNT_LABELS = [
  ['added', 'Додано'], ['updated', 'Оновлено'], ['skipped', 'Пропущено'], ['duplicate_in_file', 'Дублі у файлі'], ['invalid', 'Помилкові'],
];

function countLines(text) {
  let n = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    if (/\S/.test(text.slice(start, end))) n += 1;
    start = end + 1;
  }
  return n;
}

function formatsHelp() {
  const rows = [
    ['email:password:refresh_token:client_id', 'Hotmail / Outlook OAuth2 (також «|», «;» або Tab); у паролі можуть бути двокрапки'],
    ['email;password', 'IMAP, сервер визначається за доменом'],
    ['email;password;imap.host[:port][;login]', 'свій IMAP-сервер або спільна скринька'],
    ['#disabled email;password', 'вимкнена скринька (сумісність зі старим mails.txt)'],
  ];
  return h('details', { class: 'form-collapse help-collapse' },
    h('summary', null, icon('chevronRight', { size: 15, cls: 'collapse-caret' }), icon('help', { size: 15 }), h('span', { class: 'collapse-title' }, 'Підтримувані формати')),
    h('div', { class: 'help-body' },
      h('dl', { class: 'formats' }, rows.map(([code, text]) => h('div', { class: 'format-row' }, h('dt', null, h('code', null, code)), h('dd', null, text)))),
      h('p', { class: 'help-note' }, 'CSV із заголовком (email, password, refresh_token, client_id, imap_host, imap_port, login, status, note, tags) або JSON-масив рядків чи об’єктів — визначаються за вмістом або розширенням .csv/.json. Кодування файлу: UTF-8, UTF-8 BOM, UTF-16 або cp1251. Паролі й токени в результатах не показуються.')));
}

export function openImport() {
  const m = openModal({ title: 'Імпорт скриньок', subtitle: 'mails.txt, CSV або JSON — формат визначається автоматично', size: 'lg', className: 'modal-import' });
  const formId = uid('import');
  let source = 'text';
  let file = null;
  let done = false;

  // ---- source: text
  const textarea = h('textarea', {
    class: 'textarea mono import-text', rows: 9, spellcheck: 'false', autocomplete: 'off', wrap: 'off',
    placeholder: 'user@hotmail.com:пароль:M.C5…:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx\nuser@rambler.ru;password\nteam@gmail.com;app-password;imap.gmail.com:993',
    'aria-label': 'Рядки для імпорту',
  });
  const lineCount = h('span', { class: 'import-count' }, 'Порожньо');
  const updateCount = debounce(() => {
    const v = textarea.value;
    if (!v.trim()) lineCount.textContent = 'Порожньо';
    else {
      const n = countLines(v);
      lineCount.textContent = `${fmtNum(n)} ${plural(n, 'рядок', 'рядки', 'рядків')} · ${fmtSize(new Blob([v]).size)}`;
    }
  }, 250);
  textarea.addEventListener('input', () => {
    updateCount();
    invalidate();
  });
  m.scope.add(() => updateCount.cancel());
  const textPanel = h('div', { class: 'import-panel', id: 'panel-paste', role: 'tabpanel', 'aria-labelledby': 'tab-paste' },
    textarea, h('div', { class: 'import-meta' }, lineCount, h('span', { class: 'faint' }, 'Кожна скринька — окремим рядком')));

  // ---- source: file
  const fileInput = h('input', { type: 'file', accept: '.txt,.csv,.json,text/plain,text/csv,application/json', class: 'sr-only', id: uid('file'), tabindex: '-1' });
  const pickBtn = h('button', { type: 'button', class: 'link-btn', onClick: () => fileInput.click() }, 'оберіть файл');
  const dropInner = h('div', { class: 'drop-inner' });
  const drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Перетягніть файл сюди або натисніть, щоб обрати' }, dropInner);
  const filePanel = h('div', { class: 'import-panel', id: 'panel-file', role: 'tabpanel', 'aria-labelledby': 'tab-file', hidden: true }, drop, fileInput);
  function renderDrop() {
    if (!file) {
      drop.classList.remove('has-file');
      mount(dropInner, h('span', { class: 'drop-ico' }, icon('upload', { size: 22 })),
        h('div', { class: 'drop-title' }, 'Перетягніть файл сюди або ', pickBtn),
        h('div', { class: 'drop-sub' }, '.txt, .csv або .json · до 25 МБ'));
      return;
    }
    drop.classList.add('has-file');
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    mount(dropInner,
      h('span', { class: 'drop-ico is-file' }, icon('fileText', { size: 22 })),
      h('div', { class: 'file-info' }, h('div', { class: 'file-name truncate', title: file.name }, file.name),
        h('div', { class: 'drop-sub' }, fmtSize(file.size), ['txt', 'csv', 'json'].includes(ext) ? '' : ' · розширення не .txt/.csv/.json — спробуємо як текст')),
      h('button', { type: 'button', class: 'btn btn-sm', onClick: (e) => { e.stopPropagation(); fileInput.click(); } }, 'Замінити'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Прибрати файл', onClick: (e) => { e.stopPropagation(); setFile(null); } }, icon('x', { size: 16 })));
  }
  function setFile(f) {
    if (f && f.size > MAX_BYTES) {
      toast.error(`Файл ${f.name} завеликий (${fmtSize(f.size)}). Максимум — 25 МБ.`);
      return;
    }
    file = f;
    fileInput.value = '';
    renderDrop();
    invalidate();
  }
  fileInput.addEventListener('change', () => setFile(fileInput.files && fileInput.files[0] ? fileInput.files[0] : null));
  drop.addEventListener('click', (e) => { if (!file && !e.target.closest('button')) fileInput.click(); });
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === drop) {
      e.preventDefault();
      fileInput.click();
    }
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setFile(f);
  });
  renderDrop();

  const tabs = tabsEl({
    tabs: [{ id: 'paste', label: 'Вставити текст', icon: 'fileText' }, { id: 'file', label: 'Файл', icon: 'upload' }],
    value: 'paste', label: 'Джерело даних', cls: 'tabs-pills import-tabs',
    onChange: (id) => {
      source = id === 'file' ? 'file' : 'text';
      textPanel.hidden = source !== 'text';
      filePanel.hidden = source !== 'file';
      invalidate();
      (source === 'text' ? textarea : drop).focus();
    },
  });

  // ---- options
  const dup = segmented({
    options: [{ value: 'skip', label: 'Пропускати' }, { value: 'update', label: 'Оновлювати' }],
    value: 'skip', label: 'Наявні адреси', onChange: () => invalidate(), size: 'block',
  });
  dup.el.classList.add('seg-block');
  const statusSel = selectEl([['', 'Вільна (типово)'], ...['used', 'burned', 'invalid', 'disabled'].map((s) => [s, STATUS[s].label])], { id: uid('imp-status'), onChange: () => invalidate() });
  const tags = chipInput({ placeholder: 'Наприклад: batch-dec', onChange: () => invalidate() });
  const check = checkboxEl({ label: 'Одразу перевірити вхід', hint: 'Після імпорту сервер перевірить кожну нову або оновлену скриньку' });
  const dupHelpId = uid('dup-help');
  const options = h('div', { class: 'import-options' },
    h('div', { class: 'field' }, h('span', { class: 'field-label', id: dupHelpId }, 'Наявні адреси'), dup.el,
      h('div', { class: 'field-hint' }, '«Оновлювати» замінює дані, зберігаючи статус')),
    field({ label: 'Початковий статус', control: statusSel.select, widget: statusSel.wrap, hint: 'Для нових скриньок без #disabled' }).el,
    field({ label: 'Теги', control: tags.input, widget: tags.el, optional: true, hint: 'Додаються до всіх імпортованих' }).el,
    h('div', { class: 'import-check' }, check.el));
  dup.el.setAttribute('aria-labelledby', dupHelpId);

  const resultSlot = h('div', { class: 'import-result', 'aria-live': 'polite' });
  const inputArea = h('div', { class: 'import-input' }, tabs.el, textPanel, filePanel, options, formatsHelp());
  const form = h('form', { id: formId, class: 'import-form', novalidate: true }, inputArea, resultSlot);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(false);
  });

  const previewBtn = h('button', { type: 'button', class: 'btn', onClick: () => run(true) }, icon('eye', { size: 16 }), 'Попередній перегляд');
  const importBtn = h('button', { type: 'submit', class: 'btn btn-primary', form: formId }, icon('upload', { size: 16 }), 'Імпортувати');
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => m.close() }, 'Скасувати');
  m.setBody(form);
  m.setFooter(cancelBtn, previewBtn, importBtn);
  requestAnimationFrame(() => textarea.focus());

  function invalidate() {
    if (!done && resultSlot.firstChild) mount(resultSlot);
  }

  function buildBody(dry) {
    const common = { mode: dup.value, status: statusSel.select.value, tags: tags.value, dry_run: dry, check: !dry && check.input.checked };
    if (source === 'file') {
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('mode', common.mode);
      if (common.status) fd.append('status', common.status);
      if (common.tags.length) fd.append('tags', common.tags.join(','));
      fd.append('dry_run', dry ? '1' : '0');
      fd.append('check', common.check ? '1' : '0');
      return fd;
    }
    return { text: textarea.value, ...common };
  }

  function run(dry) {
    if (source === 'text' && !textarea.value.trim()) {
      mount(resultSlot, banner('warning', 'Вставте хоча б один рядок для імпорту.'));
      textarea.focus();
      return;
    }
    if (source === 'file' && !file) {
      mount(resultSlot, banner('warning', 'Оберіть файл для імпорту.'));
      drop.focus();
      return;
    }
    const btn = dry ? previewBtn : importBtn;
    withBusy(btn, async () => {
      previewBtn.disabled = true;
      importBtn.disabled = true;
      try {
        const res = await api.post('/api/v1/import', buildBody(dry), { signal: m.scope.signal });
        if (dry) renderResult(res, true);
        else finish(res);
      } catch (err) {
        if (err.name === 'AbortError') return;
        mount(resultSlot, errorBanner({ title: dry ? 'Не вдалося розібрати дані' : 'Імпорт не вдався', message: err.message }));
      } finally {
        if (!done) {
          previewBtn.disabled = false;
          importBtn.disabled = false;
        }
      }
    });
  }

  function finish(res) {
    done = true;
    inputArea.hidden = true;
    const changed = res.counts.added + res.counts.updated;
    m.setTitle(changed ? 'Імпорт завершено' : 'Імпорт: нічого не змінено');
    m.setSubtitle(changed ? `Додано ${fmtNum(res.counts.added)}, оновлено ${fmtNum(res.counts.updated)}` : 'Усі рядки пропущено або містять помилки');
    renderResult(res, false);
    if (changed) mailboxesChanged('import');
    if (res.job) resultSlot.appendChild(h('div', { class: 'import-job' }, h('h3', { class: 'det-title' }, icon('shieldCheck', { size: 14 }), 'Перевірка входу'), jobProgress(res.job, m.scope)));
    const again = h('button', {
      type: 'button', class: 'btn',
      onClick: () => {
        done = false;
        inputArea.hidden = false;
        textarea.value = '';
        setFile(null);
        updateCount();
        mount(resultSlot);
        m.setTitle('Імпорт скриньок');
        m.setSubtitle('mails.txt, CSV або JSON — формат визначається автоматично');
        m.setFooter(cancelBtn, previewBtn, importBtn);
        previewBtn.disabled = false;
        importBtn.disabled = false;
        textarea.focus();
      },
    }, 'Імпортувати ще');
    const close = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => m.close() }, 'Готово');
    m.setFooter(again, close);
    close.focus();
    toast.success(changed ? `Додано ${nBoxes(res.counts.added)}, оновлено ${fmtNum(res.counts.updated)}` : 'Нових скриньок немає', { title: 'Імпорт' });
  }

  function renderResult(res, dry) {
    const counts = res.counts;
    const problems = res.results.filter((r) => r.action === 'invalid' || r.action === 'duplicate_in_file');
    let onlyProblems = false;
    let shown = 0;
    const tbody = h('tbody');
    const moreBtn = h('button', { type: 'button', class: 'btn btn-sm', onClick: () => addRows(500) });
    const moreRow = h('div', { class: 'results-more' }, moreBtn);
    const list = () => (onlyProblems ? problems : res.results);
    function addRows(n) {
      const items = list();
      const next = items.slice(shown, shown + n);
      for (const r of next) {
        const a = ACTIONS[r.action] || { label: r.action, tone: 'grey' };
        tbody.appendChild(h('tr', { class: r.action === 'invalid' ? 'is-bad' : '' },
          h('td', { class: 'num r-line' }, String(r.line)),
          h('td', { class: 'r-email mono' }, h('span', { class: 'truncate', title: r.email || '' }, r.email || '—')),
          h('td', { class: 'r-action' }, h('span', { class: `badge tone-${a.tone}` }, a.label)),
          h('td', { class: 'r-error' }, r.error || '')));
      }
      shown += next.length;
      const rest = items.length - shown;
      moreRow.hidden = rest <= 0;
      moreBtn.textContent = `Показати ще ${fmtNum(Math.min(500, rest))} з ${fmtNum(rest)}`;
    }
    function rerender() {
      mount(tbody);
      shown = 0;
      addRows(200);
    }
    const filterToggle = problems.length && problems.length < res.results.length
      ? checkboxEl({ label: `Лише проблемні (${fmtNum(problems.length)})`, onChange: (v) => { onlyProblems = v; rerender(); } }).el
      : null;
    const truncated = Object.values(counts).reduce((a, b) => a + b, 0) > res.results.length;
    mount(resultSlot,
      dry ? banner('info', h('span', null, h('b', null, 'Попередній перегляд. '), 'У базу ще нічого не записано — перевірте результат і натисніть «Імпортувати».')) : null,
      h('div', { class: 'count-chips' }, COUNT_LABELS.map(([key, label]) => h('span', { class: `count-chip tone-${ACTIONS[key].tone}${counts[key] ? '' : ' is-zero'}` },
        h('span', { class: 'count-num' }, fmtNum(counts[key] || 0)), label))),
      res.results.length ? h('div', { class: 'results' },
        h('div', { class: 'results-head' }, h('span', { class: 'results-title' }, `Рядки (${fmtNum(res.results.length)})`), filterToggle),
        h('div', { class: 'results-scroll' }, h('table', { class: 'table results-table' },
          h('thead', null, h('tr', null, h('th', { class: 'num' }, '№'), h('th', null, 'Email'), h('th', null, 'Дія'), h('th', null, 'Помилка'))),
          tbody)),
        moreRow,
        truncated ? h('p', { class: 'field-hint' }, 'Сервер повертає перші 3000 рядків результату.') : null) : null);
    rerender();
  }

  return m;
}
