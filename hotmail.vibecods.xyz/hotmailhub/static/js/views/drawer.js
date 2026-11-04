// Mailbox drawer: header (status/health), «Листи» (messages, wait for code), «Деталі» (fields, secrets, actions).
import {
  h, icon, mount, openDrawer, uid, tabsEl, timeEl, skel, emptyState, errorBanner, copyButton, toast, openMenu,
  confirmDialog, withBusy, switchEl, spinner, copy,
} from '../ui.js';
import { api, isAbort, mbPath } from '../api.js';
import { STATUS, statusLabel, fmtNum, absTime, relTime, healthKey, HEALTH } from '../format.js';
import {
  statusPill, statusMenuItems, healthDot, healthTitle, codeChip, tagChip, kvList, secretField, leaseCountdown,
  updateCountdowns, providerText,
} from '../components.js';
import { mailboxesChanged } from '../store.js';
import { openMailboxForm } from './mailbox-form.js';

const WAIT_SECONDS = 120;

function folderBadge(folder) {
  const f = String(folder || '');
  const low = f.toLowerCase();
  if (low === 'inbox') return h('span', { class: 'badge tone-accent', title: f }, 'Вхідні');
  if (low.includes('junk') || low.includes('spam')) return h('span', { class: 'badge tone-amber', title: f }, 'Спам');
  return f ? h('span', { class: 'badge', title: f }, f) : null;
}

function senderName(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(String(from || ''));
  if (m) return { name: m[1] || m[2], address: m[2] };
  return { name: String(from || '—'), address: String(from || '') };
}

