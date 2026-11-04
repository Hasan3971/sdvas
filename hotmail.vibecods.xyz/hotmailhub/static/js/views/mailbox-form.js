// Add / edit mailbox modal (same form), with a "paste a mails.txt line" helper.
import { h, icon, mount, openModal, field, uid, toast, withBusy, skel, errorBanner, selectEl, checkboxEl, banner } from '../ui.js';
import { api, mbPath, isAbort } from '../api.js';
import { STATUSES, STATUS } from '../format.js';
import { chipInput } from '../components.js';
import { mailboxesChanged } from '../store.js';

// Mirrors hotmailhub/parsing.py (EMAIL_RE, UUID_RE, parse_line).
export const EMAIL_RE = /^[^\s@;:|,<>"']+@[^\s@;:|,<>"']+\.[^\s@;:|,<>"']{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** email:password:refresh_token:client_id (also ; | Tab) or email;password[;host[:port][;login]]. Throws Error. */
export function parseLine(raw) {
  let text = String(raw || '').trim().replace(/^\ufeff/, '');
  let status = '';
  if (text.toLowerCase().startsWith('#disabled')) {
    text = text.slice(9).trim();
    status = 'disabled';
  }
  if (!text) throw new Error('Порожній рядок.');
  const sep = [';', '|', '\t'].find((s) => text.includes(s)) || ':';
  const parts = text.split(sep).map((p) => p.trim());
  const out = { email: '', password: '', refresh_token: '', client_id: '', imap_host: '', imap_port: '', login: '', status };
  if (parts.length >= 4 && UUID_RE.test(parts[parts.length - 1])) {
    out.email = parts[0];
    out.client_id = parts[parts.length - 1];
    out.refresh_token = parts[parts.length - 2];
    out.password = parts.slice(1, -2).join(sep);
    if (!out.refresh_token) throw new Error('Порожній refresh_token.');
  } else {
    if (parts.length < 2 || !parts[1]) throw new Error('Очікується email:пароль:refresh_token:client_id або email;пароль.');
    out.email = parts[0];
    out.password = parts[1];
    if (sep === ':') {
      if (parts.length !== 2) throw new Error('Для OAuth останнім полем має бути client_id (UUID).');
    } else {
      if (parts.length > 4) throw new Error('Забагато полів; для OAuth останнім має бути client_id (UUID).');
      if (parts[2]) {
        if (parts[2].startsWith('M.') || parts[2].length > 60) throw new Error('Для OAuth потрібен client_id (UUID) останнім полем.');
        const [host, port = ''] = parts[2].split(':');
        out.imap_host = host.toLowerCase();
        out.imap_port = port;
      }
      if (parts[3]) out.login = parts[3].toLowerCase();
    }
  }
  out.email = out.email.toLowerCase();
  if (!EMAIL_RE.test(out.email)) throw new Error('У рядку некоректний email.');
  return out;
}

const FIELD_BY_MESSAGE = [
  [/уже є в базі/, 'email'],
  [/некоректний email/, 'email'],
  [/refresh_token/, 'refresh_token'],
  [/client_id/, 'client_id'],
  [/порт/, 'imap_port'],
  [/login/, 'login'],
  [/пароль/, 'password'],
];

export function openMailboxForm({ email = null, onSaved } = {}) {
  const editing = Boolean(email);
  const m = openModal({
    title: editing ? 'Редагувати скриньку' : 'Нова скринька',
    subtitle: editing ? email : 'Hotmail / Outlook через OAuth2 або будь-яка пошта через IMAP',
    size: 'lg', className: 'modal-mailbox',
  });
  const formId = uid('mailbox-form');

  if (!editing) {
    build(null);
    return m;
  }
  m.setBody(h('div', { class: 'form-skel' }, skel('skel-line w-30'), skel('skel-bar'), skel('skel-line w-30'), skel('skel-bar'), skel('skel-line w-40'), skel('skel-bar')));
  api.get(mbPath(email), { secrets: 1 }, { signal: m.scope.signal })
    .then((data) => build(data))
    .catch((err) => {
      if (isAbort(err)) return;
      m.setBody(errorBanner({ title: 'Не вдалося завантажити скриньку', message: err.message }));
      m.setFooter(h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Закрити'));
    });
  return m;

  function build(orig) {
    const o = orig || {};
    const inputs = {};
    const fields = {};
    const mk = (name, props = {}) => {
      inputs[name] = h(props.tag || 'input', {
        class: props.cls || 'input', type: props.tag ? null : (props.type || 'text'), name,
        value: props.value ?? '', placeholder: props.placeholder || '', autocomplete: props.autocomplete || 'off',
        spellcheck: 'false', rows: props.rows || null, inputmode: props.inputmode || null,
      });
      return inputs[name];
    };

    // ---- paste line helper
    const lineInput = h('input', { type: 'text', class: 'input mono', placeholder: 'email:пароль:refresh_token:client_id', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Рядок у форматі mails.txt' });
    const lineMsg = h('div', { class: 'field-hint line-msg' }, 'Вставте повний рядок — поля заповняться автоматично. Підтримуються ":", ";", "|" і Tab.');
    let parsedStatus = '';
    const applyLine = () => {
      const raw = lineInput.value.trim();
      if (!raw) return;
      try {
        const p = parseLine(raw);
        inputs.email.value = p.email;
        inputs.password.value = p.password;
        inputs.refresh_token.value = p.refresh_token;
        inputs.client_id.value = p.client_id;
        inputs.imap_host.value = p.imap_host;
        inputs.imap_port.value = p.imap_port;
        inputs.login.value = p.login;
        parsedStatus = p.status;
        if (p.imap_host || p.login) imapDetails.open = true;
        if (statusSel && p.status) statusSel.select.value = p.status;
        Object.values(fields).forEach((f) => f.setError(''));
        lineMsg.className = 'field-hint line-msg is-ok';
        mount(lineMsg, icon('checkCircle', { size: 13 }), `Розібрано: ${p.client_id ? 'OAuth2' : 'IMAP'} · ${p.email}${p.status ? ' · буде вимкнена (#disabled)' : ''}`);
        lineInput.value = '';
      } catch (err) {
        lineMsg.className = 'field-hint line-msg is-error';
        mount(lineMsg, icon('alertCircle', { size: 13 }), err.message);
      }
    };
    lineInput.addEventListener('paste', () => setTimeout(applyLine, 0));
    lineInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        applyLine();
      }
    });
    const lineBox = h('div', { class: 'line-helper' },
      h('div', { class: 'line-helper-head' }, icon('zap', { size: 14 }), h('span', null, 'Вставити рядок')),
      h('div', { class: 'line-helper-row' }, lineInput, h('button', { type: 'button', class: 'btn', onClick: applyLine }, 'Розібрати')),
      lineMsg);

    // ---- fields
    fields.email = field({ label: 'Email', control: mk('email', { value: o.email, placeholder: 'name@hotmail.com', inputmode: 'email' }) });
    const pw = mk('password', { type: 'password', value: o.password, autocomplete: 'new-password', placeholder: editing ? '' : 'Пароль від пошти' });
    const eye = h('button', { type: 'button', class: 'icon-btn input-affix', 'aria-label': 'Показати пароль', 'aria-pressed': 'false' }, icon('eye', { size: 16 }));
    eye.addEventListener('click', () => {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(show));
      eye.setAttribute('aria-label', show ? 'Сховати пароль' : 'Показати пароль');
      mount(eye, icon(show ? 'eyeOff' : 'eye', { size: 16 }));
    });
    fields.password = field({ label: 'Пароль', control: pw, widget: h('div', { class: 'input-wrap' }, pw, eye), hint: 'Для OAuth2 необов’язковий' });
    fields.refresh_token = field({
      label: 'refresh_token', control: mk('refresh_token', { tag: 'textarea', cls: 'textarea mono', rows: 3, value: o.refresh_token, placeholder: 'M.C5…' }), className: 'span-2',
    });
    fields.client_id = field({ label: 'client_id', control: mk('client_id', { cls: 'input mono', value: o.client_id, placeholder: '00000000-0000-0000-0000-000000000000' }), hint: 'UUID застосунку Azure, з яким видано токен' });
    fields.imap_host = field({ label: 'IMAP-сервер', control: mk('imap_host', { value: o.imap_host, placeholder: 'imap.gmail.com' }), hint: 'Порожньо — визначається за доменом' });
    fields.imap_port = field({ label: 'Порт', control: mk('imap_port', { value: o.imap_port || '', placeholder: '993', inputmode: 'numeric' }) });
    fields.login = field({ label: 'Логін IMAP', control: mk('login', { value: o.login, placeholder: 'якщо відрізняється від email' }), hint: 'Для спільних скриньок' });
    fields.note = field({ label: 'Нотатка', control: mk('note', { value: o.note, placeholder: 'Будь-який коментар' }), optional: true });
    const tags = chipInput({ value: o.tags || [], placeholder: 'Тег і Enter (наприклад, batch-nov)' });
    fields.tags = field({ label: 'Теги', control: tags.input, widget: tags.el, optional: true });

    let statusSel = null;
    if (editing) {
      statusSel = selectEl(STATUSES.map((s) => [s, STATUS[s].label]), { value: o.status, id: uid('status') });
      fields.status = field({ label: 'Статус', control: statusSel.select, widget: statusSel.wrap });
    }

    const imapDetails = h('details', { class: 'form-collapse', open: Boolean(o.imap_host || o.login || o.imap_port) },
      h('summary', null, icon('chevronRight', { size: 15, cls: 'collapse-caret' }), h('span', { class: 'collapse-title' }, 'IMAP'), h('span', { class: 'collapse-sub' }, 'свій сервер, порт або логін')),
      h('div', { class: 'form-grid form-grid-3' }, fields.imap_host.el, fields.imap_port.el, fields.login.el));

    const formError = h('div', { class: 'form-error-slot' });
    const anotherCheck = editing ? null : checkboxEl({ label: 'Додати ще одну' });
    const form = h('form', { class: 'form-stack mailbox-form', id: formId, novalidate: true },
      lineBox,
      formError,
      h('div', { class: 'form-grid' }, fields.email.el, fields.password.el),
      h('section', { class: 'form-section' },
        h('div', { class: 'form-section-head' }, icon('key', { size: 15 }), h('span', { class: 'form-section-title' }, 'OAuth2 (Hotmail / Outlook)'), h('span', { class: 'form-section-sub' }, 'refresh_token і client_id задаються разом')),
        h('div', { class: 'form-grid' }, fields.refresh_token.el, fields.client_id.el)),
      imapDetails,
      h('div', { class: 'form-grid' }, fields.note.el, editing ? fields.status.el : h('div'), h('div', { class: 'span-2' }, fields.tags.el)));

    const submit = h('button', { type: 'submit', class: 'btn btn-primary', form: formId }, icon(editing ? 'check' : 'plus', { size: 16 }), editing ? 'Зберегти' : 'Додати скриньку');
    m.setBody(form);
    m.setFooter(anotherCheck ? h('div', { class: 'modal-foot-note' }, anotherCheck.el) : null,
      h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Скасувати'), submit);
    requestAnimationFrame(() => (editing ? inputs.email : lineInput).focus());

    const values = () => ({
      email: inputs.email.value.trim().toLowerCase(),
      password: inputs.password.value,
      refresh_token: inputs.refresh_token.value.trim(),
      client_id: inputs.client_id.value.trim(),
      imap_host: inputs.imap_host.value.trim().toLowerCase(),
      imap_port: inputs.imap_port.value.trim(),
      login: inputs.login.value.trim().toLowerCase(),
      note: inputs.note.value.trim(),
      tags: tags.value,
      status: statusSel ? statusSel.select.value : '',
    });

    function validate(v) {
      const errors = {};
      if (!v.email) errors.email = 'Вкажіть email.';
      else if (!EMAIL_RE.test(v.email)) errors.email = 'Некоректний email.';
      if (v.refresh_token && !v.client_id) errors.client_id = 'Для OAuth потрібні і refresh_token, і client_id.';
      if (v.client_id && !v.refresh_token) errors.refresh_token = 'Для OAuth потрібні і refresh_token, і client_id.';
      if (!v.refresh_token && !v.password && !(editing && o.password)) errors.password = 'Вкажіть пароль (або refresh_token і client_id для OAuth2).';
      if (v.imap_port && (!/^\d+$/.test(v.imap_port) || +v.imap_port < 1 || +v.imap_port > 65535)) errors.imap_port = 'Порт — число від 1 до 65535.';
      if (v.login && !v.login.includes('@')) errors.login = 'Логін IMAP має містити @.';
      return errors;
    }

    function showErrors(errors) {
      for (const [name, f] of Object.entries(fields)) f.setError(errors[name] || '');
      if ((errors.imap_host || errors.imap_port || errors.login) && !imapDetails.open) imapDetails.open = true;
      const first = Object.keys(errors)[0];
      if (first && inputs[first]) inputs[first].focus();
    }

    for (const [name, input] of Object.entries(inputs)) input.addEventListener('input', () => fields[name] && fields[name].setError(''));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      mount(formError);
      const v = values();
      const errors = validate(v);
      showErrors(errors);
      if (Object.keys(errors).length) return;
      withBusy(submit, () => (editing ? saveEdit(v) : saveNew(v)));
    });

    async function saveNew(v) {
      const body = {
        email: v.email, password: v.password, refresh_token: v.refresh_token, client_id: v.client_id,
        imap_host: v.imap_host, imap_port: v.imap_port ? +v.imap_port : 0, login: v.login, note: v.note, tags: v.tags,
      };
      if (parsedStatus) body.status = parsedStatus;
      try {
        const created = await api.post('/api/v1/mailboxes', body);
        toast.success(`${created.email} додано`, { title: 'Скриньку додано' });
        mailboxesChanged('add');
        if (onSaved) onSaved(created);
        if (anotherCheck && anotherCheck.input.checked) {
          for (const k of ['email', 'password', 'refresh_token', 'client_id', 'imap_host', 'imap_port', 'login', 'note']) inputs[k].value = '';
          parsedStatus = '';
          mount(lineMsg, 'Вставте наступний рядок або заповніть поля.');
          lineMsg.className = 'field-hint line-msg';
          lineInput.focus();
        } else m.close(created);
      } catch (err) {
        serverError(err);
      }
    }

    async function saveEdit(v) {
      const patch = {};
      if (v.email !== o.email) patch.email = v.email;
      for (const k of ['password', 'refresh_token', 'client_id', 'imap_host', 'login', 'note']) {
        if ((v[k] || '') !== (o[k] || '')) patch[k] = v[k];
      }
      if ((+v.imap_port || 0) !== (o.imap_port || 0)) patch.imap_port = +v.imap_port || 0;
      if (v.tags.join(',') !== (o.tags || []).join(',')) patch.tags = v.tags;
      if (v.status && v.status !== o.status) patch.status = v.status;
      if (!Object.keys(patch).length) {
        m.close();
        toast.info('Змін немає');
        return;
      }
      try {
        const updated = await api.patch(mbPath(o.email), patch);
        toast.success('Зміни збережено', { title: updated.email });
        mailboxesChanged('edit');
        m.close(updated);
        if (onSaved) onSaved(updated);
      } catch (err) {
        serverError(err);
      }
    }

    function serverError(err) {
      const hit = FIELD_BY_MESSAGE.find(([re]) => re.test(err.message || ''));
      if (hit && fields[hit[0]] && (err.status === 400 || err.status === 409)) {
        showErrors({ [hit[0]]: err.message.charAt(0).toUpperCase() + err.message.slice(1) });
      } else {
        mount(formError, banner('error', h('div', null, h('div', { class: 'banner-title' }, editing ? 'Не вдалося зберегти' : 'Не вдалося додати скриньку'), h('div', { class: 'banner-msg' }, err.message))));
      }
    }
  }
}
