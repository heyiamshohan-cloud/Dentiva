/**
 * Clinical screens: visits, the odontogram chart, treatments, plans,
 * prescriptions, referrals and the attachment gallery.
 */
import { api } from '../core/api.js';
import { can, state } from '../core/store.js';
import { enumLabel, form as buildForm, h, mount, openModal, statusPill, table, toast } from '../core/dom.js';
import { amount, date, dateTime, localizeDigits, qty, today } from '../core/format.js';
import { navigate } from '../core/router.js';
import { setPageTitle } from '../main.js';
import { printDocument } from '../core/print.js';
import { card, confirmAction, emptyState, errorState, formModal, kv, listScreen, loading, recordLayout, tabs } from './ui.js';
import { patientPicker } from './scheduling.js';

const SURFACES = ['M', 'D', 'B', 'L', 'O', 'I', 'C'];

/* -------------------------------------------------------------------- visits */

export function visitsScreen({ t, query }) {
  setPageTitle('nav.clinical');
  const presetPatient = query?.get('patientId');

  const createVisit = async () => {
    let picked = presetPatient ? { id: Number(presetPatient) } : null;
    const fields = [
      { name: 'visit_date', label: 'common.date', type: 'date', required: true },
      { name: 'visit_time', label: 'common.time', type: 'time' },
      { name: 'chief_complaint', label: 'visits.chiefComplaint', span: 2 },
      { name: 'examination', label: 'visits.examination', type: 'textarea', span: 2 },
      { name: 'diagnosis', label: 'visits.diagnosis', type: 'textarea', span: 2 },
      { name: 'treatment_given', label: 'visits.treatmentGiven', type: 'textarea', span: 2 },
      { name: 'advice', label: 'visits.advice', type: 'textarea', span: 2 },
      { name: 'followup_date', label: 'visits.followupDate', type: 'date' },
      { name: 'status', label: 'common.status', type: 'select', options: [
        { value: 'open', label: 'common.active' },
        { value: 'in_progress', label: 'status.in_progress' },
        { value: 'completed', label: 'status.completed' },
      ] },
    ];
    const builder = buildForm(fields, t, { values: { visit_date: today(), status: 'in_progress' } });
    const modal = openModal({
      title: t('visits.newTitle'),
      wide: true,
      body: h('div', { class: 'stack' }, [
        picked && presetPatient ? h('p', { class: 'help' }, `${t('patients.code')}: ${presetPatient}`) : patientPicker((patient) => { picked = patient; }, t),
        builder.form,
      ]),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: async () => {
            if (!picked?.id && !picked?.entityId) return toast({ message: t('common.selectPatient'), tone: 'warn' });
            try {
              const created = await api.post('/api/visits', { ...builder.values(), patient_id: picked.id ?? picked.entityId });
              modal.close();
              navigate(`/visits/${created.id}`);
            } catch (error) {
              toast({ message: error.message, tone: 'error' });
            }
          },
        }, t('common.save')),
      ],
    });
  };

  const screen = listScreen({
    t,
    title: t('nav.clinical'),
    subtitle: t('visits.subtitle'),
    endpoint: '/api/visits',
    query: { patientId: presetPatient ?? undefined },
    onCreate: can('clinical.create') ? createVisit : null,
    createLabel: t('visits.new'),
    onRowClick: (row) => navigate(`/visits/${row.id}`),
    columns: [
      { key: 'visitCode', label: 'visits.code', width: '140px' },
      { key: 'visitDate', label: 'common.date', date: true, width: '110px' },
      { key: 'patientName', label: 'patients.fullName', render: (row) => h('div', {}, [h('div', { class: 'strong' }, row.patientName), h('div', { class: 'small muted' }, row.patientCode ?? '')]) },
      { key: 'chiefComplaint', label: 'visits.chiefComplaint' },
      { key: 'diagnosis', label: 'visits.diagnosis' },
      { key: 'practitionerName', label: 'staff.practitioner' },
      { key: 'followupDate', label: 'visits.followupDate', date: true },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
    ],
  });

  if (query?.get('new') === '1' && can('clinical.create')) createVisit();
  return screen.element;
}