export function openMailboxDrawer(email, { onDismiss, onChanged, onRenamed, onDeleted } = {}) {
  let routeClose = false;
  let mailbox = null;
  let secrets = null;
  let waitCtrl = null;
  const titleId = uid('drawer-title');
  const d = openDrawer({
    labelledBy: titleId, className: 'mdrawer',
    onClose: () => {
      secrets = null;
      if (!routeClose && onDismiss) onDismiss();
    },
  });
  const { scope } = d;
  scope.add(() => {
    if (waitCtrl) waitCtrl.abort();
    secrets = null;
  });

  // ------------------------------------------------------------ header
  const titleEl = h('h2', { class: 'drawer-title mono', id: titleId, title: email }, email);
  const headMeta = h('div', { class: 'drawer-meta' }, skel('skel-pill'), skel('skel-line w-30'));
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Закрити панель', title: 'Закрити (Esc)', onClick: () => d.close() }, icon('x', { size: 18 }));
  const head = h('header', { class: 'drawer-head' },
    h('div', { class: 'drawer-head-top' },
      h('span', { class: 'drawer-avatar', 'aria-hidden': 'true' }, icon('mail', { size: 18 })),
      h('div', { class: 'drawer-title-wrap' }, titleEl, copyButton(() => email, { label: 'Копіювати email', what: 'Email' })),
      closeBtn),
    headMeta);

  const tabs = tabsEl({
    tabs: [{ id: 'messages', label: 'Листи', icon: 'inbox' }, { id: 'details', label: 'Деталі', icon: 'list' }],
    value: 'messages', label: 'Розділи скриньки', cls: 'drawer-tabs', onChange: (id) => showTab(id),
  });
  const msgPanel = h('div', { class: 'drawer-panel', role: 'tabpanel', id: 'panel-messages', 'aria-labelledby': 'tab-messages', tabindex: '-1' });
  const detPanel = h('div', { class: 'drawer-panel', role: 'tabpanel', id: 'panel-details', 'aria-labelledby': 'tab-details', tabindex: '-1', hidden: true });
  const bodyEl = h('div', { class: 'drawer-body' }, msgPanel, detPanel);
  mount(d.panel, head, tabs.el, bodyEl);

  function showTab(id) {
    msgPanel.hidden = id !== 'messages';
    detPanel.hidden = id !== 'details';
    bodyEl.scrollTop = 0;
  }

  // ------------------------------------------------------------ mailbox data
  async function loadMailbox() {
    try {
      mailbox = await api.get(mbPath(email), null, { signal: scope.signal });
      if (scope.disposed) return;
      renderHead();
      renderDetails();
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      if (err.status === 404) {
        mount(headMeta, h('span', { class: 'pill st-invalid' }, h('span', { class: 'dot' }), 'Не знайдено'));
        mount(msgPanel, emptyState({ iconName: 'search', title: 'Скриньку не знайдено', text: `${email} немає в базі — можливо, її видалили або перейменували.` }));
        mount(detPanel);
        tabs.el.hidden = true;
        return;
      }
      mount(headMeta, h('span', { class: 'muted' }, 'Не вдалося завантажити'));
      mount(detPanel, errorBanner({ message: err.message, onRetry: loadMailbox }));
    }
  }

  function renderHead() {
    const hk = healthKey(mailbox.health);
    const pill = statusPill(mailbox.status, { onClick: (e) => openMenu(e.currentTarget, statusMenuItems(mailbox.status, setStatus), { align: 'start', label: 'Змінити статус' }) });
    mount(headMeta,
      pill,
      h('span', { class: `health health-${hk}`, title: healthTitle(mailbox.health) },
        healthDot(mailbox.health, { withTitle: false }), HEALTH[hk].label,
        mailbox.health.checked_at ? h('span', { class: 'muted' }, `· ${relTime(mailbox.health.checked_at)}`) : null),
      h('span', { class: 'drawer-provider' }, providerText(mailbox)),
      mailbox.lease ? h('span', { class: 'drawer-lease', title: `Оренда: ${mailbox.lease.owner || '—'}` }, icon('clock', { size: 13 }), leaseCountdown(mailbox.lease)) : null);
  }

  async function setStatus(status) {
    try {
      mailbox = await api.post(mbPath(email, '/status'), { status });
      toast.success(`Статус: «${statusLabel(status)}»`, { title: email });
      renderHead();
      renderDetails();
      changed();
    } catch (err) {
      toast.error(err.message);
    }
  }

  function changed() {
    mailboxesChanged('drawer');
    if (onChanged) onChanged();
  }

  // ------------------------------------------------------------ messages tab
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-sm', title: 'Завантажити нові листи з INBOX і Junk' }, icon('refresh', { size: 14 }), 'Оновити');
  const waitBtn = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, icon('hourglass', { size: 14 }), 'Чекати код');
  const fetchedEl = h('span', { class: 'msg-fetched' });
  const waitSlot = h('div', { class: 'wait-slot' });
  const msgAlert = h('div', { class: 'alert-slot' });
  const msgList = h('div', { class: 'msg-list' }, Array.from({ length: 3 }, () => h('div', { class: 'msg is-skel' }, skel('skel-line w-40'), skel('skel-line w-80'), skel('skel-line sm w-90'))));
  mount(msgPanel, h('div', { class: 'msg-toolbar' }, refreshBtn, waitBtn, h('div', { class: 'grow' }), fetchedEl), waitSlot, msgAlert, msgList);

  refreshBtn.addEventListener('click', () => withBusy(refreshBtn, () => loadMessages(true)));
  waitBtn.addEventListener('click', () => waitForCode());

  async function loadMessages(refresh = false) {
    try {
      const res = await api.get(mbPath(email, '/messages'), { refresh: refresh ? 1 : '', limit: 50 }, { signal: scope.signal });
      if (scope.disposed) return;
      mount(msgAlert);
      fetchedEl.textContent = res.fetched_at ? `Оновлено ${relTime(res.fetched_at)}` : 'Ще не завантажувались із пошти';
      fetchedEl.title = res.fetched_at ? absTime(res.fetched_at) : '';
      renderMessages(res.items);
      if (refresh) {
        toast.success(res.items.length ? `Листів: ${fmtNum(res.items.length)}` : 'Нових листів немає', { title: 'Пошту оновлено', timeout: 2200 });
        loadMailbox();
        changed();
      }
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      if (err.status === 404) return;
      mount(msgAlert, errorBanner({
        title: err.code === 'auth_failed' ? 'Вхід у пошту не працює' : err.status === 503 ? 'Пошта тимчасово недоступна' : 'Не вдалося отримати листи',
        message: err.message,
        onRetry: () => withBusy(refreshBtn, () => loadMessages(true)),
      }));
      if (err.code === 'auth_failed') {
        loadMailbox();
        changed();
      }
      if (!msgList.querySelector('.msg:not(.is-skel)')) mount(msgList);
    }
  }

  function renderMessages(items) {
    if (!items.length) {
      mount(msgList, emptyState({
        iconName: 'mailOpen', title: 'Листів ще немає', compact: true,
        text: 'Збережених листів немає. Завантажте свіжі з пошти або натисніть «Чекати код».',
        actions: [h('button', { type: 'button', class: 'btn btn-sm', onClick: () => withBusy(refreshBtn, () => loadMessages(true)) }, icon('refresh', { size: 14 }), 'Оновити з пошти')],
      }));
      return;
    }
    mount(msgList, items.map(messageItem));
  }

  function messageItem(m) {
    const sender = senderName(m.from);
    const bodyBox = h('div', { class: 'msg-body', hidden: true });
    const headBtn = h('button', { type: 'button', class: 'msg-head', 'aria-expanded': 'false' },
      h('div', { class: 'msg-top' },
        h('span', { class: 'msg-from truncate', title: m.from }, sender.name),
        folderBadge(m.folder),
        m.delivered ? h('span', { class: 'badge tone-green', title: 'Код із цього листа вже видавали через API' }, 'видано') : null,
        h('span', { class: 'grow' }),
        timeEl(m.received_at, { cls: 'msg-time' }),
        icon('chevronDown', { size: 15, cls: 'msg-caret' })),
      h('div', { class: 'msg-subject' }, m.subject || '(без теми)'),
      m.snippet ? h('div', { class: 'msg-snippet' }, m.snippet) : null);
    const codes = (m.codes || []).length ? h('div', { class: 'msg-codes' }, h('span', { class: 'msg-codes-label' }, 'Код:'), m.codes.map((c) => codeChip(c))) : null;
    const item = h('article', { class: 'msg', dataset: { id: String(m.id) } }, headBtn, codes, bodyBox);
    let loaded = false;
    headBtn.addEventListener('click', async () => {
      const open = headBtn.getAttribute('aria-expanded') !== 'true';
      headBtn.setAttribute('aria-expanded', String(open));
      item.classList.toggle('is-open', open);
      bodyBox.hidden = !open;
      if (!open || loaded) return;
      mount(bodyBox, h('div', { class: 'msg-loading' }, spinner(), 'Завантаження листа…'));
      try {
        const full = await api.get(mbPath(email, `/messages/${m.id}`), null, { signal: scope.signal });
        loaded = true;
        const meta = h('div', { class: 'msg-meta' },
          h('div', null, h('span', { class: 'muted' }, 'Від: '), full.from || '—'),
          full.to ? h('div', null, h('span', { class: 'muted' }, 'Кому: '), full.to) : null,
          h('div', null, h('span', { class: 'muted' }, 'Отримано: '), absTime(full.received_at)));
        mount(bodyBox, meta,
          h('pre', { class: 'msg-pre', tabindex: '0', 'aria-label': 'Текст листа' }, full.body || '(порожній лист)'),
          h('div', { class: 'msg-body-actions' }, copyButton(() => full.body || '', { text: 'Копіювати текст', label: 'Копіювати текст листа', what: 'Текст листа', size: 14 })));
      } catch (err) {
        if (isAbort(err)) return;
        mount(bodyBox, errorBanner({ title: 'Не вдалося відкрити лист', message: err.message }));
      }
    });
    return item;
  }

  // ------------------------------------------------------------ wait for code
  function waitForCode() {
    if (waitCtrl) return;
    waitCtrl = new AbortController();
    const ctrl = waitCtrl;
    const started = Date.now();
    waitBtn.disabled = true;
    const secEl = h('span', { class: 'wait-sec num' }, '0');
    const ringFill = h('span', { class: 'wait-ring-fill' });
    mount(waitSlot, h('div', { class: 'wait-card', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'wait-ring', 'aria-hidden': 'true' }, ringFill, secEl),
      h('div', { class: 'wait-text' },
        h('div', { class: 'wait-title' }, 'Чекаємо на код…'),
        h('div', { class: 'wait-sub' }, `Сервер опитує пошту, доки не надійде новий лист (до ${WAIT_SECONDS} с).`)),
      h('button', { type: 'button', class: 'btn btn-sm', onClick: () => ctrl.abort() }, icon('x', { size: 14 }), 'Скасувати')));
    const timer = setInterval(() => {
      const sec = Math.floor((Date.now() - started) / 1000);
      secEl.textContent = String(sec);
      ringFill.style.setProperty('--p', String(Math.min(1, sec / WAIT_SECONDS)));
    }, 250);
    const finish = () => {
      clearInterval(timer);
      waitCtrl = null;
      waitBtn.disabled = false;
    };
    scope.add(() => clearInterval(timer));
    api.get(mbPath(email, '/code'), { wait: WAIT_SECONDS, fresh: 1, any: 0 }, { signal: ctrl.signal })
      .then((res) => {
        finish();
        if (scope.disposed) return;
        const took = Math.max(1, Math.round((Date.now() - started) / 1000));
        if (res.found) {
          showCode(res, took);
          toast.success(`Код ${res.code} отримано`, { title: email });
          loadMessages(false);
          loadMailbox();
          changed();
        } else {
          mount(waitSlot, h('div', { class: 'banner banner-warning wait-none' },
            icon('clock', { size: 17, cls: 'banner-ico' }),
            h('div', { class: 'banner-body' }, h('div', { class: 'banner-title' }, `Код не надійшов за ${res.waited || WAIT_SECONDS} с`),
              h('div', { class: 'banner-msg' }, 'Переконайтеся, що лист надіслано саме на цю адресу, і спробуйте ще раз.')),
            h('button', { type: 'button', class: 'btn btn-sm', onClick: () => waitForCode() }, 'Спробувати ще')));
        }
      })
      .catch((err) => {
        finish();
        if (scope.disposed) return;
        if (isAbort(err)) {
          mount(waitSlot);
          toast.info('Очікування коду скасовано', { timeout: 2000 });
          return;
        }
        mount(waitSlot, errorBanner({
          title: err.code === 'auth_failed' ? 'Вхід у пошту не працює — скринька стала «Недійсною»' : 'Не вдалося дочекатися коду',
          message: err.message, onRetry: () => waitForCode(),
        }));
        if (err.code === 'auth_failed') {
          loadMailbox();
          changed();
        }
      });
  }

  function showCode(res, took) {
    const sender = senderName(res.from);
    mount(waitSlot, h('div', { class: 'code-result' },
      h('div', { class: 'code-result-head' }, icon('checkCircle', { size: 16 }), `Код отримано за ${took} с`,
        h('button', { type: 'button', class: 'icon-btn icon-btn-sm code-result-x', 'aria-label': 'Сховати', onClick: () => mount(waitSlot) }, icon('x', { size: 14 }))),
      codeChip(res.code, { size: 'lg', title: 'Натисніть, щоб скопіювати код' }),
      h('div', { class: 'code-result-meta' },
        h('span', { class: 'truncate', title: res.subject || '' }, res.subject ? `«${res.subject}»` : '(без теми)'),
        h('span', { class: 'muted truncate', title: res.from || '' }, `від ${sender.name}`)),
      (res.codes || []).length > 1 ? h('div', { class: 'code-result-alt' }, h('span', { class: 'muted' }, 'Інші збіги:'), res.codes.slice(1).map((c) => codeChip(c, { size: 'sm' }))) : null,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: () => copy(res.code, `Код ${res.code}`) }, icon('copy', { size: 14 }), 'Копіювати'),
        h('button', { type: 'button', class: 'btn btn-sm', onClick: () => waitForCode() }, icon('hourglass', { size: 14 }), 'Чекати наступний'))));
  }

  // ------------------------------------------------------------ details tab
  const checkResult = h('div', { class: 'check-result-slot' });
  let secretsSwitch = null;
  const secretsBox = h('div', { class: 'secrets-box', hidden: true });

  function renderDetails() {
    if (!mailbox) return;
    const m = mailbox;
    const editBtn = h('button', { type: 'button', class: 'btn btn-sm', onClick: () => edit() }, icon('edit', { size: 14 }), 'Редагувати');
    const checkBtn = h('button', { type: 'button', class: 'btn btn-sm', title: 'Перевірити вхід у пошту зараз', onClick: () => withBusy(checkBtn, checkNow) }, icon('shieldCheck', { size: 14 }), 'Перевірити');
    const statusBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-haspopup': 'menu' }, icon('dotCircle', { size: 14 }), 'Змінити статус', icon('chevronDown', { size: 13, cls: 'btn-caret' }));
    statusBtn.addEventListener('click', () => openMenu(statusBtn, statusMenuItems(m.status, setStatus), { align: 'start', label: 'Змінити статус' }));
    const delBtn = h('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm', onClick: () => remove() }, icon('trash', { size: 14 }), 'Видалити');

    const hk = healthKey(m.health);
    const imapServer = m.type === 'imap'
      ? (m.imap_host ? `${m.imap_host}${m.imap_port ? `:${m.imap_port}` : ''}` : h('span', { class: 'muted' }, `за доменом (${m.provider})`))
      : null;
    const rows = [
      ['Тип', m.type === 'oauth2' ? 'OAuth2 (Hotmail / Outlook)' : 'IMAP'],
      ['Провайдер', m.provider],
      m.type === 'imap' ? ['IMAP-сервер', imapServer] : null,
      m.type === 'imap' ? ['Логін IMAP', m.login ? h('span', { class: 'mono' }, m.login) : h('span', { class: 'muted' }, 'як email')] : null,
      ['Пароль', m.has_password ? 'задано' : h('span', { class: 'muted' }, 'немає')],
      ['Теги', m.tags.length ? h('span', { class: 'tags' }, m.tags.map((t) => tagChip(t))) : null],
      ['Нотатка', m.note ? h('span', { class: 'kv-note' }, m.note) : null],
      ['Видач BAS', fmtNum(m.uses)],
      ['Листів у скриньці', m.health.messages !== null && m.health.messages !== undefined ? fmtNum(m.health.messages) : null],
      ['Останній код', m.last_code ? h('span', { class: 'kv-inline' }, codeChip(m.last_code.code, { size: 'sm' }), timeEl(m.last_code.at)) : null],
      m.lease ? ['Оренда', h('span', { class: 'kv-inline' }, h('span', null, m.lease.owner || 'без власника'), h('span', { class: 'muted' }, `до ${absTime(m.lease.until)}`), leaseCountdown(m.lease))] : null,
      ['Остання перевірка', h('div', { class: 'kv-check' },
        h('span', { class: `health health-${hk}` }, healthDot(m.health, { withTitle: false }), HEALTH[hk].label,
          m.health.checked_at ? h('span', { class: 'muted' }, `· ${absTime(m.health.checked_at)}`) : null),
        m.health.error ? h('div', { class: 'kv-error' }, m.health.error) : null)],
      ['Додано', h('span', { title: absTime(m.created_at) }, absTime(m.created_at))],
      ['Оновлено', h('span', { class: 'kv-inline' }, absTime(m.updated_at), h('span', { class: 'muted' }, `(${relTime(m.updated_at)})`))],
    ];

    if (!secretsSwitch) {
      secretsSwitch = switchEl({ label: 'Показати секрети', onChange: (on) => toggleSecrets(on) });
    }
    mount(detPanel,
      h('div', { class: 'det-actions btn-row' }, editBtn, checkBtn, statusBtn, h('span', { class: 'grow' }), delBtn),
      checkResult,
      h('section', { class: 'det-section' }, h('h3', { class: 'det-title' }, 'Параметри'), kvList(rows)),
      h('section', { class: 'det-section det-secrets' },
        h('div', { class: 'det-secrets-head' },
          h('div', null, h('h3', { class: 'det-title' }, icon('lock', { size: 14 }), 'Секрети'),
            h('p', { class: 'det-hint' }, 'Пароль, refresh_token і client_id завантажуються лише на ваш запит і не зберігаються в браузері.')),
          secretsSwitch.el),
        secretsBox));
  }

  async function toggleSecrets(on) {
    if (!on) {
      secrets = null;
      mount(secretsBox);
      secretsBox.hidden = true;
      return;
    }
    secretsBox.hidden = false;
    mount(secretsBox, h('div', { class: 'msg-loading' }, spinner(), 'Завантаження секретів…'));
    try {
      const full = await api.get(mbPath(email), { secrets: 1 }, { signal: scope.signal });
      if (scope.disposed || !secretsSwitch.input.checked) return;
      secrets = { password: full.password || '', refresh_token: full.refresh_token || '', client_id: full.client_id || '', line: full.line || '' };
      mount(secretsBox,
        secretField('Пароль', secrets.password),
        secretField('refresh_token', secrets.refresh_token, { wide: true }),
        secretField('client_id', secrets.client_id),
        secretField('Рядок для BAS (mails.txt)', secrets.line, { wide: true }));
    } catch (err) {
      if (isAbort(err)) return;
      secretsSwitch.input.checked = false;
      mount(secretsBox, errorBanner({ title: 'Не вдалося отримати секрети', message: err.message }));
    }
  }

  async function checkNow() {
    mount(checkResult, h('div', { class: 'check-result is-pending' }, spinner(), 'Перевіряємо вхід…'));
    try {
      const r = await api.post(mbPath(email, '/check'), {}, { signal: scope.signal });
      const ok = r.ok;
      mount(checkResult, h('div', { class: `check-result ${ok ? 'tone-green' : 'tone-red'}` },
        icon(ok ? 'checkCircle' : 'alertCircle', { size: 17 }),
        h('div', { class: 'grow min0' },
          h('div', { class: 'check-result-title' }, ok ? 'Вхід працює' : (r.kind === 'temp' ? 'Тимчасова помилка' : 'Помилка входу')),
          h('div', { class: 'check-result-sub' }, ok
            ? `Листів у скриньці: ${r.messages !== null && r.messages !== undefined ? fmtNum(r.messages) : '—'} · ${fmtNum(r.ms)} мс`
            : `${r.error}${r.status !== mailbox.status ? ` · статус → «${statusLabel(r.status)}»` : ''}`))));
      await loadMailbox();
      changed();
    } catch (err) {
      if (isAbort(err)) return;
      mount(checkResult, errorBanner({ title: 'Перевірку не виконано', message: err.message }));
    }
  }

  function edit() {
    openMailboxForm({
      email,
      onSaved: (updated) => {
        if (updated.email !== email) {
          routeClose = true;
          d.close();
          if (onRenamed) onRenamed(updated.email);
          return;
        }
        mailbox = updated;
        if (secretsSwitch && secretsSwitch.input.checked) toggleSecrets(true);
        renderHead();
        renderDetails();
        if (onChanged) onChanged();
      },
    });
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Видалити скриньку?', danger: true, confirmText: 'Видалити',
      message: `${email} буде видалено разом зі збереженими листами. Цю дію не можна скасувати.`,
    });
    if (!ok) return;
    try {
      await api.del(mbPath(email));
      toast.success(`${email} видалено`);
      mailboxesChanged('delete');
      routeClose = true;
      d.close();
      if (onDeleted) onDeleted();
    } catch (err) {
      toast.error(err.message);
    }
  }

  scope.interval(() => updateCountdowns(d.panel), 1000);
  loadMailbox();
  loadMessages(false);

  return {
    email,
    close() {
      routeClose = true;
      d.close();
    },
  };
}
