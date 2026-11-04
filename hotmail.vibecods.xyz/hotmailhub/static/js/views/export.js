// Export modal: format, statuses, secrets toggle and a live count; the file is fetched through the API (CSRF-safe).
import { h, icon, openModal, uid, segmented, checkboxEl, field, withBusy, banner, toast, mount } from '../ui.js';
import { api, download } from '../api.js';
import { STATUS, STATUSES, fmtSize, nBoxes } from '../format.js';

const FORMATS = [
  { value: 'txt', label: 'TXT · для BAS', hint: 'Файл у форматі mails.txt: email:password:refresh_token:client_id, по рядку на скриньку.' },
  { value: 'csv', label: 'CSV', hint: 'Таблиця: email, password, refresh_token, client_id, imap_host, imap_port, login, status, note, tags.' },
  { value: 'json', label: 'JSON', hint: 'Повні об’єкти скриньок: статус, теги, стан перевірки, останній код.' },
];

export function openExport({ filter = {}, emails = null } = {}) {
  const explicit = Array.isArray(emails) && emails.length > 0;
  const hasFilter = Object.keys(filter).length > 0;
  const preset = new Set(String(filter.status || '').split(',').filter((s) => STATUSES.includes(s)));
  const initial = preset.size ? preset : new Set(STATUSES);
  const m = openModal({
    title: 'Експорт скриньок',
    subtitle: explicit ? `Вибрано ${nBoxes(emails.length)}` : hasFilter ? 'За поточним фільтром' : 'Увесь пул',
    size: 'md',
  });

  let format = 'txt';
  const formatHint = h('p', { class: 'field-hint export-hint' }, FORMATS[0].hint);
  const formatSeg = segmented({
    options: FORMATS.map(({ value, label }) => ({ value, label })), value: format, label: 'Формат файлу', size: 'block',
    onChange: (value) => {
      format = value;
      formatHint.textContent = FORMATS.find((f) => f.value === value).hint;
    },
  });
  formatSeg.el.classList.add('seg-block');

  const statusBoxes = STATUSES.map((s) => ({
    s, box: checkboxEl({ checked: initial.has(s), label: STATUS[s].label, onChange: () => refresh() }),
  }));
  const selected = () => statusBoxes.filter(({ box }) => box.input.checked).map(({ s }) => s);
  const statusBlock = explicit ? null : h('div', { class: 'field' },
    h('span', { class: 'field-label' }, 'Статуси'),
    h('div', { class: 'export-statuses' }, statusBoxes.map(({ box }) => box.el)));

  const secrets = checkboxEl({
    checked: true, label: 'Включити паролі та токени',
    hint: 'Без цього в файлі лишаться лише email-и та службові поля', onChange: () => renderWarning(),
  });
  const warning = h('div', { class: 'export-warning', 'aria-live': 'polite' });
  const renderWarning = () => mount(warning, secrets.input.checked
    ? banner('warning', 'Файл міститиме паролі й refresh-токени. Зберігайте його як секрет і не публікуйте.')
    : banner('info', 'Паролі та токени не експортуються — файл не підходить для відновлення пулу.'));
  renderWarning();

  const count = h('div', { class: 'export-count', 'aria-live': 'polite' });
  const downloadBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('download', { size: 16 }), 'Завантажити');
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => m.close() }, 'Скасувати');
  const errorSlot = h('div', { class: 'export-error', 'aria-live': 'polite' });
  let total = null;
  let ticket = 0;

  function paintCount(text, tone = '') {
    mount(count, icon('layers', { size: 15 }), h('span', { class: tone }, text));
  }
  async function refresh() {
    const mine = ++ticket;
    const chosen = selected();
    if (explicit) {
      total = emails.length;
      paintCount(`Буде експортовано ${nBoxes(total)}`);
      return;
    }
    if (!chosen.length) {
      total = 0;
      downloadBtn.disabled = true;
      paintCount('Оберіть хоча б один статус', 'is-warn');
      return;
    }
    paintCount('Рахую…');
    try {
      const query = { ...filter, status: chosen.length === STATUSES.length ? undefined : chosen.join(','), limit: 1 };
      const data = await api.get('/api/v1/mailboxes', query);
      if (mine !== ticket) return;
      total = data.total;
      downloadBtn.disabled = total === 0;
      paintCount(total ? `Буде експортовано ${nBoxes(total)}` : 'За цими умовами скриньок немає', total ? '' : 'is-warn');
    } catch (err) {
      if (mine !== ticket) return;
      total = null;
      downloadBtn.disabled = false;
      paintCount('Кількість невідома — експорт усе одно можливий', 'is-warn');
    }
  }

  downloadBtn.addEventListener('click', () => withBusy(downloadBtn, async () => {
    mount(errorSlot);
    const withSecrets = secrets.input.checked;
    const fallbackName = `mailboxes.${format}`;
    try {
      const chosen = selected();
      const result = explicit
        ? await download('POST', '/api/v1/export', { body: { emails, format, secrets: withSecrets }, fallbackName })
        : await download('GET', '/api/v1/export', {
          query: { ...filter, status: chosen.length === STATUSES.length ? undefined : chosen.join(','), format, secrets: withSecrets ? '1' : '0' },
          fallbackName,
        });
      toast(`Файл ${result.name} збережено (${fmtSize(result.size)})`, { type: 'success' });
      m.close();
    } catch (err) {
      mount(errorSlot, banner('error', err.message || 'Не вдалося сформувати файл'));
    }
  }));

  const formatField = h('div', { class: 'field' }, h('span', { class: 'field-label', id: uid('fmt') }, 'Формат'), formatSeg.el, formatHint);
  m.setBody(h('div', { class: 'export-form' }, formatField, statusBlock, h('div', { class: 'field' }, secrets.el), warning, count, errorSlot));
  m.setFooter(cancelBtn, downloadBtn);
  refresh();
}
