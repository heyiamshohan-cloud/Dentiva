/**
 * Scheduling: appointments, day/agenda views, month calendar and the live queue.
 */
import { api } from '../core/api.js';
import { can, state } from '../core/store.js';
import { enumLabel, form as buildForm, h, mount, openModal, statusPill, toast } from '../core/dom.js';
import { addDays, date, localizeDigits, time, today } from '../core/format.js';
import { navigate } from '../core/router.js';
import { setPageTitle } from '../main.js';
import { printDocument } from '../core/print.js';
import { card, confirmAction, emptyState, errorState, formModal, kv, listScreen, loading, recordLayout, tabs } from './ui.js';

const STATUSES = ['scheduled', 'checked_in', 'waiting', 'in_treatment', 'completed', 'cancelled', 'no_show'];

/** Patient picker backed by the quick search endpoint. */
export function patientPicker(onPick, t, initial = '') {
  const input = h('input', { type: 'search', placeholder: t('nav.search'), value: initial, autocomplete: 'off' });
  const results = h('div', { class: 'search-panel' });
  let timer = 0;
  const run = async () => {
    const term = input.value.trim();
    if (term.length < 2) {
      mount(results, []);
      return;
    }
    try {
      const payload = await api.get('/api/search/quick', { q: term, limit: 6 });
      const rows = payload?.rows ?? payload?.patients ?? payload ?? [];
      mount(results, rows.map((row) => h('div', {
        class: 'search-hit',
        onclick: () => {
          onPick(row);
          input.value = row.fullName ?? row.name ?? '';
          mount(results, []);
        },
      }, [
        h('div', {}, [h('div', { class: 'strong' }, row.fullName ?? row.name), h('div', { class: 'small muted' }, row.patientCode ?? row.code ?? '')]),
      ])));
    } catch (error) {
      mount(results, [h('div', { class: 'alert' }, error.message)]);
    }
  };
  input.addEventListener('input', () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(run, 250);
  });
  return h('div', { class: 'stack' }, [h('label', {}, [h('span', {}, t('common.selectPatient')), input]), results]);
}

/* ------------------------------------------------------------- appointments */

