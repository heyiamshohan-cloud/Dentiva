/**
 * Operations: staff, payroll, inventory and suppliers.
 */
import { api } from '../core/api.js';
import { can, state } from '../core/store.js';
import { enumLabel, form as buildForm, h, mount, openModal, statusPill, table, toast } from '../core/dom.js';
import { amount, date, dateTime, localizeDigits, qty, qtyToMilli, today } from '../core/format.js';
import { navigate } from '../core/router.js';
import { setPageTitle } from '../main.js';
import { printDocument } from '../core/print.js';
import { card, confirmAction, emptyState, errorState, formModal, kv, listScreen, loading, recordLayout, tabs } from './ui.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/* -------------------------------------------------------------------- staff */

export function staffScreen({ t, query }) {
  setPageTitle('nav.staff');

  const create = () => formModal({
    t,
    title: t('staff.new'),
    wide: true,
    columns: 2,
    fields: [
      { name: 'full_name', label: 'patients.fullName', required: true, span: 2 },
      { name: 'designation', label: 'staff.designation' },
      { name: 'role_title', label: 'staff.roleTitle', type: 'select', options: ['dentist', 'receptionist', 'accountant', 'assistant', 'other'].map((value) => ({ value, label: `staff.role.${value}` })) },
      { name: 'specialty', label: 'staff.specialty' },
      { name: 'qualification', label: 'staff.qualification' },
      { name: 'registration_no', label: 'staff.registrationNo' },
      { name: 'phone', label: 'common.phone', type: 'tel' },
      { name: 'email', label: 'common.email', type: 'email' },
      { name: 'joining_date', label: 'staff.joiningDate', type: 'date' },
      { name: 'salary_minor', label: 'staff.salary', type: 'money' },
      { name: 'salary_type', label: 'staff.salaryType', type: 'select', options: [
        { value: 'monthly', label: 'staff.salary.monthly' },
        { value: 'weekly', label: 'staff.salary.weekly' },
        { value: 'daily', label: 'staff.salary.daily' },
        { value: 'per_visit', label: 'staff.salary.per_visit' },
      ] },
      { name: 'is_practitioner', label: 'staff.practitioner', type: 'checkbox' },
      { name: 'color', label: 'common.color', type: 'color' },
      { name: 'address', label: 'common.address', span: 2 },
      { name: 'responsibilities', label: 'staff.responsibilities', type: 'textarea', span: 2 },
      { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
    ],
    values: { joining_date: today(), salary_type: 'monthly', is_practitioner: false, color: '#0f6f9a' },
    submit: (values) => api.post('/api/staff', values),
    onSaved: () => screen.reload(),
  });

  const screen = listScreen({
    t,
    title: t('nav.staff'),
    subtitle: t('staff.subtitle'),
    endpoint: '/api/staff',
    query: { role: query?.get('role') ?? undefined },
    filters: [
      { name: 'role', options: [
        { value: '', label: 'common.all' },
        { value: 'dentist', label: 'staff.role.dentist' },
        { value: 'receptionist', label: 'staff.role.receptionist' },
        { value: 'accountant', label: 'staff.role.accountant' },
        { value: 'assistant', label: 'staff.role.assistant' },
      ] },
      { name: 'status', options: [
        { value: '', label: 'common.all' },
        { value: 'active', label: 'common.active' },
        { value: 'inactive', label: 'common.inactive' },
      ] },
    ],
    onCreate: can('staff.manage') ? create : null,
    createLabel: t('staff.new'),
    onRowClick: (row) => navigate(`/staff/${row.id}`),
    columns: [
      { key: 'staffCode', label: 'staff.code', width: '90px' },
      { key: 'fullName', label: 'patients.fullName', render: (row) => h('div', { class: 'row-actions' }, [
        h('span', { class: 'dot', style: { background: row.color ?? 'var(--line)' } }),
        h('div', {}, [
          h('div', { class: 'strong' }, row.fullName),
          h('div', { class: 'small muted' }, row.designation ?? ''),
        ]),
      ]) },
      { key: 'roleTitle', label: 'staff.roleTitle', render: (row) => h('span', { class: 'pill' }, enumLabel('staff.role', row.roleTitle, t)) },
      { key: 'specialty', label: 'staff.specialty' },
      { key: 'phone', label: 'common.phone' },
      { key: 'username', label: 'users.username' },
      { key: 'salaryMinor', label: 'staff.salary', money: true, num: true },
      { key: 'isPractitioner', label: 'staff.practitioner', render: (row) => (row.isPractitioner ? '✓' : '—') },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
    ],
  });
  return screen.element;
}

export function staffDetailScreen({ t, id }) {
  const host = h('div', { class: 'stack' });
  setPageTitle('nav.staff');
  let member = null;
  let payroll = null;
  let workload = null;

  const load = async () => {
    mount('#view', host);
    mount(host, loading(t));
    try {
      [member, payroll, workload] = await Promise.all([
        api.get(`/api/staff/${id}`),
        api.get('/api/payroll', { staffId: id, pageSize: 12 }),
        api.get('/api/staff/workload', { staffId: id }),
      ]);
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  };

  function render() {
    const stats = workload?.rows?.[0] ?? {};
    return recordLayout({
      t,
      title: member.fullName,
      subtitle: [member.designation, member.specialty].filter(Boolean).join(' · '),
      meta: h('div', { class: 'tag-list', style: { marginTop: '6px' } }, [
        h('span', { class: 'pill' }, member.staffCode),
        statusPill(member.status, t),
        member.isPractitioner ? h('span', { class: 'pill accent' }, t('staff.practitioner')) : null,
      ]),
      actions: [
        can('staff.manage') ? h('button', { type: 'button', class: 'ghost', onclick: editMember }, t('common.edit')) : null,
        can('payroll.manage') ? h('button', { type: 'button', class: 'primary', onclick: () => navigate(`/payroll?staffId=${member.id}`) }, t('payroll.new')) : null,
        can('staff.manage') && member.status === 'active' ? h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => confirmAction({
            t,
            title: t('common.archive'),
            message: member.fullName,
            danger: true,
            confirmLabel: t('common.archive'),
            run: () => api.del(`/api/staff/${member.id}`, { reason: t('staff.archivedReason') }),
            onDone: load,
          }),
        }, t('common.archive')) : null,
      ],
      body: h('div', { class: 'two-col' }, [
        h('div', { class: 'stack' }, [
          card({
            title: t('common.details'),
            body: kv([
              [t('staff.roleTitle'), enumLabel('staff.role', member.roleTitle, t)],
              [t('staff.specialty'), member.specialty],
              [t('staff.qualification'), member.qualification],
              [t('staff.registrationNo'), member.registrationNo],
              [t('common.phone'), member.phone],
              [t('common.email'), member.email],
              [t('common.address'), member.address],
              [t('staff.joiningDate'), member.joiningDate ? date(member.joiningDate) : null],
              [t('staff.leavingDate'), member.leavingDate ? date(member.leavingDate) : null],
              [t('staff.salary'), `${amount(member.salaryMinor)} (${enumLabel('staff.salary', member.salaryType, t)})`],
              [t('users.username'), member.username],
              [t('staff.responsibilities'), member.responsibilities],
              [t('common.notes'), member.notes],
            ]),
          }),
        ]),
        h('div', { class: 'stack' }, [
          card({
            title: t('staff.workload'),
            body: kv([
              [t('patients.visitsCount'), localizeDigits(stats.visits ?? 0)],
              [t('nav.appointments'), localizeDigits(stats.appointments ?? 0)],
              [t('patients.treatmentsCount'), localizeDigits(stats.treatments ?? 0)],
            ]),
          }),
          card({
            title: t('nav.payroll'),
            actions: [h('button', { type: 'button', class: 'link', onclick: () => navigate(`/payroll?staffId=${member.id}`) }, t('dashboard.viewAll'))],
            body: (payroll?.rows ?? []).length
              ? table([
                { key: 'periodStart', label: 'payroll.period', render: (row) => `${date(row.periodStart)} – ${date(row.periodEnd)}` },
                { key: 'netMinor', label: 'payroll.net', money: true, num: true },
                { key: 'paidMinor', label: 'common.paid', money: true, num: true },
                { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
              ], payroll.rows.slice(0, 8), { t })
              : h('p', { class: 'muted small' }, t('common.emptyHint')),
          }),
        ]),
      ]),
    });
  }

  function editMember() {
    formModal({
      t,
      title: t('staff.editTitle'),
      wide: true,
      columns: 2,
      fields: [
        { name: 'full_name', label: 'patients.fullName', required: true, span: 2 },
        { name: 'designation', label: 'staff.designation' },
        { name: 'role_title', label: 'staff.roleTitle' },
        { name: 'specialty', label: 'staff.specialty' },
        { name: 'qualification', label: 'staff.qualification' },
        { name: 'registration_no', label: 'staff.registrationNo' },
        { name: 'phone', label: 'common.phone', type: 'tel' },
        { name: 'email', label: 'common.email', type: 'email' },
        { name: 'salary_minor', label: 'staff.salary', type: 'money' },
        { name: 'salary_type', label: 'staff.salaryType' },
        { name: 'is_practitioner', label: 'staff.practitioner', type: 'checkbox' },
        { name: 'color', label: 'common.color', type: 'color' },
        { name: 'status', label: 'common.status', type: 'select', options: [
          { value: 'active', label: 'common.active' },
          { value: 'inactive', label: 'common.inactive' },
        ] },
        { name: 'address', label: 'common.address', span: 2 },
        { name: 'responsibilities', label: 'staff.responsibilities', type: 'textarea', span: 2 },
      ],
      values: {
        full_name: member.fullName,
        designation: member.designation,
        role_title: member.roleTitle,
        specialty: member.specialty,
        qualification: member.qualification,
        registration_no: member.registrationNo,
        phone: member.phone,
        email: member.email,
        salary_minor: member.salaryMinor,
        salary_type: member.salaryType,
        is_practitioner: member.isPractitioner,
        color: member.color,
        status: member.status,
        address: member.address,
        responsibilities: member.responsibilities,
      },
      submit: (values) => api.put(`/api/staff/${member.id}`, values),
      onSaved: load,
    });
  }

  load();
  return () => {};
}

/* ------------------------------------------------------------------ payroll */

export function payrollScreen({ t, query }) {
  setPageTitle('nav.payroll');
  const staffId = query?.get('staffId');

  const create = async () => {
    const staffRows = (await api.get('/api/staff', { status: 'active', pageSize: 200 }).catch(() => ({ rows: [] })))?.rows ?? [];
    formModal({
      t,
      title: t('payroll.new'),
      wide: true,
      columns: 2,
      fields: [
        { name: 'staff_id', label: 'nav.staff', type: 'select', numericValues: true, required: true, options: staffRows.map((row) => ({ value: row.id, label: `${row.fullName} · ${row.staffCode}` })) },
        { name: 'period_start', label: 'payroll.periodStart', type: 'date', required: true },
        { name: 'period_end', label: 'payroll.periodEnd', type: 'date', required: true },
        { name: 'gross_minor', label: 'payroll.gross', type: 'money', required: true },
        { name: 'deduction_minor', label: 'payroll.deductions', type: 'money' },
        { name: 'method_code', label: 'payments.method', type: 'select', options: [
          { value: 'cash', label: 'payments.cash' },
          { value: 'bank', label: 'payments.bank' },
          { value: 'mfs', label: 'payments.mfs' },
        ] },
        { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
      ],
      values: { period_start: `${today().slice(0, 7)}-01`, period_end: today(), deduction_minor: 0, method_code: 'cash' },
      submit: (values) => api.post('/api/payroll', values),
      onSaved: () => screen.reload(),
    });
  };

  const draftRun = async () => {
    const period = `${today().slice(0, 7)}-01`;
    confirmAction({
      t,
      title: t('payroll.draftRun'),
      message: t('payroll.draftRunHint'),
      run: () => api.post('/api/payroll/draft-run', { period_start: period, period_end: today() }),
      onDone: () => screen.reload(),
    });
  };

  const screen = listScreen({
    t,
    title: t('nav.payroll'),
    subtitle: t('payroll.subtitle'),
    endpoint: '/api/payroll',
    query: { staffId: staffId ?? undefined },
    filters: [
      { name: 'status', options: [
        { value: '', label: 'common.all' },
        { value: 'draft', label: 'status.draft' },
        { value: 'approved', label: 'status.approved' },
        { value: 'paid', label: 'status.paid' },
      ] },
    ],
    onCreate: can('payroll.manage') ? create : null,
    createLabel: t('payroll.new'),
    actions: can('payroll.manage') ? [h('button', { type: 'button', class: 'ghost', onclick: draftRun }, t('payroll.draftRun'))] : [],
    columns: [
      { key: 'staffName', label: 'nav.staff', render: (row) => h('div', {}, [h('div', { class: 'strong' }, row.staffName), h('div', { class: 'small muted' }, row.staffCode ?? '')]) },
      { key: 'periodStart', label: 'payroll.period', render: (row) => `${date(row.periodStart)} – ${date(row.periodEnd)}` },
      { key: 'grossMinor', label: 'payroll.gross', money: true, num: true },
      { key: 'deductionMinor', label: 'payroll.deductions', money: true, num: true },
      { key: 'netMinor', label: 'payroll.net', money: true, num: true },
      { key: 'paidMinor', label: 'common.paid', money: true, num: true },
      { key: 'dueMinor', label: 'common.due', money: true, num: true },
      { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
      {
        label: 'common.actions',
        className: 'actions',
        render: (row) => h('div', { class: 'row-actions' }, [
          h('button', { type: 'button', class: 'link', onclick: () => printDocument('payslip', row.id, { t }) }, t('payroll.payslip')),
          can('payroll.manage') && row.status !== 'paid' ? h('button', {
            type: 'button',
            class: 'link',
            onclick: () => payRow(row, screen.reload, t),
          }, t('payroll.pay')) : null,
        ]),
      },
    ],
  });
  return screen.element;
}

function payRow(row, reload, t) {
  formModal({
    t,
    title: `${t('payroll.pay')} · ${row.staffName}`,
    columns: 1,
    fields: [
      { name: 'amount_minor', label: 'payroll.payAmount', type: 'money', required: true },
      { name: 'paid_on', label: 'payroll.paidOn', type: 'date', required: true },
      { name: 'method_code', label: 'payments.method', type: 'select', options: [
        { value: 'cash', label: 'payments.cash' },
        { value: 'bank', label: 'payments.bank' },
        { value: 'mfs', label: 'payments.mfs' },
      ] },
      { name: 'notes', label: 'common.notes' },
    ],
    values: { amount_minor: row.dueMinor ?? row.netMinor, paid_on: today(), method_code: 'cash' },
    submit: (values) => api.post(`/api/payroll/${row.id}/pay`, values),
    onSaved: reload,
  });
}

/* ---------------------------------------------------------------- inventory */

export function inventoryScreen({ t, query }) {
  setPageTitle('nav.inventory');
  let tab = query?.get('tab') ?? 'items';
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let categories = [];
  let suppliers = [];

  async function load() {
    mount(host, loading(t));
    try {
      const [items, report, movements, cats, supplierRows] = await Promise.all([
        api.get('/api/inventory', { pageSize: 50, lowStock: query?.get('lowStock') ?? undefined }),
        api.get('/api/inventory/report'),
        api.get('/api/inventory/movements', { pageSize: 50 }),
        api.get('/api/inventory/categories', { includeInactive: true }),
        api.get('/api/suppliers', { pageSize: 200 }),
      ]);
      categories = cats?.rows ?? [];
      suppliers = supplierRows?.rows ?? [];
      mount(host, render(items, report, movements));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render(items, report, movements) {
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [h('h2', {}, t('inventory.title')), h('p', { class: 'muted small' }, t('inventory.subtitle'))]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: load }, t('common.refresh')),
        can('inventory.manage') ? h('button', { type: 'button', class: 'primary', onclick: () => itemForm(null, categories, suppliers, load, t) }, t('inventory.new')) : null,
      ]),
      h('div', { class: 'cards' }, [
        h('div', { class: 'card stat' }, [h('div', { class: 'label' }, t('inventory.items')), h('div', { class: 'value' }, localizeDigits(items.total ?? 0))]),
        h('div', { class: 'card stat' }, [h('div', { class: 'label' }, t('inventory.stockValue')), h('div', { class: 'value' }, amount(items.stockValueMinor ?? 0))]),
        h('div', { class: 'card stat accent' }, [h('div', { class: 'label' }, t('inventory.lowStock')), h('div', { class: 'value' }, localizeDigits(items.lowStockCount ?? 0))]),
        h('div', { class: 'card stat' }, [h('div', { class: 'label' }, t('inventory.expiringSoon')), h('div', { class: 'value' }, localizeDigits((report?.expiring ?? []).length))]),
      ]),
      tabs([
        { key: 'items', label: t('inventory.items') },
        { key: 'low', label: t('inventory.lowStock') },
        { key: 'expiring', label: t('inventory.expiringSoon') },
        { key: 'movements', label: t('inventory.movements') },
        { key: 'categories', label: t('inventory.categories') },
      ], tab, (key) => {
        tab = key;
        mount(host, render(items, report, movements));
      }),
      body(tab, items, report, movements),
    ];
  }

  function itemRow(item, reload) {
    return h('div', { class: 'row-actions' }, [
      h('button', { type: 'button', class: 'link', onclick: () => adjustForm(item, 'in', reload, t) }, t('inventory.stockIn')),
      h('button', { type: 'button', class: 'link', onclick: () => adjustForm(item, 'out', reload, t) }, t('inventory.stockOut')),
      can('inventory.manage') ? h('button', { type: 'button', class: 'link', onclick: () => itemForm(item, categories, suppliers, reload, t) }, t('common.edit')) : null,
    ]);
  }

  function itemColumns(reload) {
    return [
      { key: 'name', label: 'inventory.item', render: (row) => h('div', {}, [
        h('div', { class: 'strong' }, row.name),
        h('div', { class: 'small muted' }, [row.sku, row.batchNo ? `${t('inventory.batch')} ${row.batchNo}` : null].filter(Boolean).join(' · ')),
      ]) },
      { key: 'categoryName', label: 'inventory.category' },
      { key: 'quantity', label: 'inventory.quantity', render: (row) => `${qty(row.quantityMilli)} ${row.unit ?? ''}`, num: true },
      { key: 'minStockMilli', label: 'inventory.minStock', render: (row) => qty(row.minStockMilli), num: true },
      { key: 'expiryDate', label: 'inventory.expiry', date: true },
      { key: 'supplierName', label: 'nav.suppliers' },
      { key: 'purchasePriceMinor', label: 'inventory.purchasePrice', money: true, num: true },
      { key: 'salePriceMinor', label: 'inventory.salePrice', money: true, num: true },
      { key: 'stockValueMinor', label: 'inventory.stockValue', money: true, num: true },
      { key: 'condition', label: 'common.status', render: (row) => h('span', { class: `pill ${row.isOutOfStock ? 'danger' : row.isLowStock ? 'warn' : ''}`.trim() }, row.isOutOfStock ? t('inventory.outOfStock') : row.isLowStock ? t('inventory.lowStock') : row.condition) },
      { label: 'common.actions', className: 'actions', render: (row) => itemRow(row, reload) },
    ];
  }

  function body(current, items, report, movements) {
    switch (current) {
      case 'low':
        return card({ title: t('inventory.lowStock'), body: table(itemColumns(load), report?.lowStock ?? [], { t }) });
      case 'expiring':
        return card({
          title: t('inventory.expiringSoon'),
          body: (report?.expiring ?? []).length
            ? table([
              { key: 'name', label: 'inventory.item' },
              { key: 'batchNo', label: 'inventory.batch' },
              { key: 'expiryDate', label: 'inventory.expiry', date: true },
              { key: 'quantity', label: 'inventory.quantity', render: (row) => qty(row.quantityMilli), num: true },
              { key: 'daysToExpiry', label: 'inventory.daysLeft', num: true },
            ], report.expiring, { t })
            : emptyState(t('common.noResults'), t('inventory.expiryHint')),
        });
      case 'movements':
        return card({
          title: t('inventory.movements'),
          body: (movements?.rows ?? []).length
            ? table([
              { key: 'date', label: 'common.date', date: true },
              { key: 'itemName', label: 'inventory.item' },
              { key: 'kind', label: 'common.type', render: (row) => h('span', { class: 'pill' }, enumLabel('inventory.kind', row.kind, t)) },
              { key: 'quantityMilli', label: 'inventory.quantity', render: (row) => `${qty(row.quantityMilli)} ${row.unit ?? ''}`, num: true },
              { key: 'balanceAfterMilli', label: 'inventory.balance', render: (row) => qty(row.balanceAfterMilli), num: true },
              { key: 'reason', label: 'common.reason' },
              { key: 'referenceNo', label: 'finance.reference' },
              { key: 'patientName', label: 'patients.fullName' },
              { key: 'createdBy', label: 'common.createdBy' },
            ], movements.rows, { t })
            : emptyState(t('common.noResults'), t('inventory.movementsHint')),
        });
      case 'categories':
        return card({
          title: t('inventory.categories'),
          actions: can('inventory.manage') ? [h('button', { type: 'button', class: 'link', onclick: () => categoryForm(load, t) }, t('common.add'))] : null,
          body: table([
            { key: 'nameEn', label: 'finance.categoryEn', render: (row) => (state.locale === 'bn' ? row.nameBn ?? row.nameEn : row.nameEn) },
            { key: 'isActive', label: 'common.status', render: (row) => statusPill(row.isActive ? 'active' : 'inactive', t) },
          ], categories, { t }),
        });
      default:
        return card({ title: t('inventory.items'), body: table(itemColumns(load), items?.rows ?? [], { t }) });
    }
  }

  load();
  return () => {};
}