export function visitDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.clinical');
  let visit = null;

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      visit = await api.get(`/api/visits/${id}`);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    return recordLayout({
      t,
      title: `${visit.visitCode} · ${visit.patientName ?? ''}`,
      subtitle: `${date(visit.visitDate)}${visit.visitTime ? ` · ${visit.visitTime}` : ''}`,
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [statusPill(visit.status, t), visit.practitionerName ? h('span', { class: 'pill' }, visit.practitionerName) : null]),
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/patients/${visit.patientId}`) }, t('patients.profile')),
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('visit', visit.id, { t }) }, t('visits.printSummary')),
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/chart/${visit.patientId}`) }, t('chart.title')),
        can('clinical.edit') ? h('button', { type: 'button', class: 'ghost', onclick: edit }, t('common.edit')) : null,
        can('clinical.delete') ? h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => confirmAction({
            t,
            title: t('common.deleteConfirm'),
            message: visit.visitCode,
            danger: true,
            run: () => api.del(`/api/visits/${visit.id}`, { reason: t('common.deleteConfirm') }),
            onDone: () => navigate('/visits'),
          }),
        }, t('common.delete')) : null,
      ],
      body: h('div', { class: 'two-col' }, [
        h('div', { class: 'stack' }, [
          card({
            title: t('visits.newTitle'),
            body: kv([
              [t('visits.chiefComplaint'), visit.chiefComplaint],
              [t('visits.examination'), visit.examination],
              [t('visits.diagnosis'), visit.diagnosis],
              [t('visits.treatmentGiven'), visit.procedureSummary],
              [t('visits.advice'), visit.instructions],
              [t('visits.notes'), visit.clinicalNotes],
              [t('visits.followupDate'), visit.followupDate ? date(visit.followupDate) : null],
            ]),
          }),
          card({
            title: t('visits.attachments'),
            actions: [h('button', { type: 'button', class: 'link', onclick: () => navigate(`/attachments?patientId=${visit.patientId}`) }, t('nav.attachments'))],
            body: (visit.attachments ?? []).length
              ? h('div', { class: 'tag-list' }, visit.attachments.map((item) => h('span', { class: 'pill' }, item.fileName ?? item.file_name)))
              : h('p', { class: 'muted small' }, t('common.emptyHint')),
          }),
        ]),
        h('div', { class: 'stack' }, [
          card({
            title: t('treatments.title'),
            body: (visit.treatments ?? []).length
              ? table([
                { key: 'name', label: 'treatments.procedure' },
                { key: 'totalMinor', label: 'common.total', money: true },
              ], visit.treatments, { t })
              : h('p', { class: 'muted small' }, t('common.emptyHint')),
          }),
          card({
            title: t('prescriptions.title'),
            body: (visit.prescriptions ?? []).length
              ? table([
                { key: 'rxCode', label: 'prescriptions.code' },
                { label: 'common.actions', className: 'actions', render: (row) => h('button', { type: 'button', class: 'link', onclick: () => navigate(`/prescriptions/${row.id}`) }, t('common.open')) },
              ], visit.prescriptions, { t })
              : h('p', { class: 'muted small' }, t('common.emptyHint')),
          }),
          card({
            title: t('chart.title'),
            body: (visit.chartEntries ?? []).length
              ? h('div', { class: 'tag-list' }, visit.chartEntries.map((entry) => h('span', { class: 'pill accent' }, `${entry.tooth_code ?? entry.toothCode} · ${entry.label_en ?? entry.conditionCode ?? ''}`)))
              : h('p', { class: 'muted small' }, t('common.emptyHint')),
          }),
          card({
            title: t('billing.title'),
            body: (visit.invoices ?? []).length
              ? table([
                { key: 'invoiceNumber', label: 'billing.number' },
                { key: 'totalMinor', label: 'common.total', money: true },
                { label: 'common.actions', className: 'actions', render: (row) => h('button', { type: 'button', class: 'link', onclick: () => navigate(`/billing/${row.id}`) }, t('common.open')) },
              ], visit.invoices, { t })
              : h('p', { class: 'muted small' }, t('common.emptyHint')),
          }),
        ]),
      ]),
    });
  }

  function edit() {
    formModal({
      t,
      title: t('visits.editTitle'),
      wide: true,
      columns: 2,
      fields: [
        { name: 'visit_date', label: 'common.date', type: 'date', required: true },
        { name: 'visit_time', label: 'common.time', type: 'time' },
        { name: 'chief_complaint', label: 'visits.chiefComplaint', span: 2 },
        { name: 'examination', label: 'visits.examination', type: 'textarea', span: 2 },
        { name: 'diagnosis', label: 'visits.diagnosis', type: 'textarea', span: 2 },
        { name: 'treatment_given', label: 'visits.treatmentGiven', type: 'textarea', span: 2 },
        { name: 'advice', label: 'visits.advice', type: 'textarea', span: 2 },
        { name: 'followup_date', label: 'visits.followupDate', type: 'date' },
        { name: 'status', label: 'common.status', type: 'select', options: [
          { value: 'open', label: 'common.active' },
          { value: 'in_progress', label: 'status.in_progress' },
          { value: 'completed', label: 'status.completed' },
          { value: 'cancelled', label: 'status.cancelled' },
        ] },
      ],
      values: {
        visit_date: visit.visitDate,
        visit_time: visit.visitTime,
        chief_complaint: visit.chiefComplaint,
        examination: visit.examination,
        diagnosis: visit.diagnosis,
        treatment_given: visit.procedureSummary,
        advice: visit.instructions,
        followup_date: visit.followupDate,
        status: visit.status,
      },
      submit: (values) => api.put(`/api/visits/${visit.id}`, values),
      onSaved: load,
    });
  }

  load();
  return () => {};
}

/* --------------------------------------------------------------------- chart */