export function appointmentsScreen({ t, query }) {
  setPageTitle('nav.appointments');
  const day = query?.get('date') ?? today();
  let pickedPatient = null;
  /** @type {any[]|null} */
  let practitionerRows = null;

  const loadPractitioners = async () => {
    if (practitionerRows) return practitionerRows;
    const payload = await api.get('/api/staff', { isPractitioner: true, pageSize: 100 });
    practitionerRows = payload?.rows ?? [];
    return practitionerRows;
  };

  const openCreate = async (presetPatient = null) => {
    pickedPatient = presetPatient;
    const practitioners = (await loadPractitioners().catch(() => [])) ?? [];
    const types = (await api.get('/api/appointments/types/list').catch(() => ({ rows: [] })))?.rows ?? [];
    const fields = [
      { name: 'practitioner_id', label: 'staff.practitioner', type: 'select', numericValues: true, options: [{ value: '', label: 'common.none' }, ...practitioners.map((p) => ({ value: p.id, label: p.fullName }))] },
      { name: 'type_id', label: 'appointments.type', type: 'select', numericValues: true, options: [{ value: '', label: 'common.none' }, ...types.map((type) => ({ value: type.id, label: type.nameEn }))] },
      { name: 'appt_date', label: 'common.date', type: 'date', required: true, value: day },
      { name: 'start_time', label: 'common.time', type: 'time', required: true },
      { name: 'duration_minutes', label: 'appointments.duration', type: 'number', min: 5, step: 5 },
      { name: 'reason', label: 'appointments.reason', span: 2 },
      { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
    ];
    const modal = openModal({
      title: t('appointments.new'),
      wide: true,
      body: h('div', { class: 'stack' }, [
        h('div', { id: 'patientPickerSlot' }, presetPatient
          ? h('p', { class: 'help' }, `${t('common.selectPatient')} · ${t('patients.code')} ${presetPatient}`)
          : patientPicker((patient) => { pickedPatient = patient; }, t)),
        h('div', { id: 'appointmentForm' }),
      ]),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
      ],
    });

    const builder = buildForm(fields.filter((field) => field.name !== 'patient'), t, {
      values: { appt_date: day, duration_minutes: state.settings['appointments.defaultDuration'] ?? 30 },
    });
    mount('#appointmentForm', [builder.form]);

    async function save() {
      if (!pickedPatient?.id && !pickedPatient?.entityId) {
        toast({ message: t('common.selectPatient'), tone: 'warn' });
        return;
      }
      try {
        const values = builder.values();
        const created = await api.post('/api/appointments', {
          ...values,
          patient_id: pickedPatient.id ?? pickedPatient.entityId,
        });
        modal.close();
        toast({ message: t('common.saved'), tone: 'ok' });
        if (created?.id) navigate(`/appointments/${created.id}`);
        else screen.reload();
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }
  };

  const screen = listScreen({
    t,
    title: t('nav.appointments'),
    subtitle: t('appointments.subtitle'),
    endpoint: '/api/appointments',
    query: { date: query?.get('date') ?? undefined, patientId: query?.get('patientId') ?? undefined },
    filters: [
      { name: 'status', options: [{ value: '', label: 'common.all' }, ...STATUSES.map((value) => ({ value, label: `status.${value}` }))] },
      { name: 'date', options: [{ value: '', label: 'common.allTime' }, { value: today(), label: 'common.today' }, { value: addDays(today(), 1), label: 'appointments.tomorrow' }] },
    ],
    onCreate: can('appointments.create') ? () => openCreate(null) : null,
    onRowClick: (row) => navigate(`/appointments/${row.id}`),
    columns: [
      { key: 'appointmentCode', label: 'appointments.code', width: '140px' },
      { key: 'apptDate', label: 'common.date', date: true, width: '110px' },
      { key: 'startTime', label: 'common.time', time: true, width: '90px' },
      { key: 'patientName', label: 'patients.fullName', render: (row) => h('div', {}, [h('div', { class: 'strong' }, row.patientName), h('div', { class: 'small muted' }, row.patientCode ?? '')]) },
      { key: 'practitionerName', label: 'staff.practitioner' },
      { key: 'typeLabel', label: 'appointments.type' },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
      {
        label: 'common.actions',
        className: 'actions',
        render: (row) => h('div', { class: 'row-actions' }, [
          can('appointments.edit') && row.status === 'scheduled' ? h('button', {
            type: 'button',
            class: 'link',
            onclick: () => changeStatus(row.id, 'checked_in'),
          }, t('appointments.checkIn')) : null,
          can('appointments.edit') && ['checked_in', 'waiting'].includes(row.status) ? h('button', {
            type: 'button',
            class: 'link',
            onclick: () => changeStatus(row.id, 'completed'),
          }, t('appointments.complete')) : null,
          can('appointments.cancel') && !['cancelled', 'completed'].includes(row.status) ? h('button', {
            type: 'button',
            class: 'link',
            onclick: () => confirmAction({
              t,
              title: t('appointments.cancelTitle') ?? t('common.cancel'),
              message: row.appointmentCode,
              danger: true,
              confirmLabel: t('common.cancel'),
              run: () => api.del(`/api/appointments/${row.id}`, { reason: 'cancelled' }),
              onDone: screen.reload,
            }),
          }, t('common.cancel')) : null,
        ]),
      },
    ],
  });

  if (query?.get('new') === '1' && can('appointments.create')) openCreate(null);
  return screen.element;
}

async function changeStatus(id, status) {
  try {
    await api.post(`/api/appointments/${id}/status`, { status });
    window.location.reload();
  } catch (error) {
    toast({ message: error.message, tone: 'error' });
  }
}

export function appointmentDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.appointments');
  let appointment = null;

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      appointment = await api.get(`/api/appointments/${id}`);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    return recordLayout({
      t,
      title: `${appointment.appointmentCode} · ${appointment.patientName ?? ''}`,
      subtitle: `${date(appointment.apptDate)} · ${time(appointment.startTime)} – ${time(appointment.endTime)}`,
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [
        statusPill(appointment.status, t),
        appointment.practitionerName ? h('span', { class: 'pill' }, appointment.practitionerName) : null,
        appointment.typeLabel ? h('span', { class: 'pill' }, appointment.typeLabel) : null,
      ]),
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/patients/${appointment.patientId}`) }, t('patients.profile')),
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('appointment-slip', appointment.id, { t }) }, t('common.print')),
        can('appointments.edit') ? h('button', { type: 'button', class: 'ghost', onclick: reschedule }, t('appointments.reschedule')) : null,
        can('appointments.cancel') ? h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => confirmAction({
            t,
            title: t('appointments.cancelTitle') ?? t('common.cancel'),
            message: appointment.appointmentCode,
            danger: true,
            confirmLabel: t('common.cancel'),
            run: () => api.del(`/api/appointments/${appointment.id}`, { reason: t('appointments.cancelReason') }),
            onDone: () => navigate('/appointments'),
          }),
        }, t('common.cancel')) : null,
      ],
      body: h('div', { class: 'two-col' }, [
        card({
          title: t('common.details'),
          body: kv([
            [t('patients.fullName'), h('button', { type: 'button', class: 'link', onclick: () => navigate(`/patients/${appointment.patientId}`) }, appointment.patientName)],
            [t('common.phone'), appointment.patientPhone],
            [t('common.date'), date(appointment.apptDate)],
            [t('common.time'), `${time(appointment.startTime)} – ${time(appointment.endTime)}`],
            [t('appointments.duration'), `${localizeDigits(appointment.durationMinutes)} min`],
            [t('staff.practitioner'), appointment.practitionerName],
            [t('appointments.type'), appointment.typeLabel],
            [t('appointments.reason'), appointment.reason],
            [t('common.notes'), appointment.notes],
            [t('appointments.serialNo'), localizeDigits(appointment.serialNo ?? '—')],
          ]),
        }),
        card({
          title: t('appointments.timeline') ?? t('common.status'),
          body: kv([
            [t('appointments.checkedInAt'), appointment.checkedInAt ? time(appointment.checkedInAt.slice(11, 16)) : null],
            [t('appointments.startedAt'), appointment.startedAt ? time(appointment.startedAt.slice(11, 16)) : null],
            [t('appointments.completedAt'), appointment.completedAt ? time(appointment.completedAt.slice(11, 16)) : null],
            [t('common.created'), appointment.createdAt],
            [t('appointments.visit'), appointment.visitId ? h('button', { type: 'button', class: 'link', onclick: () => navigate(`/visits/${appointment.visitId}`) }, `#${appointment.visitId}`) : null],
            [t('queue.title'), appointment.queueEntryId ? h('button', { type: 'button', class: 'link', onclick: () => navigate('/queue') }, `${t('queue.number')} ${localizeDigits(appointment.queueSerialNo ?? '')}`) : null],
          ]),
        }),
      ]),
    });
  }

  function reschedule() {
    formModal({
      t,
      title: t('appointments.reschedule'),
      columns: 1,
      fields: [
        { name: 'appt_date', label: 'common.date', type: 'date', required: true },
        { name: 'start_time', label: 'common.time', type: 'time', required: true },
        { name: 'duration_minutes', label: 'appointments.duration', type: 'number' },
        { name: 'reason', label: 'common.reason' },
      ],
      values: { appt_date: appointment.apptDate, start_time: appointment.startTime, duration_minutes: appointment.durationMinutes },
      submit: (values) => api.post(`/api/appointments/${appointment.id}/reschedule`, values),
      onSaved: (result) => navigate(result?.id ? `/appointments/${result.id}` : '/appointments'),
    });
  }

  load();
  return () => {};
}

