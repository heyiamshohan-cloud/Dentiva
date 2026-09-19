/**
 * Money: invoices, payments, receivables and the Finance ledger.
 *
 * Finance is deliberately its own screen (spec § 8) rather than a dashboard
 * panel: income/expense ledger, categories, trends and exports live here.
 */
import { api, exportReport } from '../core/api.js';
import { can, state } from '../core/store.js';
import { bars, enumLabel, form as buildForm, h, mount, openModal, statusPill, table, toast } from '../core/dom.js';
import { addDays, amount, date, dateTime, localizeDigits, monthName, qty, startOfMonth, today } from '../core/format.js';
import { navigate } from '../core/router.js';
import { setPageTitle } from '../main.js';
import { printDocument } from '../core/print.js';
import { card, confirmAction, emptyState, errorState, formModal, kv, listScreen, loading, recordLayout, tabs } from './ui.js';
import { patientPicker } from './scheduling.js';

const METHODS = [
  { value: 'cash', label: 'payments.cash' },
  { value: 'bank', label: 'payments.bank' },
  { value: 'card', label: 'payments.card' },
  { value: 'mfs', label: 'payments.mfs' },
  { value: 'other', label: 'payments.other' },
];

/* ------------------------------------------------------------------ invoices */

export function invoicesScreen({ t, query }) {
  setPageTitle('nav.billing');
  const presetPatient = query?.get('patientId');

  const create = async () => {
    let picked = presetPatient ? { id: Number(presetPatient) } : null;
    const items = [];
    const itemsHost = h('div', { class: 'stack' });
    let services = [];

    const header = buildForm([
      { name: 'invoice_date', label: 'billing.date', type: 'date', required: true },
      { name: 'due_date', label: 'billing.dueDate', type: 'date' },
      { name: 'notes', label: 'common.notes', span: 2 },
    ], t, { values: { invoice_date: today() } });

    const modal = openModal({
      title: t('billing.new'),
      wide: true,
      body: h('div', { class: 'stack' }, [
        presetPatient ? null : patientPicker((patient) => { picked = patient; }, t),
        header.form,
        h('div', { class: 'row-actions' }, [
          h('h3', {}, t('billing.items')),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'ghost', onclick: () => addItem() }, t('billing.addLine')),
        ]),
        itemsHost,
      ]),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'primary', onclick: save }, t('billing.issue')),
      ],
    });

    function lineTotal(item) {
      return Math.round((item.quantity_milli / 1000) * item.unit_price_minor) - item.discount_minor;
    }

    function addItem(seed = {}) {
      items.push({
        service_id: seed.service_id ?? null,
        treatment_id: seed.treatment_id ?? null,
        description: seed.description ?? '',
        tooth_codes: seed.tooth_codes ?? [],
        quantity_milli: seed.quantity_milli ?? 1000,
        unit_price_minor: seed.unit_price_minor ?? 0,
        discount_minor: seed.discount_minor ?? 0,
      });
      renderItems();
    }

    function renderItems() {
      const total = items.reduce((sum, item) => sum + lineTotal(item), 0);
      mount(itemsHost, [
        items.length
          ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, [
            h('thead', {}, h('tr', {}, [
              t('billing.items'), t('common.quantity'), t('common.price'), t('common.discount'), t('common.total'), '',
            ].map((label) => h('th', {}, label)))),
            h('tbody', {}, items.map((item, index) => h('tr', {}, [
              h('td', {}, h('input', { type: 'text', value: item.description, oninput: (event) => { item.description = event.target.value; } })),
              h('td', { class: 'num' }, h('input', {
                type: 'number', step: '0.001', min: '0', value: (item.quantity_milli / 1000).toFixed(3),
                oninput: (event) => { item.quantity_milli = Math.round(Number(event.target.value || 0) * 1000); renderItems(); },
              })),
              h('td', { class: 'num' }, h('input', {
                type: 'number', step: '0.01', min: '0', value: (item.unit_price_minor / 100).toFixed(2),
                oninput: (event) => { item.unit_price_minor = Math.round(Number(event.target.value || 0) * 100); renderItems(); },
              })),
              h('td', { class: 'num' }, h('input', {
                type: 'number', step: '0.01', min: '0', value: (item.discount_minor / 100).toFixed(2),
                oninput: (event) => { item.discount_minor = Math.round(Number(event.target.value || 0) * 100); renderItems(); },
              })),
              h('td', { class: 'num strong' }, amount(lineTotal(item))),
              h('td', { class: 'actions' }, h('button', {
                type: 'button', class: 'link', onclick: () => { items.splice(index, 1); renderItems(); },
              }, t('common.remove'))),
            ]))),
          ]))
          : h('p', { class: 'muted small' }, t('billing.emptyLines')),
        h('p', { class: 'right strong' }, `${t('common.total')}: ${amount(total)}`),
      ]);
    }

    api.get('/api/treatments/services').then((payload) => {
      services = payload?.rows ?? [];
      const planId = query?.get('planId');
      const treatmentId = query?.get('treatmentId');
      if (planId) {
        api.get(`/api/plans/${planId}`).then((plan) => {
          for (const item of plan.items ?? []) {
            addItem({ service_id: item.serviceId, description: item.name, quantity_milli: item.quantityMilli, unit_price_minor: item.unitPriceMinor, tooth_codes: item.toothCodes });
          }
        }).catch(() => addItem());
      } else if (treatmentId) {
        api.get(`/api/treatments/${treatmentId}`).then((treatment) => {
          addItem({
            service_id: treatment.serviceId,
            treatment_id: treatment.id,
            description: treatment.name,
            quantity_milli: treatment.quantityMilli ?? 1000,
            unit_price_minor: treatment.feeMinor ?? 0,
            tooth_codes: treatment.toothCodes,
          });
        }).catch(() => addItem());
      } else {
        addItem();
      }
    }).catch((error) => mount(itemsHost, h('div', { class: 'alert' }, error.message)));

    async function save() {
      if (!picked?.id) return toast({ message: t('common.selectPatient'), tone: 'warn' });
      if (!items.length) return toast({ message: t('billing.emptyLines'), tone: 'warn' });
      try {
        const created = await api.post('/api/invoices', {
          ...header.values(),
          patient_id: picked.id ?? picked.entityId,
          items: items.map((item) => ({
            service_id: item.service_id ?? undefined,
            treatment_id: item.treatment_id ?? undefined,
            description: item.description,
            quantity_milli: item.quantity_milli,
            unit_price_minor: item.unit_price_minor,
            discount_minor: item.discount_minor,
            tooth_codes: item.tooth_codes,
          })),
        });
        modal.close();
        toast({ message: t('common.saved'), tone: 'ok' });
        navigate(`/billing/${created.id}`);
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }
  };

  const screen = listScreen({
    t,
    title: t('nav.billing'),
    subtitle: t('billing.subtitle'),
    endpoint: '/api/invoices',
    query: { patientId: presetPatient ?? undefined },
    filters: [
      { name: 'status', options: [
        { value: '', label: 'common.all' },
        { value: 'draft', label: 'billing.statusDraft' },
        { value: 'issued', label: 'billing.statusIssued' },
        { value: 'void', label: 'billing.statusVoid' },
      ] },
      { name: 'paymentStatus', options: [
        { value: '', label: 'common.all' },
        { value: 'unpaid', label: 'status.unpaid' },
        { value: 'partial', label: 'status.partial' },
        { value: 'paid', label: 'status.paid' },
      ] },
    ],
    onCreate: can('billing.create') ? create : null,
    createLabel: t('billing.new'),
    onRowClick: (row) => navigate(`/billing/${row.id}`),
    columns: [
      { key: 'invoiceNumber', label: 'billing.number', width: '150px' },
      { key: 'patientName', label: 'patients.fullName', render: (row) => h('div', {}, [h('div', { class: 'strong' }, row.patientName), h('div', { class: 'small muted' }, row.patientCode ?? '')]) },
      { key: 'invoiceDate', label: 'billing.date', date: true, width: '110px' },
      { key: 'totalMinor', label: 'common.total', money: true, num: true },
      { key: 'paidMinor', label: 'common.paid', money: true, num: true },
      { key: 'dueMinor', label: 'common.due', money: true, num: true },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
      { key: 'paymentStatus', label: 'billing.paymentStatus', render: (row) => statusPill(row.paymentStatus ?? 'unpaid', t) },
    ],
  });
  return screen.element;
}

