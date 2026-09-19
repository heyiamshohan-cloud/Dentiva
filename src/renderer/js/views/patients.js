/**
 * Patients: register list and the Patient 360° profile.
 */
import { api } from '../core/api.js';
import { can } from '../core/store.js';
import { enumLabel, h, mount, statusPill, table } from '../core/dom.js';
import { age, amount, date, dateTime, localizeDigits } from '../core/format.js';
import { navigate, refresh } from '../core/router.js';
import { setPageTitle } from '../main.js';
import { printDocument } from '../core/print.js';
import { card, confirmAction, errorState, formModal, kv, listScreen, loading, recordLayout, tabs } from './ui.js';

/**
 * Medical flags, in the order they appear on the form:
 * [column sent to the API, flag name the API returns, label].
 */
const MEDICAL_FLAGS = [
  ['has_diabetes', 'diabetes', 'patients.diabetes'],
  ['has_hypertension', 'hypertension', 'patients.hypertension'],
  ['has_heart_disease', 'heartDisease', 'patients.heartDisease'],
  ['has_asthma', 'asthma', 'patients.asthma'],
  ['has_bleeding_disorder', 'bleedingDisorder', 'patients.bleeding'],
  ['is_pregnant', 'pregnant', 'patients.pregnancy'],
  ['is_smoker', 'smoker', 'patients.smoking'],
  ['takes_anticoagulant', 'anticoagulant', 'patients.anticoagulant'],
  ['has_hepatitis', 'hepatitis', 'patients.hepatitis'],
  ['has_kidney_disease', 'kidneyDisease', 'patients.kidneyDisease'],
  ['has_thyroid_disorder', 'thyroidDisorder', 'patients.thyroidDisorder'],
  ['alert_flag', 'alert', 'patients.alertFlag'],
];

const MEDICAL_FLAG_LABEL = Object.fromEntries(MEDICAL_FLAGS.map(([, read, key]) => [read, key]));

const GENDERS = [
  { value: '', label: 'common.all' },
  { value: 'male', label: 'gender.male' },
  { value: 'female', label: 'gender.female' },
  { value: 'other', label: 'gender.other' },
  { value: 'unspecified', label: 'gender.unspecified' },
];

const STATUSES = [
  { value: '', label: 'common.all' },
  { value: 'active', label: 'common.active' },
  { value: 'inactive', label: 'common.inactive' },
  { value: 'archived', label: 'common.archived' },
];

const patientFields = (t) => [
  { name: 'full_name', label: 'patients.fullName', required: true, span: 2 },
  { name: 'phone', label: 'common.phone', type: 'tel' },
  { name: 'phone_alt', label: 'patients.phoneAlt', type: 'tel' },
  { name: 'gender', label: 'common.gender', type: 'select', options: GENDERS.filter((g) => g.value) },
  { name: 'dob', label: 'common.dob', type: 'date' },
  { name: 'blood_group', label: 'patients.bloodGroup' },
  { name: 'occupation', label: 'patients.occupation' },
  { name: 'city', label: 'common.city' },
  { name: 'address', label: 'common.address', span: 2 },
  { name: 'national_id', label: 'patients.nationalId' },
  { name: 'email', label: 'common.email', type: 'email' },
  { name: 'emergency_name', label: 'patients.emergencyName' },
  { name: 'emergency_phone', label: 'patients.emergencyPhone', type: 'tel' },
  { name: 'referrer_source', label: 'patients.referrerSource' },
];