export function chartScreen({ t, patientId, query }) {
  setPageTitle('chart.title');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let chart = null;
  let conditions = [];
  let highlighted = query?.get('tooth') ?? null;

  async function load() {
    mount(host, loading(t));
    try {
      [chart, conditions] = await Promise.all([
        api.get(`/api/chart/${patientId}`),
        api.get('/api/chart/conditions').then((payload) => payload?.rows ?? []),
      ]);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render() {
    const teeth = chart.teeth ?? {};
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [
          h('h2', {}, `${t('chart.title')} — ${chart.patient.name}`),
          h('p', { class: 'muted small' }, `${chart.patient.code} · ${t('chart.dentition')}: ${enumLabel('chart', chart.dentition, t)}`),
        ]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/patients/${patientId}`) }, t('patients.profile')),
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('patient-card', patientId, { t }) }, t('patients.printCard')),
      ]),
      card({
        t,
        body: h('div', { class: 'chart-grid' }, [
          h('div', { class: 'quadrant' }, [
            h('div', { class: 'quadrant-title' }, t('chart.upperRight')),
            h('div', { class: 'tooth-row' }, (chart.layout.upperRight ?? []).map((code) => tooth(code, teeth[code]))),
            h('div', { class: 'quadrant-title' }, t('chart.lowerRight')),
            h('div', { class: 'tooth-row' }, (chart.layout.lowerRight ?? []).map((code) => tooth(code, teeth[code]))),
          ]),
          h('div', { class: 'quadrant' }, [
            h('div', { class: 'quadrant-title' }, t('chart.upperLeft')),
            h('div', { class: 'tooth-row' }, (chart.layout.upperLeft ?? []).map((code) => tooth(code, teeth[code]))),
            h('div', { class: 'quadrant-title' }, t('chart.lowerLeft')),
            h('div', { class: 'tooth-row' }, (chart.layout.lowerLeft ?? []).map((code) => tooth(code, teeth[code]))),
          ]),
        ]),
      }),
      card({
        title: t('common.details'),
        body: highlighted ? toothDetail(highlighted, teeth[highlighted]) : h('p', { class: 'muted small' }, t('chart.subtitle')),
      }),
      card({
        title: t('chart.legend'),
        body: h('div', { class: 'legend' }, conditions.slice(0, 18).map((condition) => h('span', {}, [
          h('span', { class: 'swatch', style: { background: condition.color } }),
          state.locale === 'bn' ? condition.label_bn : condition.label_en,
        ]))),
      }),
    ];
  }

  function tooth(code, entry) {
    const primary = entry?.primaryCondition;
    return h('button', {
      type: 'button',
      class: `tooth ${primary ? 'has-condition' : ''} ${entry?.status === 'missing' ? 'missing' : ''} ${highlighted === code ? 'active' : ''}`.trim(),
      onclick: () => {
        highlighted = code;
        mount(host, render());
      },
    }, [
      h('span', { class: 'num' }, code),
      h('span', { class: 'dot', style: { background: primary?.color ?? 'transparent' } }),
    ]);
  }

  function toothDetail(code, entry) {
    return h('div', { class: 'stack' }, [
      h('div', { class: 'row-actions' }, [
        h('h3', {}, `${t('chart.tooth')} ${code}`),
        h('span', { class: 'spacer' }),
        can('chart.edit') ? h('button', { type: 'button', class: 'primary', onclick: () => addEntry(code) }, t('chart.addEntry')) : null,
      ]),
      (entry?.conditions ?? []).length
        ? table([
          { label: 'chart.condition', render: (row) => h('span', { class: 'row-actions' }, [h('span', { class: 'swatch', style: { background: row.color } }), state.locale === 'bn' ? row.labelBn : row.labelEn]) },
          { label: 'chart.surfaces', render: (row) => (row.surfaces ?? []).map((surface) => t(`chart.surface.${surface.toLowerCase()}`)).join(', ') || '—' },
          { label: 'common.status', render: (row) => statusPill(row.status, t) },
          { key: 'recordedAt', label: 'common.date', date: true },
          { key: 'practitionerName', label: 'staff.practitioner' },
          {
            label: 'common.actions',
            className: 'actions',
            render: (row) => can('chart.edit') ? h('button', {
              type: 'button',
              class: 'link',
              onclick: () => confirmAction({
                t,
                title: t('chart.clearConfirm'),
                message: `${code} · ${row.labelEn}`,
                danger: true,
                run: () => api.del(`/api/chart/entries/${row.id}`),
                onDone: load,
              }),
            }, t('common.remove')) : null,
          },
        ], entry.conditions, { t })
        : h('p', { class: 'muted small' }, t('chart.healthy')),
    ]);
  }

  function addEntry(code) {
    const modal = openModal({ title: `${t('chart.addEntry')} — ${code}`, body: {} });
    {
      const builder = buildForm([
        { name: 'condition_code', label: 'chart.condition', type: 'select', required: true, options: conditions.map((condition) => ({ value: condition.code, label: state.locale === 'bn' ? condition.label_bn : condition.label_en })) },
        { name: 'status', label: 'common.status', type: 'select', options: ['existing', 'planned', 'completed'].map((value) => ({ value, label: `status.${value}` })) },
        { name: 'notes', label: 'common.notes', type: 'textarea' },
      ], t);
      mount(modal.panel.querySelector('.modal-body'), [
        h('div', { class: 'stack' }, [
          builder.form,
          h('div', {}, [
            h('div', { class: 'section-title' }, t('chart.surfaces')),
            h('div', { class: 'tag-list' }, SURFACES.map((surface) => h('label', { class: 'checkbox' }, [h('input', {
              type: 'checkbox',
              name: `surface_${surface}`,
            }), h('span', {}, t(`chart.surface.${surface.toLowerCase()}`))]))),
          ]),
        ]),
      ]);
      modal.panel.querySelector('.modal-foot').appendChild(h('button', {
        type: 'button',
        class: 'primary',
        onclick: async () => {
          const values = builder.values();
          const surfaces = SURFACES.filter((surface) => modal.panel.querySelector(`[name="surface_${surface}"]`)?.checked);
          try {
            await api.post('/api/chart/entries', {
              patient_id: patientId,
              tooth_code: code,
              condition_code: values.condition_code,
              status: values.status,
              notes: values.notes,
              surfaces,
            });
            modal.close();
            toast({ message: t('common.saved'), tone: 'ok' });
            await load();
          } catch (error) {
            toast({ message: error.message, tone: 'error' });
          }
        },
      }, t('common.save')));
    }
  }

  load();
  return () => {};
}

/* ---------------------------------------------------------------- treatments */

export function treatmentsScreen({ t, query }) {
  setPageTitle('nav.treatments');
  const presetPatient = query?.get('patientId');

  const create = () => {
    let picked = presetPatient ? { id: Number(presetPatient) } : null;
    const services = [];
    const modal = openModal({
      title: t('treatments.new'),
      wide: true,
      body: h('div', { class: 'stack' }, [
        presetPatient ? null : patientPicker((patient) => { picked = patient; }, t),
        h('div', { id: 'treatmentForm' }),
      ]),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
      ],
    });

    let builder;
    api.get('/api/treatments/services').then((payload) => {
      services.push(...(payload?.rows ?? []));
      builder = buildForm([
        { name: 'service_id', label: 'treatments.service', type: 'select', numericValues: true, options: [{ value: '', label: 'treatments.customProcedure' }, ...services.map((service) => ({ value: service.id, label: state.locale === 'bn' ? service.nameBn ?? service.nameEn : service.nameEn }))] },
        { name: 'name', label: 'treatments.procedure', required: true },
        { name: 'tooth_codes', label: 'treatments.tooth' },
        { name: 'treatment_date', label: 'common.date', type: 'date', required: true },
        { name: 'fee_minor', label: 'treatments.fee', type: 'money' },
        { name: 'quantity_milli', label: 'common.quantity', type: 'qty' },
        { name: 'status', label: 'common.status', type: 'select', options: ['planned', 'completed', 'cancelled'].map((value) => ({ value, label: `status.${value}` })) },
        { name: 'anesthesia', label: 'treatments.anesthesia' },
        { name: 'materials', label: 'treatments.materials', type: 'textarea', span: 2 },
        { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
      ], t, { values: { treatment_date: today(), status: 'completed', quantity_milli: 1000 } });
      mount('#treatmentForm', [builder.form]);
    }).catch((error) => mount('#treatmentForm', h('div', { class: 'alert' }, error.message)));

    async function save() {
      if (!picked?.id) return toast({ message: t('common.selectPatient'), tone: 'warn' });
      if (!builder) return;
      const values = builder.values();
      const service = services.find((item) => item.id === values.service_id);
      try {
        await api.post('/api/treatments', {
          ...values,
          name: values.name || service?.nameEn,
          patient_id: picked.id ?? picked.entityId,
          tooth_codes: String(values.tooth_codes ?? '').split(/[,\s]+/).filter(Boolean),
        });
        modal.close();
        toast({ message: t('common.saved'), tone: 'ok' });
        screen.reload();
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }
  };

  const screen = listScreen({
    t,
    title: t('nav.treatments'),
    subtitle: t('treatments.subtitle'),
    endpoint: '/api/treatments',
    query: { patientId: presetPatient ?? undefined },
    onCreate: can('treatments.create') ? create : null,
    createLabel: t('treatments.new'),
    columns: [
      { key: 'name', label: 'treatments.procedure' },
      { key: 'patientName', label: 'patients.fullName' },
      { key: 'treatmentDate', label: 'common.date', date: true },
      { key: 'toothCodes', label: 'treatments.tooth', render: (row) => (row.toothCodes ?? []).join(', ') || '—' },
      { key: 'feeMinor', label: 'treatments.fee', money: true, num: true },
      { key: 'totalMinor', label: 'common.total', money: true, num: true },
      { key: 'invoiceNumber', label: 'billing.number', render: (row) => row.invoiceId ? h('button', { type: 'button', class: 'link', onclick: () => navigate(`/billing/${row.invoiceId}`) }, row.invoiceNumber) : h('span', { class: 'muted' }, '—') },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
      can('treatments.delete') ? {
        label: 'common.actions',
        className: 'actions',
        render: (row) => h('button', {
          type: 'button',
          class: 'link',
          onclick: () => confirmAction({
            t,
            title: t('common.deleteConfirm'),
            message: row.name,
            danger: true,
            run: () => api.del(`/api/treatments/${row.id}`),
            onDone: screen.reload,
          }),
        }, t('common.delete')),
      } : null,
    ].filter(Boolean),
  });

  if (query?.get('new') === '1' && can('treatments.create')) create();
  return screen.element;
}

/* --------------------------------------------------------------------- plans */

export function plansScreen({ t, query }) {
  setPageTitle('nav.plans');
  const create = () => {
    let picked = query?.get('patientId') ? { id: Number(query.get('patientId')) } : null;
    const modal = openModal({
      title: t('plans.new'),
      wide: true,
      body: h('div', { class: 'stack' }, [
        query?.get('patientId') ? null : patientPicker((patient) => { picked = patient; }, t),
        h('div', { id: 'planForm' }),
      ]),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
      ],
    });
    const builder = buildForm([
      { name: 'title', label: 'plans.name', required: true, span: 2 },
      { name: 'diagnosis', label: 'visits.diagnosis', type: 'textarea', span: 2 },
      { name: 'proposed_date', label: 'plans.proposedDate', type: 'date' },
      { name: 'status', label: 'common.status', type: 'select', options: ['draft', 'proposed', 'accepted', 'in_progress', 'completed', 'declined'].map((value) => ({ value, label: `status.${value}` })) },
      { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
    ], t, { values: { proposed_date: today(), status: 'proposed' } });
    mount('#planForm', [builder.form]);

    async function save() {
      if (!picked?.id) return toast({ message: t('common.selectPatient'), tone: 'warn' });
      try {
        const created = await api.post('/api/plans', { ...builder.values(), patient_id: picked.id ?? picked.entityId, items: [] });
        modal.close();
        navigate(`/plans/${created.id}`);
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }
  };

  const screen = listScreen({
    t,
    title: t('nav.plans'),
    subtitle: t('plans.subtitle'),
    endpoint: '/api/plans',
    query: { patientId: query?.get('patientId') ?? undefined },
    onCreate: can('plans.create') ? create : null,
    createLabel: t('plans.new'),
    onRowClick: (row) => navigate(`/plans/${row.id}`),
    columns: [
      { key: 'planCode', label: 'plans.code', width: '130px' },
      { key: 'title', label: 'plans.name' },
      { key: 'patientName', label: 'patients.fullName' },
      { key: 'proposedDate', label: 'plans.proposedDate', date: true },
      { key: 'totalMinor', label: 'plans.estimatedTotal', money: true, num: true },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
    ],
  });
  return screen.element;
}

export function planDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.plans');
  let plan = null;
  let services = [];

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      [plan, services] = await Promise.all([
        api.get(`/api/plans/${id}`),
        api.get('/api/treatments/services').then((payload) => payload?.rows ?? []),
      ]);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    return recordLayout({
      t,
      title: `${plan.planCode} · ${plan.title}`,
      subtitle: plan.patientName,
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [
        statusPill(plan.status, t),
        h('span', { class: 'pill' }, `${t('plans.estimatedTotal')}: ${amount(plan.totalMinor)}`),
      ]),
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/patients/${plan.patientId}`) }, t('patients.profile')),
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('plan', plan.id, { t }) }, t('plans.printEstimate')),
        can('plans.edit') ? h('button', { type: 'button', class: 'primary', onclick: addItem }, t('plans.addItem')) : null,
        can('plans.edit') ? h('button', { type: 'button', class: 'ghost', onclick: updateStatus }, t('common.status')) : null,
        can('plans.edit') ? h('button', { type: 'button', class: 'ghost', onclick: invoicePreview }, t('billing.fromPlan')) : null,
      ],
      body: h('div', { class: 'stack' }, [
        card({
          title: t('plans.items'),
          body: (plan.items ?? []).length
            ? table([
              { key: 'name', label: 'treatments.procedure' },
              { key: 'toothCodes', label: 'treatments.tooth', render: (row) => (row.toothCodes ?? []).join(', ') || '—' },
              { key: 'quantityMilli', label: 'common.quantity', render: (row) => qty(row.quantityMilli), num: true },
              { key: 'unitPriceMinor', label: 'common.price', money: true, num: true },
              { key: 'lineTotalMinor', label: 'common.total', money: true, num: true },
              { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
              can('plans.edit') ? {
                label: 'common.actions',
                className: 'actions',
                render: (row) => h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => confirmAction({
                    t,
                    title: t('common.deleteConfirm'),
                    message: row.name,
                    danger: true,
                    run: () => api.put(`/api/plans/items/${row.id}`, { deleted: true, status: 'cancelled' }),
                    onDone: load,
                  }),
                }, t('common.remove')),
              } : null,
            ].filter(Boolean), plan.items, { t })
            : h('p', { class: 'muted small' }, t('plans.emptyHint')),
        }),
        h('div', { class: 'two-col' }, [
          card({
            title: t('common.details'),
            body: kv([
              [t('plans.code'), plan.planCode],
              [t('visits.diagnosis'), plan.diagnosis],
              [t('plans.proposedDate'), plan.proposedDate ? date(plan.proposedDate) : null],
              [t('common.notes'), plan.notes],
              [t('common.created'), dateTime(plan.createdAt)],
            ]),
          }),
          card({
            title: t('plans.estimatedTotal'),
            body: h('table', { class: 'totals' }, h('tbody', {}, [
              h('tr', {}, [h('td', {}, t('common.subtotal')), h('td', { class: 'right' }, amount(plan.subtotalMinor))]),
              h('tr', {}, [h('td', {}, t('common.discount')), h('td', { class: 'right' }, amount(plan.discountMinor))]),
              h('tr', {}, [h('td', {}, t('common.tax')), h('td', { class: 'right' }, amount(plan.taxMinor))]),
              h('tr', { class: 'grand' }, [h('td', {}, t('common.total')), h('td', { class: 'right' }, amount(plan.totalMinor))]),
            ])),
          }),
        ]),
      ]),
    });
  }

  function addItem() {
    formModal({
      t,
      title: t('plans.addItem'),
      columns: 2,
      fields: [
        { name: 'service_id', label: 'treatments.service', type: 'select', numericValues: true, options: [{ value: '', label: 'treatments.customProcedure' }, ...services.map((service) => ({ value: service.id, label: service.nameEn }))] },
        { name: 'name', label: 'treatments.procedure', required: true },
        { name: 'tooth_codes', label: 'treatments.tooth' },
        { name: 'quantity_milli', label: 'common.quantity', type: 'qty' },
        { name: 'unit_price_minor', label: 'common.price', type: 'money' },
        { name: 'discount_minor', label: 'common.discount', type: 'money' },
        { name: 'stage', label: 'plans.stage', type: 'select', options: ['stage1', 'stage2', 'stage3', 'stage4'].map((value) => ({ value, label: `status.${value}` })) },
        { name: 'notes', label: 'common.notes' },
      ],
      values: { quantity_milli: 1000 },
      submit: (values) => api.put(`/api/plans/${plan.id}`, {
        items: [
          ...(plan.items ?? []).map((item) => ({
            id: item.id,
            service_id: item.serviceId,
            name: item.name,
            tooth_codes: item.toothCodes,
            quantity_milli: item.quantityMilli,
            unit_price_minor: item.unitPriceMinor,
            discount_minor: item.discountMinor,
            stage: item.stage,
          })),
          { ...values, tooth_codes: String(values.tooth_codes ?? '').split(/[,\s]+/).filter(Boolean) },
        ],
      }),
      onSaved: load,
    });
  }

  function updateStatus() {
    formModal({
      t,
      title: t('common.status'),
      columns: 1,
      fields: [{ name: 'status', label: 'common.status', type: 'select', options: ['draft', 'proposed', 'accepted', 'in_progress', 'completed', 'declined'].map((value) => ({ value, label: `status.${value}` })) }],
      values: { status: plan.status },
      submit: (values) => api.put(`/api/plans/${plan.id}`, values),
      onSaved: load,
    });
  }

  async function invoicePreview() {
    try {
      const preview = await api.post(`/api/plans/${plan.id}/invoice-preview`, {});
      mount(host, render());
      openModal({
        title: t('plans.invoice'),
        wide: true,
        body: h('div', { class: 'stack' }, [
          table([
            { key: 'name', label: 'treatments.procedure' },
            { key: 'quantityMilli', label: 'common.quantity', render: (row) => qty(row.quantityMilli), num: true },
            { key: 'unitPriceMinor', label: 'common.price', money: true, num: true },
            { key: 'lineTotalMinor', label: 'common.total', money: true, num: true },
          ], preview?.items ?? [], { t }),
          h('table', { class: 'totals' }, h('tbody', {}, [
            h('tr', { class: 'grand' }, [h('td', {}, t('common.total')), h('td', { class: 'right' }, amount(preview?.totalMinor ?? 0))]),
          ])),
        ]),
        footer: [
          h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/billing?patientId=${plan.patientId}&planId=${plan.id}`) }, t('billing.new')),
        ],
      });
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  load();
  return () => {};
}

/* -------------------------------------------------------------- prescriptions */

/**
 * New prescription: free-text or template medications, with the same field
 * names the service validates (`medications[]`).
 */
export function newPrescriptionScreen({ t, query }) {
  setPageTitle('nav.prescriptions');
  const presetPatient = query?.get('patientId');
  let picked = presetPatient ? { id: Number(presetPatient) } : null;
  const rows = [];
  const listHost = h('div', { class: 'stack' });
  let templates = [];

  const templateSelect = h('select', {
    onchange: (event) => {
      const template = templates.find((item) => String(item.id) === event.target.value);
      if (!template) return;
      for (const item of template.items ?? []) rows.push({ ...item });
      renderRows();
    },
  }, [{ id: '', name: t('prescriptions.useTemplate') }, ...templates.map((template) => ({ id: template.id, name: template.name }))]
    .map((option) => h('option', { value: option.id }, option.name)));

  function addRow(seed = {}) {
    const row = {
      medicine: seed.medicine ?? '',
      strength: seed.strength ?? '',
      dose: seed.dose ?? '',
      frequency: seed.frequency ?? '',
      duration: seed.duration ?? '',
      instructions: seed.instructions ?? '',
    };
    rows.push(row);
    renderRows();
  }

  function renderRows() {
    mount(listHost, rows.length
      ? rows.map((row, index) => h('div', { class: 'card' }, h('div', { class: 'card-body grid-3' }, [
        input(t('prescriptions.medicine'), row.medicine, (value) => { row.medicine = value; }),
        input(t('prescriptions.strength'), row.strength, (value) => { row.strength = value; }),
        input(t('prescriptions.dose'), row.dose, (value) => { row.dose = value; }),
        input(t('prescriptions.frequency'), row.frequency, (value) => { row.frequency = value; }),
        input(t('prescriptions.duration'), row.duration, (value) => { row.duration = value; }),
        h('div', { class: 'row-actions' }, h('button', {
          type: 'button',
          class: 'link',
          onclick: () => { rows.splice(index, 1); renderRows(); },
        }, t('common.remove'))),
      ])))
      : [h('p', { class: 'muted small' }, t('common.emptyHint'))]);
  }

  function input(label, value, onChange) {
    return h('label', {}, [h('span', {}, label), h('input', { type: 'text', value, oninput: (event) => onChange(event.target.value) })]);
  }

  const detailFields = [
    { name: 'rx_date', label: 'common.date', type: 'date' },
    { name: 'followup_date', label: 'prescriptions.followup', type: 'date' },
    { name: 'diagnosis', label: 'visits.diagnosis', span: 2 },
    { name: 'investigations', label: 'prescriptions.investigations', type: 'textarea', span: 2 },
    { name: 'advice', label: 'prescriptions.advice', type: 'textarea', span: 2 },
    { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
  ];
  const detail = buildForm(detailFields, t, { values: { rx_date: today() } });

  const host = h('div', { class: 'stack' }, [
    h('div', { class: 'toolbar' }, [
      h('h2', {}, t('prescriptions.new')),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'ghost', onclick: () => navigate('/prescriptions') }, t('common.cancel')),
      h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
    ]),
    card({ t, body: h('div', { class: 'stack' }, [
      presetPatient ? h('p', { class: 'help' }, `${t('patients.code')}: ${presetPatient}`) : patientPicker((patient) => { picked = patient; }, t),
      detail.form,
    ]) }),
    card({
      title: t('prescriptions.medications'),
      actions: [
        templateSelect,
        h('button', { type: 'button', class: 'ghost', onclick: () => addRow() }, t('prescriptions.addMedicine')),
      ],
      body: listHost,
    }),
  ]);

  async function save() {
    if (!picked?.id) return toast({ message: t('common.selectPatient'), tone: 'warn' });
    try {
      const created = await api.post('/api/prescriptions', {
        ...detail.values(),
        patient_id: picked.id ?? picked.entityId,
        medications: rows.filter((row) => row.medicine),
      });
      toast({ message: t('common.saved'), tone: 'ok' });
      navigate(`/prescriptions/${created.id}`);
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  api.get('/api/prescriptions/templates/list').then((payload) => {
    templates = payload?.rows ?? [];
  }).catch(() => {});

  addRow();
  mount('#view', host);
  return () => {};
}



export function prescriptionsScreen({ t, query }) {
  setPageTitle('nav.prescriptions');
  const create = () => navigate(`/prescriptions/new?patientId=${query?.get('patientId') ?? ''}`);

  const screen = listScreen({
    t,
    title: t('nav.prescriptions'),
    subtitle: t('prescriptions.subtitle'),
    endpoint: '/api/prescriptions',
    query: { patientId: query?.get('patientId') ?? undefined },
    onCreate: can('prescriptions.create') ? create : null,
    createLabel: t('prescriptions.new'),
    onRowClick: (row) => navigate(`/prescriptions/${row.id}`),
    columns: [
      { key: 'rxCode', label: 'prescriptions.code', width: '140px' },
      { key: 'patientName', label: 'patients.fullName' },
      { key: 'rxDate', label: 'common.date', date: true },
      { key: 'diagnosis', label: 'visits.diagnosis' },
      { key: 'itemCount', label: 'reports.columns.count', num: true },
      { key: 'printedCount', label: 'doc.printedOn', num: true },
    ],
  });

  if (query?.get('new') === '1' && can('prescriptions.create')) navigate('/prescriptions/new');
  return screen.element;
}

export function prescriptionDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.prescriptions');
  let rx = null;

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      rx = await api.get(`/api/prescriptions/${id}`);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    return recordLayout({
      t,
      title: `${rx.rxCode} · ${rx.patientName}`,
      subtitle: `${date(rx.rxDate)}${rx.practitionerName ? ` · ${rx.practitionerName}` : ''}`,
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/patients/${rx.patientId}`) }, t('patients.profile')),
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('prescription', rx.id, { t }) }, t('prescriptions.print')),
        can('prescriptions.delete') ? h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => confirmAction({
            t,
            title: t('common.deleteConfirm'),
            message: rx.rxCode,
            danger: true,
            run: () => api.del(`/api/prescriptions/${rx.id}`),
            onDone: () => navigate('/prescriptions'),
          }),
        }, t('common.delete')) : null,
      ],
      body: h('div', { class: 'stack' }, [
        card({
          title: t('prescriptions.medications'),
          body: (rx.items ?? []).length
            ? table([
              { key: 'medicine', label: 'prescriptions.medicine' },
              { key: 'strength', label: 'prescriptions.strength' },
              { key: 'dose', label: 'prescriptions.dose' },
              { key: 'frequency', label: 'prescriptions.frequency' },
              { key: 'duration', label: 'prescriptions.duration' },
              { key: 'instructions', label: 'prescriptions.instructions' },
            ], rx.items, { t })
            : h('p', { class: 'muted small' }, t('common.emptyHint')),
        }),
        h('div', { class: 'two-col' }, [
          card({ title: t('visits.diagnosis'), body: kv([[t('visits.diagnosis'), rx.diagnosis], [t('prescriptions.advice'), rx.advice], [t('prescriptions.investigations'), rx.investigations], [t('prescriptions.followup'), rx.followupDate ? date(rx.followupDate) : null]]) }),
          card({ title: t('common.notes'), body: h('p', {}, rx.notes ?? t('common.empty')) }),
        ]),
      ]),
    });
  }

  load();
  return () => {};
}

