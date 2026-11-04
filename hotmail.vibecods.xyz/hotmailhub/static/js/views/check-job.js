// Bulk login check: POST /api/v1/check → poll GET /api/v1/jobs/{id}; reusable progress widget.
import { h, icon, mount, openModal, progressBar, spinner, errorBanner } from '../ui.js';
import { api, isAbort } from '../api.js';
import { fmtNum } from '../format.js';
import { statusPill } from '../components.js';
import { mailboxesChanged } from '../store.js';

/** Live progress for a job object; polls until done. */
export function jobProgress(initialJob, scope, { onDone } = {}) {
  const bar = progressBar(0, 1, { label: 'Хід перевірки' });
  const head = h('div', { class: 'job-head' });
  const counts = h('div', { class: 'job-counts' });
  const failures = h('div', { class: 'job-failures' });
  const el = h('div', { class: 'job', 'aria-live': 'polite' }, head, bar.el, counts, failures);
  let finished = false;

  const stat = (label, value, tone) => h('div', { class: `job-stat tone-${tone}` },
    h('span', { class: 'job-stat-value' }, fmtNum(value)), h('span', { class: 'job-stat-label' }, label));

  function render(job) {
    const done = job.state === 'done';
    bar.set(job.done, job.total || 1);
    el.classList.toggle('is-done', done);
    mount(head,
      done ? icon(job.failed ? 'alertCircle' : 'checkCircle', { size: 18, cls: job.failed ? 'tone-amber' : 'tone-green' }) : spinner(),
      h('span', { class: 'job-title' }, done ? 'Перевірку завершено' : 'Перевіряємо вхід…'),
      h('span', { class: 'job-frac' }, `${fmtNum(job.done)} з ${fmtNum(job.total)}`));
    mount(counts, stat('вхід працює', job.ok, 'green'), stat('помилки', job.failed, 'red'), stat('залишилось', Math.max(0, job.total - job.done), 'grey'));
    const bad = (job.results || []).filter((r) => !r.ok);
    mount(failures, bad.length ? [
      h('div', { class: 'job-fail-title' }, `Не вдалося увійти — ${fmtNum(bad.length)}`),
      h('ul', { class: 'job-fail-list' }, bad.slice(0, 300).map((r) => h('li', { class: 'job-fail' },
        h('span', { class: 'job-fail-email mono' }, r.email),
        r.status ? statusPill(r.status) : null,
        h('span', { class: 'job-fail-err' }, r.kind === 'temp' ? `Тимчасова помилка: ${r.error || '—'}` : (r.error || 'помилка входу'))))),
    ] : []);
  }

  function finish(job) {
    if (finished) return;
    finished = true;
    mailboxesChanged('check');
    if (onDone) onDone(job);
  }

  const tick = async () => {
    if (scope.disposed) return;
    try {
      const job = await api.get(`/api/v1/jobs/${encodeURIComponent(initialJob.id)}`, null, { signal: scope.signal });
      render(job);
      if (job.state === 'done') {
        finish(job);
        return;
      }
    } catch (err) {
      if (isAbort(err) || scope.disposed) return;
      if (err.status === 404) {
        mount(head, icon('alertCircle', { size: 18 }), h('span', { class: 'job-title' }, 'Задачу не знайдено — можливо, сервер перезапустився.'));
        return;
      }
    }
    scope.timeout(tick, document.hidden ? 4000 : 800);
  };

  render(initialJob);
  if (initialJob.state === 'done') finish(initialJob);
  else scope.timeout(tick, 500);
  return el;
}

/**
 * Opens the progress modal for a bulk check.
 * body: {emails:[…]} or filter fields {status,q,type,tag,health}; {} checks every mailbox.
 */
export function startCheck({ body = {}, label = '' } = {}) {
  const m = openModal({ title: 'Перевірка входу', subtitle: label, size: 'md', className: 'modal-job' });
  const closeBtn = h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Закрити');
  m.setBody(h('div', { class: 'job-start' }, spinner(), 'Запускаємо перевірку…'));
  m.setFooter(h('span', { class: 'modal-foot-note' }, icon('info', { size: 14 }), 'Перевірка триває на сервері, навіть якщо закрити це вікно.'), closeBtn);
  api.post('/api/v1/check', body, { signal: m.scope.signal })
    .then((job) => {
      m.setBody(jobProgress(job, m.scope, {
        onDone: (done) => {
          closeBtn.className = 'btn btn-primary';
          closeBtn.textContent = 'Готово';
          m.setSubtitle(`${label ? `${label} · ` : ''}${fmtNum(done.ok)} працюють, ${fmtNum(done.failed)} з помилками`);
          closeBtn.focus();
        },
      }));
    })
    .catch((err) => {
      if (isAbort(err)) return;
      m.setBody(errorBanner({ title: 'Не вдалося запустити перевірку', message: err.message }));
    });
  return m;
}