export function patientsScreen({ t, query }) {
  setPageTitle('nav.patients');
  const openCreate = () => {
    formModal({
      t,
      title: t('patients.newTitle'),
      fields: patientFields(t),
      columns: 2,
      submit: (values) => api.post('/api/patients', values),
      onSaved: (created) => {
        if (created?.id) navigate(`/patients/${created.id}`);
        else refresh();
      },
    });
  };

  const screen = listScreen({
    t,
    title: t('nav.patients'),
    subtitle: t('patients.subtitle'),
    endpoint: '/api/patients',
    query: { sort: query?.get('sort') ?? 'recent' },
    filters: [
      { name: 'status', options: STATUSES },
      { name: 'gender', options: GENDERS },
    ],
    onCreate: can('patients.create') ? openCreate : null,
    createLabel: t('patients.new'),
    onRowClick: (row) => navigate(`/patients/${row.id}`),
    columns: [
      { key: 'patientCode', label: 'patients.code', width: '120px' },
      {
        key: 'fullName',
        label: 'patients.fullName',
        render: (row) => h('div', {}, [
          h('div', { class: 'strong' }, row.fullName),
          row.alerts?.allergy ? h('span', { class: 'pill danger' }, t('patients.allergies')) : null,
        ]),
      },
      { key: 'gender', label: 'common.gender', render: (row) => enumLabel('gender', row.gender, t) },
      { key: 'age', label: 'common.age', render: (row) => h('span', {}, `${age(row.dob)} ${t('common.ageYears')}`.trim()) },
      { key: 'phone', label: 'common.phone' },
      { key: 'lastVisitOn', label: 'patients.lastVisit', date: true },
      { key: 'outstandingMinor', label: 'patients.outstanding', render: (row) => h('span', { class: row.outstandingMinor > 0 ? 'strong danger' : '' }, amount(row.outstandingMinor)) , num: true },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
    ],
  });

  if (query?.get('new') === '1' && can('patients.create')) openCreate();
  return screen.element;
}

/* ------------------------------------------------------------------ profile */