export function invoiceDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.billing');
  let invoice = null;

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      invoice = await api.get(`/api/invoices/${id}`);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    const due = Number(invoice.dueMinor ?? 0);
    return recordLayout({
      t,
      title: `${invoice.invoiceNumber} · ${invoice.patientName ?? ''}`,
      subtitle: `${date(invoice.invoiceDate)}${invoice.dueDate ? ` · ${t('billing.dueDate')}: ${date(invoice.dueDate)}` : ''}`,
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [
        statusPill(invoice.status, t),
        statusPill(invoice.paymentStatus ?? 'unpaid', t),
        invoice.isOverdue ? h('span', { class: 'pill danger' }, t('billing.overdue')) : null,
      ]),
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('invoice', invoice.id, { t }) }, t('billing.printInvoice')),
        due > 0 && can('payments.create') ? h('button', { type: 'button', class: 'primary', onclick: () => takePayment(invoice, load, t) }, t('payments.new')) : null,
        invoice.status === 'draft' && can('billing.edit') ? h('button', { type: 'button', class: 'ghost', onclick: issue }, t('billing.issue')) : null,
        can('billing.void') && invoice.status !== 'void' ? h('button', { type: 'button', class: 'danger', onclick: voidInvoice }, t('common.void')) : null,
      ],
      body: h('div', { class: 'stack' }, [
        card({
          title: t('billing.items'),
          body: table([
            { key: 'description', label: 'billing.items' },
            { key: 'toothCodes', label: 'treatments.tooth', render: (row) => (row.toothCodes ?? []).join(', ') || '—' },
            { key: 'quantityMilli', label: 'common.quantity', render: (row) => qty(row.quantityMilli), num: true },
            { key: 'unitPriceMinor', label: 'common.price', money: true, num: true },
            { key: 'discountMinor', label: 'common.discount', money: true, num: true },
            { key: 'taxMinor', label: 'common.tax', money: true, num: true },
            { key: 'lineTotalMinor', label: 'common.total', money: true, num: true },
          ], invoice.items ?? [], { t }),
        }),
        h('div', { class: 'two-col' }, [
          card({
            title: t('payments.title'),
            body: (invoice.payments ?? []).length
              ? table([
                { key: 'receiptNumber', label: 'payments.receiptNo' },
                { key: 'paymentDate', label: 'common.date', date: true },
                { key: 'amountMinor', label: 'common.amount', money: true, num: true },
                { label: 'common.actions', className: 'actions', render: (row) => h('button', { type: 'button', class: 'link', onclick: () => navigate(`/payments/${row.id}`) }, t('common.open')) },
              ], invoice.payments, { t })
              : h('p', { class: 'muted small' }, t('common.emptyHint')),
          }),
          card({
            title: t('common.total'),
            body: h('table', { class: 'totals' }, h('tbody', {}, [
              h('tr', {}, [h('td', {}, t('common.subtotal')), h('td', { class: 'right' }, amount(invoice.subtotalMinor))]),
              h('tr', {}, [h('td', {}, t('common.discount')), h('td', { class: 'right' }, amount(invoice.discountMinor))]),
              h('tr', {}, [h('td', {}, t('common.tax')), h('td', { class: 'right' }, amount(invoice.taxMinor))]),
              h('tr', { class: 'grand' }, [h('td', {}, t('common.total')), h('td', { class: 'right' }, amount(invoice.totalMinor))]),
              h('tr', {}, [h('td', {}, t('common.paid')), h('td', { class: 'right' }, amount(invoice.paidMinor))]),
              h('tr', {}, [h('td', {}, t('common.due')), h('td', { class: 'right strong' }, amount(due))]),
              invoice.creditMinor ? h('tr', {}, [h('td', {}, t('payments.creditBalance')), h('td', { class: 'right' }, amount(invoice.creditMinor))]) : null,
            ])),
          }),
        ]),
        card({
          title: t('common.notes'),
          body: kv([
            [t('common.notes'), invoice.notes],
            [t('common.created'), dateTime(invoice.createdAt)],
          ]),
        }),
      ]),
    });
  }

  async function issue() {
    try {
      await api.post(`/api/invoices/${invoice.id}/issue`, {});
      toast({ message: t('common.saved'), tone: 'ok' });
      load();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  function voidInvoice() {
    formModal({
      t,
      title: t('common.void'),
      columns: 1,
      fields: [{ name: 'reason', label: 'billing.voidReason', required: true }],
      submit: (values) => api.post(`/api/invoices/${invoice.id}/void`, values),
      onSaved: load,
    });
  }

  load();
  return () => {};
}

/* ------------------------------------------------------------------ payments */

export function paymentsScreen({ t, query }) {
  setPageTitle('nav.payments');
  const presetPatient = query?.get('patientId');

  const create = async () => {
    let picked = presetPatient ? { id: Number(presetPatient) } : null;
    const invoices = [];
    const methods = (await api.get('/api/payments/methods').catch(() => ({ rows: [] })))?.rows ?? [];
    const builder = buildForm([
      { name: 'invoice_id', label: 'billing.number', type: 'select', numericValues: true, options: [{ value: '', label: 'payments.directReceipt' }] },
      { name: 'payment_date', label: 'common.date', type: 'date', required: true },
      { name: 'amount_minor', label: 'common.amount', type: 'money', required: true },
      { name: 'method_code', label: 'payments.method', type: 'select', options: methods.map((method) => ({ value: method.code, label: state.locale === 'bn' ? method.nameBn : method.nameEn })) },
      { name: 'reference_no', label: 'payments.reference' },
      { name: 'notes', label: 'common.notes', span: 2 },
    ], t, { values: { payment_date: today(), method_code: 'cash' } });

    const modal = openModal({
      title: t('payments.new'),
      wide: true,
      body: h('div', { class: 'stack' }, [
        presetPatient ? h('p', { class: 'help' }, `${t('patients.code')}: ${presetPatient}`) : patientPicker(async (patient) => {
          picked = patient;
          await loadInvoices();
        }, t),
        builder.form,
      ]),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
      ],
    });

    async function loadInvoices() {
      const patient = /** @type {any} */ (picked);
      if (!patient) return;
      try {
        const payload = await api.get('/api/invoices', { patientId: patient.id ?? patient.entityId, status: 'issued', pageSize: 50 });
        invoices.push(...(payload?.rows ?? []));
        const select = /** @type {HTMLSelectElement} */ (builder.form.querySelector('[name="invoice_id"]'));
        for (const invoice of invoices) {
          const option = document.createElement('option');
          option.value = String(invoice.id);
          option.textContent = `${invoice.invoiceNumber} · ${t('common.due')} ${amount(invoice.dueMinor)}`;
          select.appendChild(option);
        }
        select.addEventListener('change', () => {
          const invoice = invoices.find((item) => String(item.id) === select.value);
          const input = /** @type {HTMLInputElement} */ (builder.form.querySelector('[name="amount_minor"]'));
          if (invoice && input) input.value = (invoice.dueMinor / 100).toFixed(2);
        });
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }

    async function save() {
      if (!picked?.id) return toast({ message: t('common.selectPatient'), tone: 'warn' });
      try {
        const values = builder.values();
        const result = await api.post('/api/payments', {
          ...values,
          patient_id: picked.id ?? picked.entityId,
          invoice_id: values.invoice_id ?? undefined,
        });
        modal.close();
        toast({ message: `${t('payments.receiptNo')} ${result?.receipts?.[0]?.receiptNumber ?? ''}`, tone: 'ok' });
        screen.reload();
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }

    if (presetPatient) await loadInvoices();
  };

  const screen = listScreen({
    t,
    title: t('nav.payments'),
    subtitle: t('payments.subtitle'),
    endpoint: '/api/payments',
    query: { patientId: presetPatient ?? undefined },
    filters: [
      { name: 'method', options: [{ value: '', label: 'common.all' }, ...METHODS] },
    ],
    onCreate: can('payments.create') ? create : null,
    createLabel: t('payments.new'),
    onRowClick: (row) => navigate(`/payments/${row.id}`),
    columns: [
      { key: 'receiptNumber', label: 'payments.receiptNo', width: '150px' },
      { key: 'patientName', label: 'patients.fullName' },
      { key: 'paymentDate', label: 'common.date', date: true, width: '110px' },
      { key: 'invoiceNumber', label: 'billing.number' },
      { key: 'methodName', label: 'payments.method' },
      { key: 'amountMinor', label: 'common.amount', money: true, num: true },
      { key: 'voidedAt', label: 'common.status', render: (row) => (row.voidedAt ? statusPill('void', t) : statusPill('paid', t)) },
    ],
  });
  return screen.element;
}

export function paymentDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.payments');
  let payment = null;

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      payment = await api.get(`/api/payments/${id}`);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    return recordLayout({
      t,
      title: `${payment.receiptNumber} · ${payment.patientName ?? ''}`,
      subtitle: `${date(payment.paymentDate)} · ${payment.methodName ?? ''}`,
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [
        payment.voidedAt ? statusPill('void', t) : statusPill('paid', t),
        h('span', { class: 'pill accent' }, amount(payment.amountMinor)),
      ]),
      actions: [
        h('button', { type: 'button', class: 'ghost', onclick: () => printDocument('receipt', payment.id, { t }) }, t('payments.printReceipt')),
        payment.invoiceId ? h('button', { type: 'button', class: 'ghost', onclick: () => navigate(`/billing/${payment.invoiceId}`) }, t('billing.title')) : null,
        can('payments.refund') && !payment.voidedAt ? h('button', { type: 'button', class: 'ghost', onclick: refund }, t('payments.refund')) : null,
        can('payments.void') && !payment.voidedAt ? h('button', { type: 'button', class: 'danger', onclick: voidPayment }, t('common.void')) : null,
      ],
      body: h('div', { class: 'two-col' }, [
        card({
          title: t('common.details'),
          body: kv([
            [t('patients.fullName'), payment.patientName],
            [t('payments.receiptNo'), payment.receiptNumber],
            [t('common.date'), date(payment.paymentDate)],
            [t('common.amount'), amount(payment.amountMinor)],
            [t('payments.method'), payment.methodName],
            [t('payments.reference'), payment.referenceNo],
            [t('billing.number'), payment.invoiceNumber],
            [t('common.notes'), payment.notes],
            [t('common.created'), dateTime(payment.createdAt)],
          ]),
        }),
        card({
          title: t('payments.allocate'),
          body: (payment.allocations ?? []).length
            ? table([
              { key: 'invoiceNumber', label: 'billing.number' },
              { key: 'amountMinor', label: 'common.amount', money: true, num: true },
            ], payment.allocations, { t })
            : h('p', { class: 'muted small' }, t('common.emptyHint')),
        }),
      ]),
    });
  }

  function refund() {
    formModal({
      t,
      title: t('payments.refund'),
      columns: 1,
      fields: [
        { name: 'amount_minor', label: 'payments.refundAmount', type: 'money', required: true },
        { name: 'reason', label: 'payments.refundReason', required: true },
      ],
      values: { amount_minor: payment.amountMinor },
      submit: (values) => api.post('/api/payments/refund', { ...values, payment_id: payment.id }),
      onSaved: load,
    });
  }

  function voidPayment() {
    formModal({
      t,
      title: t('common.void'),
      columns: 1,
      fields: [{ name: 'reason', label: 'payments.voidReason', required: true }],
      submit: (values) => api.post(`/api/payments/${payment.id}/void`, values),
      onSaved: load,
    });
  }

  load();
  return () => {};
}

