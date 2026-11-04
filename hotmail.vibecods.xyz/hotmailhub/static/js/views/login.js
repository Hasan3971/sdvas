// Login screen (replaces the whole app while unauthenticated).
import { h, icon, mount, createScope, mount as setContent } from '../ui.js';
import { api } from '../api.js';

export function renderLogin(root, { onSuccess, notice = '' }) {
  const scope = createScope();
  const input = h('input', {
    type: 'password', id: 'login-password', class: 'input input-lg', autocomplete: 'current-password',
    required: true, autofocus: true, spellcheck: 'false', 'aria-describedby': 'login-error',
  });
  const eye = h('button', { type: 'button', class: 'icon-btn input-affix', 'aria-label': 'Показати пароль', 'aria-pressed': 'false' }, icon('eye', { size: 17 }));
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.setAttribute('aria-label', show ? 'Сховати пароль' : 'Показати пароль');
    setContent(eye, icon(show ? 'eyeOff' : 'eye', { size: 17 }));
    input.focus();
  });
  const errorEl = h('div', { class: 'login-error', id: 'login-error', role: 'alert', hidden: !notice }, notice ? icon('info', { size: 15 }) : null, notice);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, 'Увійти', icon('arrowRight', { size: 17 }));
  let lockedUntil = 0;

  const showError = (text, kind = 'error') => {
    mount(errorEl, icon(kind === 'error' ? 'alertCircle' : 'info', { size: 15 }), h('span', null, text));
    errorEl.hidden = false;
    errorEl.classList.toggle('is-info', kind !== 'error');
  };

  function lockFor(seconds) {
    lockedUntil = Date.now() + seconds * 1000;
    submit.disabled = true;
    const tick = () => {
      const left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left <= 0) {
        submit.disabled = false;
        showError('Можна спробувати знову.', 'info');
        return;
      }
      showError(`Забагато спроб входу. Повторіть через ${left} с.`);
      scope.timeout(tick, 1000);
    };
    tick();
  }

  const form = h('form', { class: 'login-form', novalidate: true },
    h('label', { class: 'field-label', for: 'login-password' }, 'Пароль адміністратора'),
    h('div', { class: 'input-wrap' }, input, eye),
    errorEl,
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submit.disabled) return;
    const password = input.value;
    if (!password) {
      showError('Введіть пароль.');
      input.focus();
      return;
    }
    submit.classList.add('is-busy');
    submit.disabled = true;
    errorEl.hidden = true;
    try {
      const res = await api.post('/api/v1/auth/login', { password }, { authRedirect: false });
      await onSuccess(res.csrf);
    } catch (err) {
      if (scope.disposed) return;
      submit.classList.remove('is-busy');
      submit.disabled = false;
      if (err.status === 429) lockFor(err.retryAfter || 60);
      else if (err.status === 401) {
        showError('Невірний пароль. Спробуйте ще раз.');
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        input.select();
      } else showError(err.message || 'Не вдалося увійти.');
      input.focus();
    } finally {
      if (!scope.disposed) submit.classList.remove('is-busy');
    }
  });

  mount(root, h('main', { class: 'login' },
    h('div', { class: 'login-bg', 'aria-hidden': 'true' }),
    h('div', { class: 'login-card' },
      h('div', { class: 'login-brand' },
        h('span', { class: 'brand-mark brand-mark-lg', 'aria-hidden': 'true' }),
        h('div', { class: 'login-brand-text' }, h('div', { class: 'brand-name' }, 'Hotmail Hub'), h('div', { class: 'brand-sub' }, 'vibecods'))),
      h('h1', { class: 'login-title' }, 'Вхід у панель'),
      h('p', { class: 'login-sub' }, 'Пул скриньок Hotmail / Outlook / IMAP і коди підтвердження для BAS.'),
      form),
    h('p', { class: 'login-foot' }, icon('lock', { size: 13 }), 'Сесія зберігається в захищеному cookie на 7 днів')));
  requestAnimationFrame(() => input.focus());
  return scope;
}