export function patientProfileScreen({ t, id, query }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.patients');
  let activeTab = query?.get('tab') ?? 'overview';
  /** @type {any} */
  let patient = null;
  /** @type {any} */
  let stats = null;

  async function load() {
    mount('#view', host);
    mount(host, loading(t));
    try {
      const [detail, statistics] = await Promise.all([
        api.get(`/api/patients/${id}`),
        api.get(`/api/patients/${id}/stats`),
      ]);
      patient = detail;
      stats = statistics;
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render() {
    const medical = patient.medical ?? {};
    const flags = Object.entries(medical.flags ?? {}).filter(([, value]) => value).map(([key]) => key);
    const alerts = [
      medical.allergies ? h('span', { class: 'pill danger' }, `${t('patients.allergies')}: ${medical.allergies}`) : null,
      ...flags.map((flag) => h('span', { class: 'pill warn' }, t(MEDICAL_FLAG_LABEL[flag] ?? `patients.${flag}`))),
    ].filter(Boolean);

    return recordLayout({
      t,
      title: patient.fullName,
      subtitle: `${patient.patientCode} · ${patient.phone ?? ''}`.trim(),
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [
        statusPill(patient.status, t),
        h('span', { class: 'pill' }, `${age(patient.dob)} ${t('common.ageYears')}`),
        patient.bloodGroup ? h('span', { class: 'pill' }, patient.bloodGroup) : null,
        ...alerts,
      ]),
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('patient-card', patient.id, { t }) }, t('patients.printCard')),
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('statement', patient.id, { t }) }, t('patients.statement')),
        can('patients.edit') ? h('button', { type: 'button', class: 'ghost', onclick: editPatient }, t('common.edit')) : null,
        can('clinical.create') ? h('button', { type: 'button', class: 'primary', onclick: () => navigate(`/visits?patientId=${patient.id}&new=1`) }, t('patients.startVisit')) : null,
        can('patients.archive') ? h('button', { type: 'button', class: 'ghost', onclick: removePatient }, t('common.archive')) : null,
      ],
      tabsBar: tabs([
        { key: 'overview', label: t('common.details') },
        { key: 'clinical', label: t('nav.clinical') },
        { key: 'chart', label: t('chart.title') },
        { key: 'money', label: t('nav.billing') },
        { key: 'files', label: t('nav.attachments') },
        { key: 'notes', label: t('common.notes') },
      ], activeTab, (key) => {
        activeTab = key;
        mount(host, render());
      }),
      body: tabBody(),
    });
  }

  function tabBody() {
    switch (activeTab) {
      case 'clinical':
        return clinicalTab();
      case 'chart':
        return chartTab();
      case 'money':
        return moneyTab();
      case 'files':
        return filesTab();
      case 'notes':
        return notesTab();
      default:
        return overviewTab();
    }
  }

  function overviewTab() {
    const medical = patient.medical ?? {};
    return h('div', { class: 'two-col' }, [
      card({
        title: t('patients.medicalTitle'),
        actions: can('patients.edit') ? [h('button', { type: 'button', class: 'link', onclick: editMedical }, t('common.edit'))] : null,
        body: kv([
          [t('patients.allergies'), medical.allergies],
          [t('patients.medicalHistory'), medical.medicalHistory],
          [t('patients.medications'), medical.currentMedications],
          [t('patients.conditions'), medical.conditions],
          [t('patients.previousSurgery'), medical.previousSurgery],
          [t('patients.familyHistory'), medical.familyHistory],
          [t('patients.medicalNotes'), medical.notes],
        ]),
      }),
      h('div', { class: 'stack' }, [
        card({
          title: t('common.details'),
          body: kv([
            [t('patients.code'), patient.patientCode],
            [t('common.gender'), enumLabel('gender', patient.gender, t)],
            [t('common.dob'), patient.dob ? date(patient.dob) : null],
            [t('common.age'), `${age(patient.dob, { detailed: true })}`],
            [t('patients.occupation'), patient.occupation],
            [t('common.address'), [patient.address, patient.city].filter(Boolean).join(', ')],
            [t('patients.emergencyName'), [patient.emergencyName, patient.emergencyPhone].filter(Boolean).join(' · ')],
            [t('patients.referrerSource'), patient.referrerSource],
            [t('common.created'), dateTime(patient.createdAt)],
          ]),
        }),
        card({
          title: t('patients.stats'),
          body: h('div', { class: 'grid-2' }, [
            stat(t('patients.visitsCount'), stats?.visits?.total),
            stat(t('patients.treatmentsCount'), stats?.counts?.treatments),
            stat(t('patients.plansCount'), stats?.counts?.plans),
            stat(t('patients.prescriptionsCount'), stats?.counts?.prescriptions),
            stat(t('patients.invoicesCount'), stats?.billing?.invoiceCount),
            stat(t('patients.outstanding'), amount(stats?.billing?.dueMinor ?? 0)),
          ]),
        }),
        card({ title: t('patients.timeline'), body: timelineHost() }),
      ]),
    ]);
  }

  function stat(label, value) {
    return h('div', {}, [h('div', { class: 'label muted small' }, label), h('div', { class: 'strong' }, localizeDigits(value ?? 0))]);
  }

  function timelineHost() {
    const box = h('div', { class: 'timeline' }, h('p', { class: 'muted small' }, t('common.loading')));
    api.get(`/api/patients/${patient.id}/timeline`, { limit: 20 }).then((payload) => {
      const rows = payload?.rows ?? [];
      mount(box, rows.length
        ? rows.map((row) => h('div', { class: 'timeline-item' }, [
          h('div', { class: 'timeline-icon' }, '•'),
          h('div', {}, [
            h('div', { class: 'strong' }, t(row.title_key, row.params ?? {}) === row.title_key ? (row.title_text ?? row.title_key) : t(row.title_key, row.params ?? {})),
            h('div', { class: 'small muted' }, `${date(row.event_date)} · ${row.reference ?? ''}`),
          ]),
          row.amount_minor ? h('span', { class: 'money small' }, amount(row.amount_minor)) : null,
        ]))
        : [h('p', { class: 'muted small' }, t('common.emptyHint'))]);
    }).catch((error) => mount(box, h('div', { class: 'alert' }, error.message)));
    return box;
  }

  function clinicalTab() {
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('common.loading')));
    Promise.all([
      api.get('/api/visits', { patientId: patient.id, pageSize: 10 }),
      api.get('/api/appointments', { patientId: patient.id, pageSize: 10 }),
      api.get('/api/treatments', { patientId: patient.id, pageSize: 10 }),
      api.get('/api/plans', { patientId: patient.id, pageSize: 10 }),
    ]).then(([visits, appointments, treatments, plans]) => {
      mount(box, [
        card({
          title: t('visits.title'),
          actions: [h('button', { type: 'button', class: 'link', onclick: () => navigate(`/visits?patientId=${patient.id}`) }, t('dashboard.viewAll'))],
          body: smallTable([
            { key: 'visitCode', label: 'visits.code' },
            { key: 'visitDate', label: 'common.date', date: true },
            { key: 'diagnosis', label: 'visits.diagnosis' },
            { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
          ], visits?.rows ?? [], () => navigate(`/visits?patientId=${patient.id}`)),
        }),
        card({
          title: t('nav.appointments'),
          actions: [h('button', { type: 'button', class: 'link', onclick: () => navigate(`/appointments?patientId=${patient.id}`) }, t('dashboard.viewAll'))],
          body: smallTable([
            { key: 'appointmentCode', label: 'appointments.code' },
            { key: 'apptDate', label: 'common.date', date: true },
            { key: 'startTime', label: 'common.time', time: true },
            { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
          ], appointments?.rows ?? [], (row) => navigate(`/appointments/${row.id}`)),
        }),
        card({
          title: t('treatments.title'),
          actions: [h('button', { type: 'button', class: 'link', onclick: () => navigate(`/treatments?patientId=${patient.id}`) }, t('dashboard.viewAll'))],
          body: smallTable([
            { key: 'name', label: 'treatments.procedure' },
            { key: 'treatmentDate', label: 'common.date', date: true },
            { key: 'totalMinor', label: 'common.total', money: true },
            { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
          ], treatments?.rows ?? []),
        }),
        card({
          title: t('plans.title'),
          actions: [h('button', { type: 'button', class: 'link', onclick: () => navigate(`/plans?patientId=${patient.id}`) }, t('dashboard.viewAll'))],
          body: smallTable([
            { key: 'planCode', label: 'plans.code' },
            { key: 'title', label: 'plans.name' },
            { key: 'totalMinor', label: 'common.total', money: true },
            { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
          ], plans?.rows ?? [], (row) => navigate(`/plans/${row.id}`)),
        }),
      ]);
    }).catch((error) => mount(box, errorState(error, t)));
    return box;
  }

  function smallTable(columns, rows, onRowClick) {
    if (!rows.length) return h('p', { class: 'muted small' }, t('common.emptyHint'));
    return table(columns, rows.slice(0, 6), { t, onRowClick });
  }

  function chartTab() {
    const box = h('div', {}, h('p', { class: 'muted small' }, t('common.loading')));
    api.get(`/api/chart/${patient.id}`).then((chart) => {
      const teeth = chart?.teeth ?? {};
      const quadrants = chart?.layout ?? {};
      mount(box, h('div', { class: 'stack' }, [
        h('div', { class: 'row-actions' }, [
          h('span', { class: 'muted small' }, `${t('chart.dentition')}: ${t(`chart.${chart.dentition}`) === `chart.${chart.dentition}` ? chart.dentition : t(`chart.${chart.dentition}`)}`),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/chart/${patient.id}`) }, t('chart.title')),
        ]),
        h('div', { class: 'chart-grid' }, Object.entries(quadrants).map(([quadrant, codes]) => h('div', { class: 'quadrant' }, [
          h('div', { class: 'quadrant-title' }, t(`chart.${quadrant}`)),
          h('div', { class: 'tooth-row' }, codes.map((code) => toothCell(code, teeth[code]))),
        ]))),
        h('div', { class: 'legend' }, [
          h('span', {}, [h('span', { class: 'swatch', style: { background: 'var(--accent)' } }), t('chart.charted')]),
          h('span', {}, [h('span', { class: 'swatch', style: { background: 'var(--line)' } }), t('chart.healthy')]),
        ]),
      ]));
    }).catch((error) => mount(box, errorState(error, t)));
    return box;
  }

  function toothCell(code, tooth) {
    const primary = tooth?.primaryCondition;
    return h('button', {
      type: 'button',
      class: `tooth ${primary ? 'has-condition' : ''} ${tooth?.status === 'missing' ? 'missing' : ''}`.trim(),
      onclick: () => navigate(`/chart/${patient.id}?tooth=${code}`),
    }, [
      h('span', { class: 'num' }, code),
      h('span', { class: 'dot', style: { background: primary?.color ?? 'transparent' } }),
    ]);
  }

  function moneyTab() {
    const box = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('common.loading')));
    Promise.all([
      api.get('/api/invoices', { patientId: patient.id, pageSize: 10 }),
      api.get('/api/payments', { patientId: patient.id, pageSize: 10 }),
    ]).then(([invoices, payments]) => {
      mount(box, [
        card({
          title: t('billing.title'),
          actions: [
            h('button', { type: 'button', class: 'link', onclick: () => printDocument('statement', patient.id, { t }) }, t('patients.statement')),
            h('button', { type: 'button', class: 'link', onclick: () => navigate(`/billing?patientId=${patient.id}`) }, t('dashboard.viewAll')),
          ],
          body: smallTable([
            { key: 'invoiceNumber', label: 'billing.number' },
            { key: 'invoiceDate', label: 'common.date', date: true },
            { key: 'totalMinor', label: 'common.total', money: true },
            { key: 'dueMinor', label: 'common.due', money: true },
            { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
          ], invoices?.rows ?? [], (row) => navigate(`/billing/${row.id}`)),
        }),
        card({
          title: t('payments.title'),
          body: smallTable([
            { key: 'receiptNumber', label: 'payments.receiptNo' },
            { key: 'paymentDate', label: 'common.date', date: true },
            { key: 'amountMinor', label: 'common.amount', money: true },
            { key: 'methodName', label: 'payments.method' },
          ], payments?.rows ?? [], (row) => navigate(`/payments/${row.id}`)),
        }),
      ]);
    }).catch((error) => mount(box, errorState(error, t)));
    return box;
  }

  function filesTab() {
    const box = h('div', {}, h('p', { class: 'muted small' }, t('common.loading')));
    api.get('/api/attachments', { patientId: patient.id, pageSize: 20 }).then((payload) => {
      const rows = payload?.rows ?? [];
      mount(box, card({
        title: t('attachments.title'),
        body: rows.length
          ? table([
            { key: 'fileName', label: 'attachments.fileName' },
            { key: 'kind', label: 'common.type' },
            { key: 'sizeBytes', label: 'attachments.size', render: (row) => h('span', {}, `${Math.max(1, Math.round((row.sizeBytes ?? 0) / 1024))} KB`) },
            { key: 'createdAt', label: 'common.created', date: true },
            { label: 'common.actions', render: (row) => h('button', {
              type: 'button',
              class: 'link',
              onclick: () => window.open(`/api/attachments/${row.id}/content`, '_blank'),
            }, t('attachments.openExternal')) },
          ], rows, { t })
          : h('p', { class: 'muted small' }, t('common.emptyHint')),
      }));
    }).catch((error) => mount(box, errorState(error, t)));
    return box;
  }

  function notesTab() {
    const box = h('div', { class: 'stack' });
    const list = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('common.loading')));

    const loadNotes = () => {
      api.get(`/api/patients/${patient.id}/notes`).then((payload) => {
        const rows = payload?.rows ?? [];
        mount(list, rows.length
          ? rows.map((note) => h('div', { class: 'timeline-item' }, [
            h('div', { class: 'timeline-icon' }, '✎'),
            h('div', {}, [
              h('div', { class: 'strong' }, note.title ?? t('common.note')),
              h('div', { class: 'small muted' }, dateTime(note.createdAt)),
              h('p', {}, note.body ?? ''),
            ]),
            can('patients.edit') ? h('button', {
              type: 'button',
              class: 'link',
              onclick: () => confirmAction({
                t,
                title: t('common.deleteConfirm'),
                message: note.title ?? '',
                danger: true,
                run: () => api.del(`/api/patients/${patient.id}/notes/${note.id}`),
                onDone: loadNotes,
              }),
            }, t('common.delete')) : null,
          ]))
          : [h('p', { class: 'muted small' }, t('common.emptyHint'))]);
      }).catch((error) => mount(list, h('div', { class: 'alert' }, error.message)));
    };

    loadNotes();
    mount(box, [
      can('patients.edit') ? h('div', { class: 'row-actions' }, h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => formModal({
          t,
          title: t('common.note'),
          columns: 1,
          fields: [
            { name: 'title', label: 'common.reason' },
            { name: 'body', label: 'common.notes', type: 'textarea', rows: 4, required: true },
          ],
          submit: (values) => api.post(`/api/patients/${patient.id}/notes`, values),
          onSaved: loadNotes,
        }),
      }, t('common.add'))) : null,
      card({ title: t('common.notes'), body: list }),
    ]);
    return box;
  }

  function editPatient() {
    formModal({
      t,
      title: t('patients.editTitle'),
      fields: patientFields(t),
      columns: 2,
      values: {
        full_name: patient.fullName,
        phone: patient.phone,
        phone_alt: patient.phoneAlt,
        gender: patient.gender,
        dob: patient.dob,
        blood_group: patient.bloodGroup,
        occupation: patient.occupation,
        city: patient.city,
        address: patient.address,
        national_id: patient.nationalId,
        email: patient.email,
        emergency_name: patient.emergencyName,
        emergency_phone: patient.emergencyPhone,
        referrer_source: patient.referrerSource,
      },
      submit: (values) => api.put(`/api/patients/${patient.id}`, values),
      onSaved: load,
    });
  }

  function editMedical() {
    const medical = patient.medical ?? {};
    const flags = medical.flags ?? {};
    formModal({
      t,
      title: t('patients.medicalTitle'),
      columns: 2,
      fields: [
        { name: 'allergies', label: 'patients.allergies', span: 2 },
        { name: 'medical_history', label: 'patients.medicalHistory', type: 'textarea' },
        { name: 'current_medications', label: 'patients.medications', type: 'textarea' },
        { name: 'conditions', label: 'patients.conditions', type: 'textarea' },
        { name: 'previous_surgery', label: 'patients.previousSurgery' },
        { name: 'family_history', label: 'patients.familyHistory' },
        { name: 'notes', label: 'patients.medicalNotes', type: 'textarea', span: 2 },
        ...MEDICAL_FLAGS.map(([name, , label]) => ({ name, label, type: 'checkbox' })),
      ],
      values: {
        allergies: medical.allergies,
        medical_history: medical.medicalHistory,
        current_medications: medical.currentMedications,
        conditions: medical.conditions,
        previous_surgery: medical.previousSurgery,
        family_history: medical.familyHistory,
        notes: medical.notes,
        ...Object.fromEntries(MEDICAL_FLAGS.map(([name, read]) => [name, Boolean(flags[read])])),
      },
      submit: (values) => api.put(`/api/patients/${patient.id}/medical`, values),
      onSaved: load,
    });
  }

  const removePatient = () => confirmAction({
    t,
    title: t('patients.archivedTitle'),
    message: patient.fullName,
    danger: true,
    confirmLabel: t('common.archive'),
    run: () => api.del(`/api/patients/${patient.id}`, { reason: t('patients.archiveReason') }),
    onDone: () => navigate('/patients'),
  });

  load();
  return () => {};
}