/** Payment dialog shared by the invoice screen. */
export function takePayment(invoice, onDone, t) {
  const methods = [];
  const slot = h('div', {}, h('p', { class: 'muted small' }, t('common.loading')));
  const modal = openModal({
    title: `${t('payments.new')} · ${invoice.invoiceNumber}`,
    body: h('div', { class: 'stack' }, [
      h('p', { class: 'help' }, `${t('common.due')}: ${amount(invoice.dueMinor)}`),
      slot,
    ]),
    footer: [
      h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
      h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
    ],
  });

  let builder;
  api.get('/api/payments/methods').then((payload) => {
    methods.push(...(payload?.rows ?? []));
    builder = buildForm([
      { name: 'amount_minor', label: 'common.amount', type: 'money', required: true },
      { name: 'payment_date', label: 'common.date', type: 'date', required: true },
      { name: 'method_code', label: 'payments.method', type: 'select', options: methods.map((method) => ({ value: method.code, label: state.locale === 'bn' ? method.nameBn : method.nameEn })) },
      { name: 'reference_no', label: 'payments.reference' },
      { name: 'notes', label: 'common.notes', span: 2 },
    ], t, { values: { amount_minor: invoice.dueMinor, payment_date: today(), method_code: 'cash' } });
    mount(slot, [builder.form]);
  }).catch((error) => mount(slot, h('div', { class: 'alert' }, error.message)));

  async function save() {
    if (!builder) return;
    try {
      const result = await api.post('/api/payments', {
        ...builder.values(),
        patient_id: invoice.patientId,
        invoice_id: invoice.id,
      });
      modal.close();
      toast({ message: `${t('payments.receiptNo')} ${result?.receipts?.[0]?.receiptNumber ?? ''}`, tone: 'ok' });
      if (onDone) onDone();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }
}

/* --------------------------------------------------------------- receivables */

export function receivablesScreen({ t }) {
  setPageTitle('nav.receivables');
  const host = h('div', { class: 'stack' });
  mount('#view', host);

  const load = async () => {
    mount(host, loading(t));
    try {
      mount(host, render(await api.get('/api/invoices/receivables')));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render(payload) {
    const totals = payload?.totals ?? {};
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [h('h2', {}, t('billing.receivablesTitle')), h('p', { class: 'muted small' }, t('billing.receivablesSubtitle'))]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: load }, t('common.refresh')),
        can('reports.export') ? h('button', {
          type: 'button',
          class: 'ghost',
          onclick: () => exportReport('receivables', {}).then(() => toast({ message: t('reports.exported'), tone: 'ok' })).catch((error) => toast({ message: error.message, tone: 'error' })),
        }, t('reports.exportCsv')) : null,
      ]),
      h('div', { class: 'cards' }, [
        ['current', totals.current],
        ['days1to30', totals.days1to30],
        ['days31to60', totals.days31to60],
        ['days61to90', totals.days61to90],
        ['over90', totals.over90],
      ].map(([key, value]) => h('div', { class: `card stat ${key === 'over90' ? 'accent' : ''}`.trim() }, [
        h('div', { class: 'label' }, t(`billing.${key}`)),
        h('div', { class: 'value' }, amount(value ?? 0)),
      ]))),
      card({
        title: `${t('billing.receivablesTitle')} · ${t('common.total')} ${amount(payload?.totalDueMinor ?? 0)}`,
        body: (payload?.items ?? []).length
          ? table([
            { key: 'invoiceNumber', label: 'billing.number' },
            { key: 'patientName', label: 'patients.fullName', render: (row) => h('button', { type: 'button', class: 'link', onclick: () => navigate(`/patients/${row.patientId}`) }, row.patientName) },
            { key: 'phone', label: 'common.phone' },
            { key: 'invoiceDate', label: 'billing.date', date: true },
            { key: 'dueDate', label: 'billing.dueDate', date: true },
            { key: 'totalMinor', label: 'common.total', money: true, num: true },
            { key: 'paidMinor', label: 'common.paid', money: true, num: true },
            { key: 'dueMinor', label: 'common.due', money: true, num: true },
            { key: 'ageDays', label: 'billing.ageDays', num: true },
            { key: 'bucket', label: 'billing.bucket', render: (row) => h('span', { class: 'pill warn' }, enumLabel('billing.bucket', row.bucket, t)) },
            {
              label: 'common.actions',
              className: 'actions',
              render: (row) => h('div', { class: 'row-actions' }, [
                h('button', { type: 'button', class: 'link', onclick: () => navigate(`/billing/${row.invoiceId}`) }, t('common.open')),
                can('payments.create') ? h('button', { type: 'button', class: 'link', onclick: () => navigate(`/payments?patientId=${row.patientId}`) }, t('payments.new')) : null,
              ]),
            },
          ], payload.items, { t })
          : emptyState(t('common.noResults'), t('billing.receivablesSubtitle')),
      }),
    ];
  }

  load();
  return () => {};
}