/* ----------------------------------------------------------------- referrals */

export function referralsScreen({ t, query }) {
  setPageTitle('nav.referrals');
  const screen = listScreen({
    t,
    title: t('nav.referrals'),
    subtitle: t('referrals.subtitle'),
    endpoint: '/api/referrals',
    query: { patientId: query?.get('patientId') ?? undefined },
    onRowClick: (row) => navigate(`/referrals/${row.id}`),
    columns: [
      { key: 'referralCode', label: 'referrals.code', width: '140px' },
      { key: 'patientName', label: 'patients.fullName' },
      { key: 'providerName', label: 'referrals.provider' },
      { key: 'specialty', label: 'referrals.specialty' },
      { key: 'urgency', label: 'referrals.urgency', render: (row) => statusPill(row.urgency, t) },
      { key: 'referralDate', label: 'common.date', date: true },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
    ],
  });
  return screen.element;
}

export function referralDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.referrals');
  let referral = null;

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      referral = await api.get(`/api/referrals/${id}`);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    return recordLayout({
      t,
      title: `${referral.referralCode} · ${referral.patientName}`,
      subtitle: referral.providerName ?? '',
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [statusPill(referral.status, t), statusPill(referral.urgency, t)]),
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/patients/${referral.patientId}`) }, t('patients.profile')),
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('referral', referral.id, { t }) }, t('referrals.printLetter')),
        can('referrals.edit') ? h('button', { type: 'button', class: 'primary', onclick: recordOutcome }, t('referrals.recordOutcome')) : null,
      ],
      body: h('div', { class: 'two-col' }, [
        card({
          title: t('common.details'),
          body: kv([
            [t('referrals.provider'), referral.providerName],
            [t('referrals.specialty'), referral.specialty],
            [t('referrals.institution'), referral.institution],
            [t('referrals.reason'), referral.reason],
            [t('referrals.clinicalSummary'), referral.clinicalSummary],
            [t('referrals.expectations'), referral.expectations],
            [t('common.date'), referral.referralDate ? date(referral.referralDate) : null],
          ]),
        }),
        card({
          title: t('referrals.outcome'),
          body: kv([
            [t('common.status'), referral.outcomeDate ? date(referral.outcomeDate) : null],
            [t('referrals.outcomeNotes'), referral.outcomeNotes],
          ]),
        }),
      ]),
    });
  }

  function recordOutcome() {
    formModal({
      t,
      title: t('referrals.recordOutcome'),
      columns: 1,
      fields: [
        { name: 'status', label: 'common.status', type: 'select', options: ['answered', 'completed', 'failed', 'pending'].map((value) => ({ value, label: `status.${value}` })) },
        { name: 'outcome_date', label: 'referrals.outcomeDate', type: 'date' },
        { name: 'outcome_notes', label: 'referrals.outcomeNotes', type: 'textarea', rows: 3 },
      ],
      values: { outcome_date: today(), status: referral.status },
      submit: (values) => api.post(`/api/referrals/${referral.id}/outcome`, values),
      onSaved: load,
    });
  }

  load();
  return () => {};
}

/* --------------------------------------------------------------- attachments */

export function attachmentsScreen({ t, query }) {
  setPageTitle('nav.attachments');
  let pickedPatient = query?.get('patientId') ? Number(query.get('patientId')) : null;

  const upload = () => {
    const fileInput = h('input', { type: 'file', accept: 'image/*,application/pdf' });
    const kindSelect = h('select', {}, [
      'radiograph', 'photo', 'report', 'scan', 'lab', 'consent', 'referral', 'other',
    ].map((kind) => h('option', { value: kind }, enumLabel('attachments.kind', kind, t))));
    const note = h('input', { type: 'text', placeholder: t('common.notes') });
    const target = h('div', { class: 'stack' }, [
      h('label', {}, [h('span', {}, t('patients.fullName')), patientPicker((patient) => { pickedPatient = patient.id ?? patient.entityId; }, t)]),
      h('label', {}, [h('span', {}, t('common.type')), kindSelect]),
      h('label', {}, [h('span', {}, t('common.notes')), note]),
      h('label', {}, [h('span', {}, t('attachments.fileName')), fileInput]),
    ]);
    const modal = openModal({
      title: t('attachments.upload'),
      body: target,
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'primary', onclick: send }, t('attachments.upload')),
      ],
    });

    async function send() {
      const file = fileInput.files?.[0];
      if (!file) return toast({ message: t('common.chooseFile'), tone: 'warn' });
      const data = new FormData();
      data.set('file', file);
      data.set('kind', kindSelect.value);
      if (note.value) data.set('notes', note.value);
      if (pickedPatient) data.set('patient_id', String(pickedPatient));
      try {
        await api.upload('/api/attachments', data);
        modal.close();
        toast({ message: t('common.saved'), tone: 'ok' });
        screen.reload();
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }
  };

  const screen = listScreen({
    t,
    title: t('nav.attachments'),
    subtitle: t('attachments.subtitle'),
    endpoint: '/api/attachments',
    query: { patientId: query?.get('patientId') ?? undefined },
    onCreate: can('attachments.add') ? upload : null,
    createLabel: t('attachments.upload'),
    columns: [
      { key: 'fileName', label: 'attachments.fileName', render: (row) => h('button', {
        type: 'button',
        class: 'link',
        onclick: () => window.open(`/api/attachments/${row.id}/content`, '_blank'),
      }, row.fileName) },
      { key: 'kind', label: 'common.type' },
      { key: 'patientName', label: 'patients.fullName', render: (row) => row.patientId ? h('button', { type: 'button', class: 'link', onclick: () => navigate(`/patients/${row.patientId}`) }, row.patientName ?? `#${row.patientId}`) : h('span', { class: 'muted' }, '—') },
      { key: 'sizeBytes', label: 'attachments.size', render: (row) => h('span', {}, `${Math.max(1, Math.round((row.sizeBytes ?? 0) / 1024))} KB`), num: true },
      { key: 'creatorName', label: 'common.createdBy' },
      { key: 'createdAt', label: 'common.created', date: true },
      can('attachments.delete') ? {
        label: 'common.actions',
        className: 'actions',
        render: (row) => h('button', {
          type: 'button',
          class: 'link',
          onclick: () => confirmAction({
            t,
            title: t('common.deleteConfirm'),
            message: row.fileName,
            danger: true,
            run: () => api.del(`/api/attachments/${row.id}`),
            onDone: screen.reload,
          }),
        }, t('common.delete')),
      } : null,
    ].filter(Boolean),
  });
  return screen.element;
}
