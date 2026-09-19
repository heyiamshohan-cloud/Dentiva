/**
 * Dashboard — the clinic at a glance.
 *
 * Everything is read from `/api/dashboard/summary`; the Finance section stays a
 * separate screen by design (§ 8), so this page only shows the daily pulse.
 */
import { api } from '../core/api.js';
import { h, mount, bars, sparkline, statusPill } from '../core/dom.js';
import { amount, date, time, localizeDigits, addDays, today } from '../core/format.js';
import { setPageTitle } from '../main.js';
import { card, errorState, loading, statCard } from './ui.js';

export function dashboardScreen({ t }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.dashboard');

  async function load() {
    mount('#view', host);
    mount(host, loading(t));
    try {
      const [summary, alertData] = await Promise.all([
        api.get('/api/dashboard/summary'),
        api.get('/api/dashboard/alerts'),
      ]);
      mount(host, render(summary, alertData));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render(data, alertData) {
    const clinic = data.clinic ?? {};
    const money_ = data.money ?? {};
    const month = money_.monthToDate ?? {};
    const alertsBlock = data.alerts ?? {};
    const badge = (value) => (value ? h('span', { class: 'pill warn' }, localizeDigits(value)) : null);

    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [
          h('h2', {}, clinic.name ?? t('nav.dashboard')),
          h('p', { class: 'muted small' }, date(data.date)),
        ]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: () => window.location.assign('#/patients?new=1') }, t('dashboard.newPatient')),
        h('button', { type: 'button', class: 'primary', onclick: () => window.location.assign('#/appointments?new=1') }, t('dashboard.newAppointment')),
      ]),

      h('div', { class: 'cards' }, [
        statCard({
          label: t('dashboard.newToday'),
          value: localizeDigits(data.patients?.newToday ?? 0),
          delta: { text: `${t('dashboard.totalPatients')}: ${localizeDigits(data.patients?.total ?? 0)}` },
        }),
        statCard({
          label: t('dashboard.appointmentsToday'),
          value: localizeDigits(data.appointments?.total ?? 0),
          delta: { text: `${t('dashboard.upcoming')}: ${localizeDigits(data.appointments?.upcoming ?? 0)}` },
        }),
        statCard({
          label: t('dashboard.collectedToday'),
          value: amount(money_.collectedTodayMinor),
          tone: 'accent',
          delta: { text: `${t('dashboard.invoicedToday')}: ${amount(money_.invoicedTodayMinor)}` },
        }),
        statCard({
          label: t('dashboard.outstanding'),
          value: amount(money_.outstandingTotalMinor),
          delta: { text: `${t('dashboard.expensesToday')}: ${amount(money_.expensesTodayMinor)}`, tone: 'down' },
        }),
      ]),

      h('div', { class: 'two-col' }, [
        h('div', { class: 'stack' }, [
          card({
            title: t('dashboard.trend'),
            body: sparkline((data.trend14Days ?? []).map((point) => ({ label: date(point.date), value: point.collectedMinor ?? point.value ?? 0 })), { t }),
          }),
          card({
            title: t('dashboard.upcomingAppointments'),
            actions: [h('button', { type: 'button', class: 'link', onclick: () => window.location.assign('#/appointments') }, t('dashboard.viewAll'))],
            body: (data.upcomingAppointments ?? []).length
              ? h('div', { class: 'stack' }, (data.upcomingAppointments ?? []).map((row) => h('div', { class: 'timeline-item' }, [
                h('div', { class: 'timeline-icon' }, '❑'),
                h('div', {}, [
                  h('div', { class: 'strong' }, row.patient_name ?? row.patientName),
                  h('div', { class: 'small muted' }, [date(row.appt_date), ' · ', time(row.start_time), row.type_label ?? row.typeLabel ? ` · ${row.type_label ?? row.typeLabel}` : null]),
                ]),
                h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => window.location.assign(`#/patients/${row.patientId ?? ''}`),
                }, t('common.open')),
              ])))
              : h('p', { class: 'muted small' }, t('dashboard.noAlerts')),
          }),
        ]),
        h('div', { class: 'stack' }, [
          card({
            title: t('dashboard.queueNow'),
            actions: [h('button', { type: 'button', class: 'link', onclick: () => window.location.assign('#/queue') }, t('dashboard.viewAll'))],
            body: (data.queueNow ?? []).length
              ? h('div', { class: 'stack' }, (data.queueNow ?? []).map((entry) => h('div', { class: 'timeline-item' }, [
                h('div', { class: 'serial' }, localizeDigits(entry.serialNo ?? entry.serial_no)),
                h('div', {}, [
                  h('div', { class: 'strong' }, entry.patientName ?? entry.patient_name),
                  h('div', { class: 'small muted' }, `${entry.patientCode ?? ''}`),
                ]),
                statusPill(entry.status, t),
              ])))
              : h('p', { class: 'muted small' }, t('dashboard.noAlerts')),
          }),
          card({
            title: t('dashboard.alerts'),
            body: h('div', { class: 'stack' }, [
              row(t('dashboard.lowStock'), badge(alertsBlock.lowStock)),
              row(t('dashboard.expiringStock'), badge(alertsBlock.expiringSoon)),
              row(t('dashboard.pendingPayroll'), badge(alertsBlock.pendingPayrollRows)),
              h('div', { class: 'divider' }),
              row(t('dashboard.appointmentsToday'), h('span', {}, localizeDigits(data.appointments?.total ?? 0))),
              row(t('dashboard.completedToday'), h('span', {}, localizeDigits(data.appointments?.completed ?? 0))),
              row(t('dashboard.inQueue'), h('span', {}, localizeDigits(data.queue?.total ?? 0))),
              h('button', { type: 'button', class: 'link', onclick: () => window.location.assign('#/reports') }, t('dashboard.openReports')),
            ]),
          }),
        ]),
      ]),

      h('div', { class: 'two-col' }, [
        card({
          title: t('dashboard.topServices'),
          body: bars((data.topServicesThisMonth ?? []).map((row) => ({ label: row.name ?? row.serviceName ?? '—', value: row.count ?? row.totalMinor ?? 0 })), { t }),
        }),
        card({
          title: t('dashboard.monthToDate'),
          body: h('div', { class: 'stack' }, [
            kvRow(t('finance.invoiced'), amount(month.invoicedMinor), false),
            kvRow(t('finance.collected'), amount(month.collectedMinor), true),
            kvRow(t('finance.expenses'), amount(month.expensesMinor), false),
            kvRow(t('finance.outstanding'), amount(money_.outstandingTotalMinor ?? month.outstandingMinor), true),
            h('div', { class: 'divider' }),
            h('div', { class: 'row-actions' }, [
              h('button', { type: 'button', class: 'ghost', onclick: () => window.location.assign('#/finance') }, t('nav.finance')),
              h('button', { type: 'button', class: 'ghost', onclick: () => window.location.assign('#/receivables') }, t('nav.receivables')),
            ]),
          ]),
        }),
      ]),

      h('div', { class: 'grid-4' }, [
        statCard({ label: t('dashboard.visitsToday'), value: localizeDigits(data.clinical?.visitsToday ?? 0) }),
        statCard({ label: t('dashboard.treatmentsToday'), value: localizeDigits(data.clinical?.treatmentsToday ?? 0) }),
        statCard({ label: t('dashboard.followupsToday'), value: localizeDigits(data.clinical?.followupsToday ?? 0) }),
        statCard({ label: t('dashboard.totalPatients'), value: localizeDigits(data.patientTotals?.registryTotal ?? data.patients?.total ?? 0) }),
      ]),

      h('p', { class: 'help' }, `${t('dashboard.range')}: ${date(addDays(today(), -13))} → ${date(today())} · ${t('app.offline')}`),
    ];
  }

  function row(label, value) {
    return h('div', { class: 'row-actions' }, [
      h('span', { class: 'muted small' }, label),
      h('span', { class: 'spacer' }),
      value ?? h('span', { class: 'muted' }, '0'),
    ]);
  }

  function kvRow(label, value, strong) {
    return h('div', { class: 'row-actions' }, [
      h('span', { class: 'muted small' }, label),
      h('span', { class: 'spacer' }),
      h('span', { class: strong ? 'strong money' : 'money' }, value),
    ]);
  }

  load();
  return () => {};
}