/* ------------------------------------------------------------------- finance */

export function financeScreen({ t, query }) {
  setPageTitle('nav.finance');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  const range = { from: query?.get('from') ?? startOfMonth(), to: query?.get('to') ?? today() };
  let tab = query?.get('tab') ?? 'summary';
  /** @type {any[]} */ let incomeCategories = [];
  /** @type {any[]} */ let expenseCategories = [];

  async function load() {
    mount(host, loading(t));
    try {
      const [summary, trends, incomes, expenses, incomeCats, expenseCats] = await Promise.all([
        api.get('/api/finance/summary', range),
        api.get('/api/finance/trends', { ...range, months: 6 }),
        api.get('/api/finance/incomes', { ...range, pageSize: 25 }),
        api.get('/api/finance/expenses', { ...range, pageSize: 25 }),
        api.get('/api/finance/income-categories', { includeInactive: true }),
        api.get('/api/finance/expense-categories', { includeInactive: true }),
      ]);
      incomeCategories = incomeCats?.rows ?? [];
      expenseCategories = expenseCats?.rows ?? [];
      mount(host, render(summary, trends, incomes, expenses));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function setRange(from, to) {
    range.from = from;
    range.to = to;
    load();
  }

  function tiles(summary) {
    return h('div', { class: 'cards' }, [
      tile(t('finance.invoiced'), amount(summary.invoicedMinor), `${localizeDigits(summary.invoiceCount)} ${t('billing.title')}`),
      tile(t('finance.collected'), amount(summary.collectedMinor), `${localizeDigits(summary.paymentCount)} ${t('nav.payments')}`),
      tile(t('finance.outstanding'), amount(summary.outstandingMinor), `${t('billing.receivablesTitle')}`),
      tile(t('finance.expenses'), amount(summary.expensesMinor), `${localizeDigits(summary.expenseCount)} ${t('finance.expenses')}`),
      tile(t('finance.net'), amount(summary.netMinor), `${t('finance.ledgerIncome')}: ${amount(summary.incomeLedgerMinor)}`),
    ]);
  }

  function tile(label, value, hint) {
    return h('div', { class: 'card stat' }, [
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value),
      hint ? h('div', { class: 'delta muted' }, hint) : null,
    ]);
  }

  function render(summary, trends, incomes, expenses) {
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [
          h('h2', {}, t('finance.title')),
          h('p', { class: 'muted small' }, `${date(summary.range?.from ?? range.from)} → ${date(summary.range?.to ?? range.to)}`),
        ]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: () => setRange(startOfMonth(), today()) }, t('common.thisMonth')),
        h('button', { type: 'button', class: 'ghost', onclick: () => setRange(addDays(today(), -6), today()) }, t('common.thisWeek')),
        h('button', { type: 'button', class: 'ghost', onclick: () => setRange(`${today().slice(0, 4)}-01-01`, today()) }, t('common.thisYear')),
        can('reports.export') ? h('button', {
          type: 'button',
          class: 'ghost',
          onclick: () => exportReport('profit', range).then(() => toast({ message: t('reports.exported'), tone: 'ok' })).catch((error) => toast({ message: error.message, tone: 'error' })),
        }, t('finance.exportLedger')) : null,
      ]),
      tiles(summary),
      tabs([
        { key: 'summary', label: t('reports.summaryOnly') },
        { key: 'income', label: t('finance.income') },
        { key: 'expense', label: t('finance.expenses') },
        { key: 'categories', label: t('finance.categories') },
      ], tab, (key) => {
        tab = key;
        mount(host, render(summary, trends, incomes, expenses));
      }),
      body(tab, summary, trends, incomes, expenses),
    ];
  }

  function categoryLabel(row) {
    return state.locale === 'bn' ? row.categoryNameBn ?? row.categoryName : row.categoryName;
  }

  function body(current, summary, trends, incomes, expenses) {
    switch (current) {
      case 'income':
        return card({
          title: `${t('finance.income')} · ${amount(summary.incomeLedgerMinor)}`,
          actions: can('finance.manage') ? [h('button', { type: 'button', class: 'primary', onclick: () => ledgerForm('income') }, t('finance.addIncome'))] : null,
          body: (incomes?.rows ?? []).length
            ? table([
              { key: 'incomeDate', label: 'common.date', date: true },
              { key: 'categoryNameBn', label: 'finance.category', render: categoryLabel },
              { key: 'patientName', label: 'patients.fullName' },
              { key: 'description', label: 'common.description' },
              { key: 'amountMinor', label: 'common.amount', money: true, num: true },
              { key: 'methodCode', label: 'payments.method' },
              { key: 'referenceNo', label: 'finance.reference' },
              { key: 'createdBy', label: 'common.createdBy' },
              {
                label: 'common.actions',
                className: 'actions',
                render: (row) => can('finance.manage') && !row.isAuto ? h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => confirmAction({
                    t,
                    title: t('common.deleteConfirm'),
                    message: `${categoryLabel(row)} ${amount(row.amountMinor)}`,
                    danger: true,
                    run: () => api.del(`/api/finance/incomes/${row.id}`, { reason: t('common.deleteConfirm') }),
                    onDone: load,
                  }),
                }, t('common.delete')) : h('span', { class: 'muted small' }, row.isAuto ? t('finance.autoIncome') : ''),
              },
            ], incomes.rows, { t })
            : emptyState(t('common.noResults'), t('finance.incomeHint')),
        });
      case 'expense':
        return card({
          title: `${t('finance.expenses')} · ${amount(summary.expensesMinor)}`,
          actions: can('finance.manage') ? [h('button', { type: 'button', class: 'primary', onclick: () => ledgerForm('expense') }, t('finance.addExpense'))] : null,
          body: (expenses?.rows ?? []).length
            ? table([
              { key: 'expenseDate', label: 'common.date', date: true },
              { key: 'categoryName', label: 'finance.category' },
              { key: 'payee', label: 'finance.payee' },
              { key: 'supplierName', label: 'finance.supplier' },
              { key: 'description', label: 'common.description' },
              { key: 'amountMinor', label: 'common.amount', money: true, num: true },
              { key: 'methodCode', label: 'payments.method' },
              { key: 'recurrence', label: 'finance.recurring' },
              {
                label: 'common.actions',
                className: 'actions',
                render: (row) => can('finance.manage') ? h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => confirmAction({
                    t,
                    title: t('common.deleteConfirm'),
                    message: `${row.categoryName ?? ''} ${amount(row.amountMinor)}`,
                    danger: true,
                    run: () => api.del(`/api/finance/expenses/${row.id}`, { reason: t('common.deleteConfirm') }),
                    onDone: load,
                  }),
                }, t('common.delete')) : null,
              },
            ], expenses.rows, { t })
            : emptyState(t('common.noResults'), t('finance.expenseHint')),
        });
      case 'categories':
        return h('div', { class: 'two-col' }, [
          card({
            title: t('finance.incomeCategories'),
            actions: can('finance.manage') ? [h('button', { type: 'button', class: 'link', onclick: () => categoryForm('income') }, t('common.add'))] : null,
            body: table([
              { key: 'nameEn', label: 'finance.category', render: (row) => (state.locale === 'bn' ? row.nameBn ?? row.nameEn : row.nameEn) },
              { key: 'isActive', label: 'common.status', render: (row) => statusPill(row.isActive ? 'active' : 'inactive', t) },
              {
                label: 'common.actions',
                className: 'actions',
                render: (row) => can('finance.manage') && !row.isSystem ? h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => confirmAction({
                    t,
                    title: t('common.deleteConfirm'),
                    message: row.nameEn,
                    danger: true,
                    run: () => api.del(`/api/finance/income-categories/${row.id}`),
                    onDone: load,
                  }),
                }, t('common.delete')) : null,
              },
            ], incomeCategories, { t }),
          }),
          card({
            title: t('finance.expenseCategories'),
            actions: can('finance.manage') ? [h('button', { type: 'button', class: 'link', onclick: () => categoryForm('expense') }, t('common.add'))] : null,
            body: table([
              { key: 'nameEn', label: 'finance.category', render: (row) => (state.locale === 'bn' ? row.nameBn ?? row.nameEn : row.nameEn) },
              { key: 'isActive', label: 'common.status', render: (row) => statusPill(row.isActive ? 'active' : 'inactive', t) },
              {
                label: 'common.actions',
                className: 'actions',
                render: (row) => can('finance.manage') && !row.isSystem ? h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => confirmAction({
                    t,
                    title: t('common.deleteConfirm'),
                    message: row.nameEn,
                    danger: true,
                    run: () => api.del(`/api/finance/expense-categories/${row.id}`),
                    onDone: load,
                  }),
                }, t('common.delete')) : null,
              },
            ], expenseCategories, { t }),
          }),
        ]);
      default:
        return h('div', { class: 'stack' }, [
          h('div', { class: 'two-col' }, [
            card({
              title: t('finance.byService'),
              body: bars((trends?.revenueByService ?? []).map((row) => ({ label: row.name ?? '—', value: Number(row.amountMinor ?? 0), hint: localizeDigits(row.count ?? 0) })), { money: true, t }),
            }),
            card({
              title: t('finance.monthlyTrend'),
              body: bars((trends?.monthly ?? []).filter((row) => row.month).map((row) => ({ label: monthName(row.month, { short: true }), value: Number(row.incomeMinor ?? 0) })), { money: true, t }),
            }),
          ]),
          h('div', { class: 'two-col' }, [
            card({
              title: t('finance.dailyCollection'),
              body: bars((trends?.daily ?? []).slice(-10).map((row) => ({ label: date(row.date), value: Number(row.incomeMinor ?? 0) })), { money: true, t }),
            }),
            card({
              title: t('finance.grossIncome'),
              body: kv([
                [t('finance.invoiced'), amount(summary.invoicedMinor)],
                [t('finance.collected'), amount(summary.collectedMinor)],
                [t('finance.cashCollected'), amount(summary.cashCollectedMinor)],
                [t('finance.ledgerIncome'), amount(summary.incomeLedgerMinor)],
                [t('finance.refunds'), amount(summary.refundedMinor)],
                [t('finance.expenses'), amount(summary.expensesMinor)],
                [t('finance.outstanding'), amount(summary.outstandingMinor)],
                [t('finance.net'), amount(summary.netMinor)],
              ]),
            }),
          ]),
        ]);
    }
  }

  function ledgerForm(kind) {
    const isIncome = kind === 'income';
    const categories = isIncome ? incomeCategories : expenseCategories;
    formModal({
      t,
      title: isIncome ? t('finance.addIncome') : t('finance.addExpense'),
      columns: 2,
      fields: [
        { name: isIncome ? 'income_date' : 'expense_date', label: 'common.date', type: 'date', required: true },
        { name: 'amount_minor', label: 'common.amount', type: 'money', required: true },
        { name: 'category_id', label: 'finance.category', type: 'select', numericValues: true, options: [{ value: '', label: 'finance.uncategorised' }, ...categories.map((row) => ({ value: row.id, label: state.locale === 'bn' ? row.nameBn ?? row.nameEn : row.nameEn }))] },
        { name: 'method_code', label: 'payments.method', type: 'select', options: METHODS },
        ...(isIncome
          ? [{ name: 'source', label: 'finance.source', type: 'select', options: [
            { value: 'other', label: 'finance.sourceOther' },
            { value: 'consultation', label: 'finance.sourceConsultation' },
          ] }]
          : [{ name: 'payee', label: 'finance.payee' }]),
        { name: 'reference_no', label: 'finance.reference' },
        ...(isIncome
          ? []
          : [
            { name: 'is_recurring', label: 'finance.recurring', type: 'checkbox' },
            { name: 'recurrence', label: 'finance.recurrenceFreq', type: 'select', options: [
              { value: '', label: 'common.none' },
              { value: 'monthly', label: 'finance.monthly' },
              { value: 'quarterly', label: 'finance.quarterly' },
              { value: 'yearly', label: 'finance.yearly' },
            ] },
          ]),
        { name: 'description', label: 'common.description', span: 2 },
        { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
      ],
      values: { [isIncome ? 'income_date' : 'expense_date']: today(), method_code: 'cash' },
      submit: (values) => api.post(`/api/finance/${isIncome ? 'incomes' : 'expenses'}`, values),
      onSaved: load,
    });
  }

  function categoryForm(kind) {
    formModal({
      t,
      title: t('finance.newCategory'),
      columns: 1,
      fields: [
        { name: 'name_en', label: 'finance.categoryEn', required: true },
        { name: 'name_bn', label: 'finance.categoryBn' },
      ],
      submit: (values) => api.post(`/api/finance/${kind === 'income' ? 'income-categories' : 'expense-categories'}`, values),
      onSaved: load,
    });
  }

  load();
  return () => {};
}