export function itemForm(item, categories, suppliers, reload, t) {
  formModal({
    t,
    title: item ? t('inventory.editTitle') : t('inventory.new'),
    wide: true,
    columns: 2,
    fields: [
      { name: 'name', label: 'inventory.item', required: true, span: 2 },
      { name: 'sku', label: 'inventory.sku' },
      { name: 'category_id', label: 'inventory.category', type: 'select', numericValues: true, options: [{ value: '', label: 'common.none' }, ...categories.map((row) => ({ value: row.id, label: state.locale === 'bn' ? row.nameBn ?? row.nameEn : row.nameEn }))] },
      { name: 'unit', label: 'inventory.unit' },
      { name: 'quantity_milli', label: 'inventory.quantity', type: 'qty' },
      { name: 'min_stock_milli', label: 'inventory.minStock', type: 'qty' },
      { name: 'purchase_price_minor', label: 'inventory.purchasePrice', type: 'money' },
      { name: 'sale_price_minor', label: 'inventory.salePrice', type: 'money' },
      { name: 'supplier_id', label: 'nav.suppliers', type: 'select', numericValues: true, options: [{ value: '', label: 'common.none' }, ...suppliers.map((row) => ({ value: row.id, label: row.name }))] },
      { name: 'batch_no', label: 'inventory.batch' },
      { name: 'expiry_date', label: 'inventory.expiry', type: 'date' },
      { name: 'storage_location', label: 'inventory.storage' },
      { name: 'condition', label: 'inventory.condition', type: 'select', options: ['sealed', 'opened', 'expired', 'damaged', 'returned'].map((value) => ({ value, label: `inventory.condition.${value}` })) },
      { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
    ],
    values: item ? {
      name: item.name,
      sku: item.sku,
      category_id: item.categoryId,
      unit: item.unit,
      quantity_milli: item.quantityMilli,
      min_stock_milli: item.minStockMilli,
      purchase_price_minor: item.purchasePriceMinor,
      sale_price_minor: item.salePriceMinor,
      supplier_id: item.supplierId,
      batch_no: item.batchNo,
      expiry_date: item.expiryDate,
      storage_location: item.storageLocation,
      condition: item.condition,
    } : { unit: 'piece', quantity_milli: 0, min_stock_milli: 0, condition: 'sealed' },
    submit: (values) => (item ? api.put(`/api/inventory/${item.id}`, values) : api.post('/api/inventory', values)),
    onSaved: reload,
  });
}

function adjustForm(item, kind, reload, t) {
  formModal({
    t,
    title: `${kind === 'in' ? t('inventory.stockIn') : t('inventory.stockOut')} · ${item.name}`,
    columns: 1,
    fields: [
      { name: 'quantity_milli', label: 'inventory.quantity', type: 'qty', required: true },
      { name: 'movement_date', label: 'common.date', type: 'date' },
      { name: 'unit_cost_minor', label: 'inventory.unitCost', type: 'money' },
      { name: 'reference_no', label: 'finance.reference' },
      { name: 'reason', label: 'common.reason' },
    ],
    values: { movement_date: today(), quantity_milli: 1000 },
    submit: (values) => api.post('/api/inventory/movements', {
      item_id: item.id,
      kind: kind === 'in' ? 'in' : 'out',
      ...values,
    }),
    onSaved: reload,
  });
}

function categoryForm(reload, t) {
  formModal({
    t,
    title: t('inventory.newCategory'),
    columns: 1,
    fields: [
      { name: 'name_en', label: 'finance.categoryEn', required: true },
      { name: 'name_bn', label: 'finance.categoryBn' },
    ],
    submit: (values) => api.post('/api/inventory/categories', values),
    onSaved: reload,
  });
}

/* ---------------------------------------------------------------- suppliers */

export function suppliersScreen({ t, query }) {
  setPageTitle('nav.suppliers');
  const initialSearch = query?.get('q') ?? '';

  const create = () => supplierForm(null, () => screen.reload(), t);

  const screen = listScreen({
    t,
    title: t('nav.suppliers'),
    subtitle: t('suppliers.subtitle'),
    endpoint: '/api/suppliers',
    query: initialSearch ? { q: initialSearch } : {},
    onCreate: can('suppliers.manage') ? create : null,
    createLabel: t('suppliers.new'),
    columns: [
      { key: 'name', label: 'suppliers.name' },
      { key: 'contactPerson', label: 'suppliers.contactPerson' },
      { key: 'phone', label: 'common.phone' },
      { key: 'email', label: 'common.email' },
      { key: 'products', label: 'suppliers.products' },
      { key: 'paymentTerms', label: 'suppliers.paymentTerms' },
      { key: 'itemCount', label: 'inventory.items', num: true },
      {
        label: 'common.actions',
        className: 'actions',
        render: (row) => h('div', { class: 'row-actions' }, [
          can('suppliers.manage') ? h('button', { type: 'button', class: 'link', onclick: () => supplierForm(row, () => screen.reload(), t) }, t('common.edit')) : null,
          can('suppliers.manage') ? h('button', {
            type: 'button',
            class: 'link',
            onclick: () => confirmAction({
              t,
              title: t('common.deleteConfirm'),
              message: row.name,
              danger: true,
              run: () => api.del(`/api/suppliers/${row.id}`),
              onDone: screen.reload,
            }),
          }, t('common.delete')) : null,
        ]),
      },
    ],
  });
  return screen.element;
}

function supplierForm(supplier, reload, t) {
  formModal({
    t,
    title: supplier ? t('suppliers.editTitle') : t('suppliers.new'),
    columns: 2,
    fields: [
      { name: 'name', label: 'suppliers.name', required: true, span: 2 },
      { name: 'contact_person', label: 'suppliers.contactPerson' },
      { name: 'phone', label: 'common.phone', type: 'tel' },
      { name: 'email', label: 'common.email', type: 'email' },
      { name: 'payment_terms', label: 'suppliers.paymentTerms' },
      { name: 'products', label: 'suppliers.products', span: 2 },
      { name: 'address', label: 'common.address', span: 2 },
      { name: 'notes', label: 'common.notes', type: 'textarea', span: 2 },
    ],
    values: supplier ? {
      name: supplier.name,
      contact_person: supplier.contactPerson,
      phone: supplier.phone,
      email: supplier.email,
      payment_terms: supplier.paymentTerms,
      products: supplier.products,
      address: supplier.address,
      notes: supplier.notes,
    } : {},
    submit: (values) => (supplier ? api.put(`/api/suppliers/${supplier.id}`, values) : api.post('/api/suppliers', values)),
    onSaved: reload,
  });
}

export { buildForm, openModal, dateTime, qtyToMilli, MONTHS, DAYS };