/* ----------------------------------------------------------------- calendar */

export function calendarScreen({ t, query }) {
  setPageTitle('nav.calendar');
  let cursor = query?.get('month') ?? today().slice(0, 7);
  const host = h('div', { class: 'stack' });
  mount('#view', host);

  async function load() {
    mount(host, loading(t));
    const from = `${cursor}-01`;
    const to = addDays(`${cursor}-01`, 41);
    try {
      const payload = await api.get('/api/appointments/calendar', { from, to });
      mount(host, render(payload));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function shiftMonth(delta) {
    const [y, m] = cursor.split('-').map(Number);
    const next = new Date(y, m - 1 + delta, 1);
    cursor = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
    load();
  }

  function render(payload) {
    const days = payload?.days ?? {};
    const first = new Date(`${cursor}-01T00:00:00`);
    const weekStart = Number(state.settings['locale.weekStartsOn'] ?? 0);
    const start = new Date(first);
    const offset = (first.getDay() - weekStart + 7) % 7;
    start.setDate(start.getDate() - offset);

    const cells = [];
    for (let index = 0; index < 42; index += 1) {
      const current = new Date(start);
      current.setDate(start.getDate() + index);
      const iso = current.toISOString().slice(0, 10);
      const events = days[iso] ?? [];
      cells.push(h('div', {
        class: `cal-cell ${iso.slice(0, 7) !== cursor ? 'other-month' : ''} ${iso === today() ? 'today' : ''}`.trim(),
        onclick: () => navigate(`/appointments?date=${iso}`),
      }, [
        h('div', { class: 'cal-day' }, localizeDigits(current.getDate())),
        ...events.slice(0, 4).map((event) => h('div', {
          class: `cal-event status-${event.status}`,
          onclick: (clickEvent) => {
            clickEvent.stopPropagation();
            navigate(`/appointments/${event.id}`);
          },
        }, `${time(event.startTime)} ${event.patientName ?? ''}`)),
        events.length > 4 ? h('div', { class: 'small muted' }, `+${localizeDigits(events.length - 4)}`) : null,
      ]));
    }

    const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const ordered = [...weekdays.slice(weekStart), ...weekdays.slice(0, weekStart)];

    return [
      h('div', { class: 'toolbar' }, [
        h('button', { type: 'button', class: 'ghost', onclick: () => shiftMonth(-1) }, '‹'),
        h('h2', {}, new Date(`${cursor}-01T00:00:00`).toLocaleDateString(state.locale === 'bn' ? 'bn-BD' : 'en-GB', { month: 'long', year: 'numeric' })),
        h('button', { type: 'button', class: 'ghost', onclick: () => shiftMonth(1) }, '›'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: () => { cursor = today().slice(0, 7); load(); } }, t('common.today')),
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate('/appointments') }, t('nav.appointments')),
        can('appointments.create') ? h('button', { type: 'button', class: 'primary', onclick: () => navigate('/appointments?new=1') }, t('appointments.new')) : null,
      ]),
      card({
        t,
        body: h('div', {}, [
          h('div', { class: 'calendar' }, ordered.map((day) => h('div', { class: 'dow' }, enumLabel('weekday', day, t))).concat(cells)),
          h('p', { class: 'help' }, `${t('common.total')}: ${localizeDigits(payload?.total ?? 0)}`),
        ]),
      }),
    ];
  }

  load();
  return () => {};
}

/* -------------------------------------------------------------------- queue */

export function queueScreen({ t }) {
  setPageTitle('nav.queue');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let timer = 0;

  async function load() {
    try {
      const payload = await api.get('/api/queue');
      mount(host, render(payload));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render(payload) {
    const entries = payload?.entries ?? [];
    const stats = payload?.stats ?? {};
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [h('h2', {}, t('queue.title')), h('p', { class: 'muted small' }, date(payload?.date ?? today()))]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: load }, t('common.refresh')),
        can('queue.manage') ? h('button', { type: 'button', class: 'primary', onclick: checkIn }, t('queue.addToQueue') ?? t('queue.checkIn')) : null,
        can('queue.manage') ? h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('queue-ticket', payload?.current?.id ?? 0, { t }) }, t('doc.printTicket')) : null,
      ]),
      h('div', { class: 'cards' }, [
        counter(t('queue.waiting'), stats.waiting),
        counter(t('queue.inTreatment'), stats.inTreatment),
        counter(t('queue.completed'), stats.completed),
        counter(t('queue.total'), stats.total),
      ]),
      entries.length
        ? h('div', { class: 'queue-list' }, entries.map((entry) => h('div', { class: `queue-row ${entry.status}` }, [
          h('div', { class: 'serial' }, localizeDigits(entry.serialNo)),
          h('div', {}, [
            h('div', { class: 'strong' }, entry.patientName),
            h('div', { class: 'small muted' }, `${entry.patientCode ?? ''} · ${entry.phone ?? entry.patientPhone ?? ''}`),
            entry.note ? h('div', { class: 'small' }, entry.note) : null,
          ]),
          h('div', { class: 'row-actions' }, [
            statusPill(entry.status, t),
            can('queue.manage') && entry.status === 'waiting' ? h('button', { type: 'button', class: 'ghost', onclick: () => act(entry.id, 'call') }, t('queue.call')) : null,
            can('queue.manage') && ['called', 'waiting'].includes(entry.status) ? h('button', { type: 'button', class: 'ghost', onclick: () => act(entry.id, 'start') }, t('queue.start')) : null,
            can('queue.manage') && entry.status === 'in_treatment' ? h('button', { type: 'button', class: 'primary', onclick: () => act(entry.id, 'complete') }, t('queue.complete')) : null,
            can('queue.manage') ? h('button', { type: 'button', class: 'link', onclick: () => skip(entry) }, t('queue.skip')) : null,
            can('queue.manage') ? h('button', { type: 'button', class: 'link', onclick: () => move(entry, -1) }, '↑') : null,
            can('queue.manage') ? h('button', { type: 'button', class: 'link', onclick: () => move(entry, 1) }, '↓') : null,
            h('button', { type: 'button', class: 'link', onclick: () => printDocument('queue-ticket', entry.id, { t }) }, t('common.print')),
          ]),
        ])))
        : emptyState(t('queue.empty'), t('common.emptyHint'), can('queue.manage') ? h('button', { type: 'button', class: 'primary', onclick: checkIn }, t('queue.checkIn')) : null),
    ];
  }

  function counter(label, value) {
    return h('div', { class: 'card stat' }, [h('div', { class: 'label' }, label), h('div', { class: 'value' }, localizeDigits(value ?? 0))]);
  }

  async function act(id, action) {
    try {
      await api.post(`/api/queue/${id}/${action}`, {});
      await load();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  function skip(entry) {
    formModal({
      t,
      title: t('queue.skip'),
      columns: 1,
      fields: [{ name: 'note', label: 'common.reason', required: true }],
      submit: (values) => api.post(`/api/queue/${entry.id}/skip`, values),
      onSaved: load,
    });
  }

  async function move(entry, direction) {
    try {
      await api.post(`/api/queue/${entry.id}/move`, { direction: direction < 0 ? 'up' : 'down' });
      await load();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  function checkIn() {
    let picked = null;
    const modal = openModal({
      title: t('queue.checkIn'),
      body: patientPicker((patient) => { picked = patient; }, t),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: async () => {
            if (!picked) return toast({ message: t('common.selectPatient'), tone: 'warn' });
            try {
              const result = await api.post('/api/queue/check-in', { patientId: picked.id ?? picked.entityId });
              modal.close();
              toast({ message: `${t('queue.number')} ${result.serialNo}`, tone: 'ok' });
              await load();
            } catch (error) {
              toast({ message: error.message, tone: 'error' });
            }
          },
        }, t('queue.checkIn')),
      ],
    });
  }

  load();
  timer = window.setInterval(load, 30_000);
  return () => window.clearInterval(timer);
}
