/**
 * System: reports, settings, users & roles, audit log, backup/restore,
 * notifications and About.
 */
import { api, exportReport, saveBase64File } from '../core/api.js';
import { can, reloadSettings, state } from '../core/store.js';
import { bars, enumLabel, form as buildForm, h, mount, openModal, statusPill, table, toast } from '../core/dom.js';
import { addDays, amount, date, dateTime, localizeDigits, money, startOfMonth, today } from '../core/format.js';
import { navigate } from '../core/router.js';
import { setPageTitle } from '../main.js';
import { card, confirmAction, emptyState, errorState, formModal, kv, listScreen, loading, recordLayout, tabs } from './ui.js';
import { patientPicker } from './scheduling.js';

const RANGES = [
  { key: 'today', label: 'reports.rangeToday', from: () => today(), to: () => today() },
  { key: 'yesterday', label: 'reports.rangeYesterday', from: () => addDays(today(), -1), to: () => addDays(today(), -1) },
  { key: 'this_week', label: 'reports.rangeWeek', from: () => addDays(today(), -6), to: () => today() },
  { key: 'this_month', label: 'reports.rangeMonth', from: () => startOfMonth(), to: () => today() },
  { key: 'this_year', label: 'reports.rangeYear', from: () => `${today().slice(0, 4)}-01-01`, to: () => today() },
];

/* ------------------------------------------------------------------ reports */

export function reportsScreen({ t, query }) {
  setPageTitle('nav.reports');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let rangeKey = query?.get('range') ?? 'this_month';

  async function load() {
    mount(host, loading(t));
    try {
      const payload = await api.get('/api/reports');
      mount(host, render(payload?.rows ?? []));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render(reports) {
    const range = RANGES.find((item) => item.key === rangeKey) ?? RANGES[3];
    const categories = [...new Set(reports.map((report) => report.category))];
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [h('h2', {}, t('reports.title')), h('p', { class: 'muted small' }, t('reports.subtitle'))]),
        h('span', { class: 'spacer' }),
        h('select', {
          onchange: (event) => { rangeKey = event.target.value; mount(host, render(reports)); },
        }, RANGES.map((item) => h('option', { value: item.key, selected: item.key === rangeKey ? true : undefined }, t(item.label)))),
      ]),
      ...categories.map((category) => card({
        title: enumLabel('reports.category', category, t),
        body: h('div', { class: 'grid-3' }, reports.filter((report) => report.category === category).map((report) => h('button', {
          type: 'button',
          class: 'tile',
          onclick: () => navigate(`/reports/${report.key}?range=${range.key}`),
        }, [
          h('div', { class: 'strong' }, t(report.titleKey)),
          h('div', { class: 'small muted' }, t(report.descriptionKey)),
        ]))),
      })),
    ];
  }

  load();
  return () => {};
}

export function reportRunScreen({ t, key, query }) {
  setPageTitle('nav.reports');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let rangeKey = query?.get('range') ?? 'this_month';
  let custom = { from: query?.get('from') ?? '', to: query?.get('to') ?? '' };
  let report = null;

  const range = () => {
    if (custom.from && custom.to) return { from: custom.from, to: custom.to };
    const preset = RANGES.find((item) => item.key === rangeKey) ?? RANGES[3];
    return { from: preset.from(), to: preset.to() };
  };

  async function load() {
    mount(host, loading(t));
    try {
      report = await api.get('/api/reports/run', { key, ...range() });
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render() {
    const columns = report.columns ?? [];
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [
          h('h2', {}, t(`reports.${key}.title`) === `reports.${key}.title` ? key : t(`reports.${key}.title`)),
          h('p', { class: 'muted small' }, `${date(report.range.from)} → ${date(report.range.to)} · ${localizeDigits(report.rows.length)} ${t('reports.rowCount')}`),
        ]),
        h('span', { class: 'spacer' }),
        h('select', { onchange: (event) => { rangeKey = event.target.value; custom = { from: '', to: '' }; load(); } },
          RANGES.map((item) => h('option', { value: item.key, selected: item.key === rangeKey && !custom.from ? true : undefined }, t(item.label)))),
        h('input', { type: 'date', value: custom.from, onchange: (event) => { custom.from = event.target.value; load(); } }),
        h('input', { type: 'date', value: custom.to, onchange: (event) => { custom.to = event.target.value; load(); } }),
        h('button', { type: 'button', class: 'ghost', onclick: () => window.print() }, t('common.print')),
        can('reports.export') ? h('button', {
          type: 'button',
          class: 'primary',
          onclick: () => exportReport(key, range())
            .then(() => toast({ message: t('reports.exported'), tone: 'ok' }))
            .catch((error) => toast({ message: error.message, tone: 'error' })),
        }, t('reports.exportCsv')) : null,
        h('button', { type: 'button', class: 'ghost', onclick: () => navigate('/reports') }, t('common.back')),
      ]),
      report.totals ? h('div', { class: 'cards' }, Object.entries(report.totals).map(([name, value]) => h('div', { class: 'card stat' }, [
        h('div', { class: 'label' }, enumLabel('reports.totals', name, t)),
        h('div', { class: 'value' }, /minor$/.test(name) ? amount(value) : localizeDigits(value)),
      ]))) : null,
      card({
        t,
        body: report.rows.length
          ? table(columns.map((column) => ({
            key: column.key,
            label: column.labelKey,
            money: column.money,
            num: column.money || column.numeric,
            date: /_date$|_on$/.test(column.key),
          })), report.rows.slice(0, 500), { t })
          : emptyState(t('reports.noData'), t('reports.noDataHint')),
      }),
      report.rows.length > 500 ? h('p', { class: 'help' }, t('reports.truncated', { count: localizeDigits(report.rows.length) })) : null,
    ];
  }

  load();
  return () => {};
}

/* ----------------------------------------------------------------- settings */

export function settingsScreen({ t, query }) {
  setPageTitle('nav.settings');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let catalogue = [];
  let values = state.settings ?? {};
  let activeGroup = query?.get('group') ?? null;
  const dirty = new Map();

  async function load() {
    mount(host, loading(t));
    try {
      const payload = await api.get('/api/settings');
      catalogue = payload?.catalogue ?? [];
      values = payload?.values ?? payload ?? {};
      if (!activeGroup) activeGroup = catalogue[0]?.group ?? null;
      mount(host, render());
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  const label = (item) => t(item.labelKey) === item.labelKey ? item.key : t(item.labelKey);

  function control(item) {
    const current = dirty.has(item.key) ? dirty.get(item.key) : values[item.key] ?? item.default;
    const onChange = (value) => { dirty.set(item.key, value); };
    switch (item.type) {
      case 'boolean':
        return h('label', { class: 'checkbox' }, [h('input', {
          type: 'checkbox',
          checked: Boolean(current),
          onchange: (event) => onChange(event.target.checked),
        }), h('span', {}, current ? t('common.yes') : t('common.no'))]);
      case 'enum':
        return h('select', { onchange: (event) => onChange(event.target.value) },
          (item.values ?? []).map((value) => h('option', {
            value: typeof value === 'object' ? value.value : value,
            selected: String(typeof value === 'object' ? value.value : value) === String(current ?? '') ? true : undefined,
          }, typeof value === 'object' ? t(value.labelKey ?? value.label ?? '') : value)));
      case 'number':
      case 'int':
        return h('input', {
          type: 'number',
          min: item.min,
          max: item.max,
          value: current ?? '',
          oninput: (event) => onChange(Number(event.target.value)),
        });
      case 'text':
        return h('input', { type: 'text', value: current ?? '', oninput: (event) => onChange(event.target.value) });
      default:
        return h('input', { type: 'text', value: current ?? '', oninput: (event) => onChange(event.target.value) });
    }
  }

  function render() {
    const groups = catalogue.map((group) => group.group);
    const group = catalogue.find((entry) => entry.group === activeGroup) ?? catalogue[0];
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [h('h2', {}, t('settings.title')), h('p', { class: 'muted small' }, t('settings.subtitle'))]),
        h('span', { class: 'spacer' }),
        dirty.size ? h('button', { type: 'button', class: 'ghost', onclick: resetGroup }, t('settings.resetGroup')) : null,
        h('button', { type: 'button', class: 'primary', disabled: !dirty.size || !can('settings.manage'), onclick: save }, `${t('common.save')}${dirty.size ? ` (${dirty.size})` : ''}`),
      ]),
      h('div', { class: 'settings-layout' }, [
        h('nav', { class: 'settings-nav' }, groups.map((name) => h('button', {
          type: 'button',
          class: `settings-tab ${name === group?.group ? 'active' : ''}`.trim(),
          onclick: () => { activeGroup = name; mount(host, render()); },
        }, t(`settings.group.${name}`) === `settings.group.${name}` ? name : t(`settings.group.${name}`)))),
        card({
          t,
          title: group ? (t(`settings.group.${group.group}`) === `settings.group.${group.group}` ? group.group : t(`settings.group.${group.group}`)) : '',
          body: h('div', { class: 'settings-rows' }, (group?.items ?? []).map((item) => h('div', { class: 'settings-row' }, [
            h('div', { class: 'settings-label' }, [
              h('div', { class: 'strong' }, label(item)),
              item.helpKey ? h('p', { class: 'small muted' }, t(item.helpKey)) : null,
              h('code', { class: 'small muted' }, item.key),
            ]),
            h('div', { class: 'settings-control' }, control(item)),
          ]))),
        }),
      ]),
    ];
  }

  function resetGroup() {
    for (const key of [...dirty.keys()]) {
      const item = (catalogue.find((group) => group.items.some((entry) => entry.key === key))?.items ?? []).find((entry) => entry.key === key);
      if (item && item.group === activeGroup) dirty.delete(key);
    }
    mount(host, render());
  }

  async function save() {
    if (!dirty.size) return;
    const patch = { settings: Object.fromEntries(dirty) };
    try {
      await api.put('/api/settings', patch);
      dirty.clear();
      await reloadSettings();
      toast({ message: t('settings.savedMessage'), tone: 'ok' });
      load();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  load();
  return () => {};
}

/* -------------------------------------------------------------------- users */

export function usersScreen({ t, query }) {
  setPageTitle('nav.users');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let tab = query?.get('tab') === 'roles' ? 'roles' : 'users';

  async function load() {
    mount(host, loading(t));
    try {
      const [users, roles] = await Promise.all([
        api.get('/api/users'),
        api.get('/api/roles'),
      ]);
      mount(host, render(users?.rows ?? [], roles));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render(users, rolesPayload) {
    const roleRows = rolesPayload?.rows ?? rolesPayload?.roles ?? [];
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [h('h2', {}, t('users.title')), h('p', { class: 'muted small' }, t('users.subtitle'))]),
        h('span', { class: 'spacer' }),
        can('users.manage') && tab === 'users' ? h('button', { type: 'button', class: 'primary', onclick: () => userForm(null, roleRows, load, t) }, t('users.new')) : null,
        can('users.manage') && tab === 'roles' ? h('button', { type: 'button', class: 'primary', onclick: () => roleForm(null, load, t) }, t('roles.new')) : null,
      ]),
      tabs([
        { key: 'users', label: t('users.title') },
        { key: 'roles', label: t('roles.title') },
      ], tab, (key) => { tab = key; mount(host, render(users, rolesPayload)); }),
      tab === 'users' ? usersTable(users, roleRows) : rolesTable(roleRows),
    ];
  }

  function usersTable(users, roleRows) {
    return card({
      t,
      body: table([
        { key: 'username', label: 'users.username', render: (row) => h('div', {}, [h('div', { class: 'strong' }, row.displayName), h('div', { class: 'small muted' }, row.username)]) },
        { key: 'roleName', label: 'users.role', render: (row) => h('span', { class: 'pill' }, row.roleLabel ?? row.roleName) },
        { key: 'staffName', label: 'nav.staff' },
        { key: 'status', label: 'common.status', render: (row) => statusPill(row.status, t) },
        { key: 'hasPin', label: 'users.pin', render: (row) => (row.hasPin ? '✓' : '—') },
        { key: 'lastLoginAt', label: 'users.lastLogin', render: (row) => (row.lastLoginAt ? dateTime(row.lastLoginAt) : t('users.never')) },
        {
          label: 'common.actions',
          className: 'actions',
          render: (row) => h('div', { class: 'row-actions' }, [
            can('users.manage') ? h('button', { type: 'button', class: 'link', onclick: () => userForm(row, roleRows, load, t) }, t('common.edit')) : null,
            can('users.manage') ? h('button', { type: 'button', class: 'link', onclick: () => passwordForm(row, load, t) }, t('users.resetPassword')) : null,
            can('users.manage') ? h('button', { type: 'button', class: 'link', onclick: () => permissionsForm(row, load, t) }, t('users.permissions')) : null,
            can('users.manage') && row.status === 'active' ? h('button', {
              type: 'button',
              class: 'link',
              onclick: () => confirmAction({
                t,
                title: t('common.deactivate'),
                message: row.displayName,
                danger: true,
                run: () => api.del(`/api/users/${row.id}`, { reason: t('users.deactivatedReason') }),
                onDone: load,
              }),
            }, t('common.deactivate')) : null,
          ]),
        },
      ], users, { t }),
    });
  }

  function rolesTable(roles) {
    return card({
      t,
      body: table([
        { key: 'name', label: 'roles.title', render: (row) => h('div', {}, [h('div', { class: 'strong' }, row.label ?? row.name), h('div', { class: 'small muted' }, row.description ?? '')]) },
        { key: 'isSystem', label: 'roles.system', render: (row) => (row.isSystem ? t('common.yes') : t('common.no')) },
        { key: 'userCount', label: 'users.title', render: (row) => localizeDigits(row.userCount ?? 0), num: true },
        { key: 'permissionCount', label: 'roles.permissions', render: (row) => localizeDigits((row.permissions ?? []).length), num: true },
        {
          label: 'common.actions',
          className: 'actions',
          render: (row) => can('users.manage') ? h('button', { type: 'button', class: 'link', onclick: () => roleForm(row, load, t) }, t('common.edit')) : null,
        },
      ], roles, { t }),
    });
  }

  load();
  return () => {};
}

function userForm(user, roles, reload, t) {
  formModal({
    t,
    title: user ? t('users.editTitle') : t('users.new'),
    wide: true,
    columns: 2,
    fields: [
      { name: 'username', label: 'users.username', required: !user },
      { name: 'display_name', label: 'users.displayName', required: true },
      { name: 'role_id', label: 'users.role', type: 'select', numericValues: true, required: true, options: roles.map((role) => ({ value: role.id, label: role.label ?? role.name })) },
      { name: 'status', label: 'common.status', type: 'select', options: [
        { value: 'active', label: 'status.active' },
        { value: 'inactive', label: 'status.inactive' },
        { value: 'locked', label: 'status.locked' },
      ] },
      { name: 'pin', label: 'users.pin', type: 'password', hint: 'users.pinHint' },
      { name: 'password', label: 'users.password', type: 'password', hint: 'auth.passwordHint' },
      { name: 'email', label: 'common.email', type: 'email' },
      { name: 'phone', label: 'common.phone', type: 'tel' },
    ],
    values: user ? {
      username: user.username,
      display_name: user.displayName,
      role_id: user.roleId,
      status: user.status,
      email: user.email,
      phone: user.phone,
    } : { status: 'active' },
    submit: (values) => (user ? api.put(`/api/users/${user.id}`, values) : api.post('/api/users', values)),
    onSaved: reload,
  });
}

function passwordForm(user, reload, t) {
  formModal({
    t,
    title: `${t('users.resetPassword')} · ${user.displayName}`,
    columns: 1,
    fields: [
      { name: 'password', label: 'users.newPassword', type: 'password', required: true, hint: 'auth.passwordHint' },
      { name: 'must_change', label: 'users.mustChange', type: 'checkbox' },
    ],
    values: { must_change: true },
    submit: (values) => api.post(`/api/users/${user.id}/password`, values),
    onSaved: reload,
  });
}

function permissionsForm(user, reload, t) {
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('common.loading')));
  const selected = new Set();
  const modal = openModal({
    title: `${t('users.permissions')} · ${user.displayName}`,
    wide: true,
    body: host,
    footer: [
      h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
      h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
    ],
  });

  api.get('/api/roles/catalogue').then((payload) => {
    const groups = payload?.groups ?? [];
    mount(host, groups.map((group) => h('div', { class: 'stack' }, [
      h('h4', {}, enumLabel('permissions', group.module, t)),
      h('div', { class: 'tag-list' }, (group.permissions ?? []).map((permission) => h('label', { class: 'checkbox' }, [
        h('input', {
          type: 'checkbox',
          value: permission.code,
          checked: (user.permissions ?? []).includes(permission.code),
          onchange: (event) => {
            if (event.target.checked) selected.add(permission.code);
            else selected.delete(permission.code);
          },
        }),
        h('span', {}, state.locale === 'bn' ? permission.label_bn : permission.label_en),
      ]))),
    ])));
  }).catch((error) => mount(host, h('div', { class: 'alert' }, error.message)));

  async function save() {
    try {
      const extra = [...selected];
      await api.put(`/api/users/${user.id}/permissions`, { permissions: extra });
      modal.close();
      toast({ message: t('common.saved'), tone: 'ok' });
      reload();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }
}

function roleForm(role, reload, t) {
  const selected = new Set(role?.permissions ?? []);
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted small' }, t('common.loading')));
  const nameInput = h('input', { type: 'text', value: role?.label ?? role?.name ?? '' });
  const descInput = h('input', { type: 'text', value: role?.description ?? '' });
  const modal = openModal({
    title: role ? t('roles.title') : t('roles.new'),
    wide: true,
    body: h('div', { class: 'stack' }, [
      h('label', {}, [h('span', {}, t('roles.title')), nameInput]),
      h('label', {}, [h('span', {}, t('common.description')), descInput]),
      host,
    ]),
    footer: [
      h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
      h('button', { type: 'button', class: 'primary', onclick: save }, t('common.save')),
    ],
  });

  api.get('/api/roles/catalogue').then((payload) => {
    mount(host, (payload?.groups ?? []).map((group) => h('div', { class: 'stack' }, [
      h('h4', {}, enumLabel('permissions', group.module, t)),
      h('div', { class: 'tag-list' }, (group.permissions ?? []).map((permission) => h('label', { class: 'checkbox' }, [
        h('input', {
          type: 'checkbox',
          value: permission.code,
          checked: selected.has(permission.code),
          disabled: role?.isSystem && role?.name === 'owner',
          onchange: (event) => {
            if (event.target.checked) selected.add(permission.code);
            else selected.delete(permission.code);
          },
        }),
        h('span', {}, state.locale === 'bn' ? permission.label_bn : permission.label_en),
      ]))),
    ])));
  }).catch((error) => mount(host, h('div', { class: 'alert' }, error.message)));

  async function save() {
    const payload = {
      name: role?.name ?? String(nameInput.value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      label: nameInput.value,
      description: descInput.value,
      permissions: [...selected],
    };
    try {
      if (role) await api.put(`/api/roles/${role.id}`, payload);
      else await api.post('/api/roles', payload);
      modal.close();
      toast({ message: t('common.saved'), tone: 'ok' });
      reload();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }
}

/* -------------------------------------------------------------------- audit */

export function auditScreen({ t, query }) {
  setPageTitle('nav.audit');
  const screen = listScreen({
    t,
    title: t('audit.title'),
    subtitle: t('audit.subtitle'),
    endpoint: '/api/audit',
    pageSize: 50,
    filters: [
      { name: 'module', options: [
        { value: '', label: 'common.all' },
        { value: 'auth', label: 'audit.moduleAuth' },
        { value: 'patients', label: 'nav.patients' },
        { value: 'clinical', label: 'nav.clinical' },
        { value: 'billing', label: 'nav.billing' },
        { value: 'users', label: 'nav.users' },
        { value: 'settings', label: 'nav.settings' },
        { value: 'backup', label: 'nav.backup' },
      ] },
      { name: 'severity', options: [
        { value: '', label: 'common.all' },
        { value: 'info', label: 'severity.info' },
        { value: 'warning', label: 'severity.warning' },
        { value: 'critical', label: 'severity.critical' },
      ] },
      { name: 'from', options: [
        { value: '', label: 'common.allTime' },
        { value: today(), label: 'reports.rangeToday' },
        { value: addDays(today(), -6), label: 'reports.rangeWeek' },
        { value: startOfMonth(), label: 'reports.rangeMonth' },
      ] },
    ],
    actions: can('audit.export') ? [h('button', {
      type: 'button',
      class: 'ghost',
      onclick: () => exportReport('audit', { from: startOfMonth(), to: today() })
        .then(() => toast({ message: t('reports.exported'), tone: 'ok' }))
        .catch((error) => toast({ message: error.message, tone: 'error' })),
    }, t('reports.exportCsv'))] : [],
    columns: [
      { key: 'createdAt', label: 'audit.when', render: (row) => dateTime(row.createdAt), width: '160px' },
      { key: 'userName', label: 'users.title' },
      { key: 'module', label: 'audit.module', render: (row) => h('span', { class: 'pill' }, row.module ?? '—') },
      { key: 'action', label: 'audit.action', render: (row) => enumLabel('audit.action', row.action, t) },
      { key: 'entity', label: 'audit.entity' },
      { key: 'summary', label: 'audit.summary' },
      { key: 'severity', label: 'audit.severity', render: (row) => h('span', { class: `pill ${row.severity === 'critical' ? 'danger' : row.severity === 'warning' ? 'warn' : ''}`.trim() }, enumLabel('severity', row.severity, t)) },
      { key: 'ip', label: 'audit.ip' },
    ],
  });

  return screen.element;
}

/* ------------------------------------------------------------------- backup */

export function backupScreen({ t }) {
  setPageTitle('nav.backup');
  const host = h('div', { class: 'stack' });
  mount('#view', host);

  async function load() {
    mount(host, loading(t));
    try {
      const [payload, schedule] = await Promise.all([
        api.get('/api/backup/list'),
        api.get('/api/backup/schedule').catch(() => null),
      ]);
      mount(host, render(payload?.rows ?? [], schedule));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render(backups, schedule) {
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [h('h2', {}, t('backup.title')), h('p', { class: 'muted small' }, t('backup.subtitle'))]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: load }, t('common.refresh')),
        can('backup.create') ? h('button', { type: 'button', class: 'primary', onclick: createBackup }, t('backup.create')) : null,
        can('backup.create') ? h('button', { type: 'button', class: 'ghost', onclick: exportData }, t('backup.export')) : null,
        can('backup.restore') ? h('button', { type: 'button', class: 'ghost', onclick: importPatients }, t('backup.importPatients')) : null,
      ]),
      card({
        t,
        title: t('backup.list'),
        body: backups.length
          ? table([
            { key: 'fileName', label: 'backup.file' },
            { key: 'createdAt', label: 'common.created', render: (row) => dateTime(row.createdAt) },
            { key: 'sizeBytes', label: 'attachments.size', render: (row) => `${Math.max(1, Math.round((row.sizeBytes ?? 0) / 1024))} KB`, num: true },
            { key: 'schemaVersion', label: 'backup.schema', num: true },
            {
              label: 'common.actions',
              className: 'actions',
              render: (row) => h('div', { class: 'row-actions' }, [
                can('backup.create') ? h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => api.post('/api/backup/verify', { path: row.path }).then((result) => toast({
                    message: result?.ok ? t('backup.verifyOk') : t('backup.verificationFailed'),
                    tone: result?.ok ? 'ok' : 'error',
                  })).catch((error) => toast({ message: error.message, tone: 'error' })),
                }, t('backup.verify')) : null,
                can('backup.restore') ? h('button', {
                  type: 'button',
                  class: 'link',
                  onclick: () => restore(row, t, load),
                }, t('backup.restore')) : null,
              ]),
            },
          ], backups, { t })
          : emptyState(t('backup.none'), t('backup.retentionNote')),
      }),
      schedule
        ? card({
          t,
          title: t('backup.schedule'),
          body: h('dl', { class: 'definition-list' }, [
            h('dt', {}, t('backup.scheduleMode')),
            h('dd', {}, schedule.enabled ? t(`settings.backup.frequency.${schedule.frequency}`) : t('common.disabled')),
            h('dt', {}, t('backup.scheduleNext')),
            h('dd', {}, schedule.nextRunAt ? dateTime(schedule.nextRunAt) : '—'),
            h('dt', {}, t('backup.scheduleLast')),
            h('dd', {}, schedule.lastRunAt ? dateTime(schedule.lastRunAt) : t('backup.scheduleNever')),
            h('dt', {}, t('backup.retentionLabel')),
            h('dd', {}, `${localizeDigits(schedule.retentionCount)} · ${t('backup.retentionNote')}`),
          ]),
        })
        : null,
      card({
        t,
        title: t('backup.guidance'),
        body: h('ul', { class: 'notes-list' }, [
          h('li', {}, t('backup.guidanceOffline')),
          h('li', {}, t('backup.guidanceRestore')),
          h('li', {}, t('backup.guidanceImport')),
        ]),
      }),
    ];
  }

  async function createBackup() {
    try {
      const result = await api.post('/api/backup/create', { note: '' });
      toast({ message: `${t('backup.created')}: ${result?.fileName ?? ''}`, tone: 'ok' });
      load();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  async function exportData() {
    try {
      const result = await api.post('/api/backup/export', {});
      if (result?.content) saveBase64File(result.fileName ?? 'dentiva-export.zip', result.mimeType ?? 'application/zip', result.content);
      else toast({ message: result?.path ?? t('backup.exported'), tone: 'ok' });
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  }

  function restore(row, tLocal, reload) {
    formModal({
      t: tLocal,
      title: tLocal('backup.restore'),
      columns: 1,
      note: tLocal('backup.restoreWarning'),
      fields: [
        { name: 'path', label: 'backup.file', readonly: true },
        { name: 'confirm', label: 'backup.confirmRestore', required: true },
      ],
      values: { path: row.path },
      submit: (values) => api.post('/api/backup/restore', { path: row.path, confirm: values.confirm }),
      onSaved: () => { toast({ message: tLocal('backup.restartHint'), tone: 'warn' }); reload(); },
    });
  }

  function importPatients() {
    const fileInput = h('input', { type: 'file', accept: '.csv,text/csv' });
    const dryRun = h('input', { type: 'checkbox', checked: true });
    const preview = h('div', { class: 'stack' });
    const modal = openModal({
      title: t('backup.importPatients'),
      wide: true,
      body: h('div', { class: 'stack' }, [
        h('p', { class: 'help' }, t('backup.importHint')),
        h('label', {}, [h('span', {}, t('backup.csvFile')), fileInput]),
        h('label', { class: 'checkbox' }, [dryRun, h('span', {}, t('backup.dryRun'))]),
        preview,
      ]),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
        h('button', { type: 'button', class: 'primary', onclick: run }, t('backup.importRun')),
      ],
    });

    async function run() {
      const file = fileInput.files?.[0];
      if (!file) return toast({ message: t('common.chooseFile'), tone: 'warn' });
      const data = new FormData();
      data.set('file', file);
      data.set('dryRun', dryRun.checked ? 'true' : 'false');
      try {
        const result = await api.upload('/api/backup/import/patients/csv', data);
        mount(preview, [
          h('div', { class: 'alert' }, `${t('backup.imported')}: ${localizeDigits(result?.imported ?? 0)} · ${t('backup.skipped')}: ${localizeDigits(result?.skipped ?? 0)} · ${t('backup.failed')}: ${localizeDigits((result?.errors ?? []).length)}`),
          (result?.errors ?? []).slice(0, 10).map((error) => h('div', { class: 'small muted' }, `${error.row ?? ''}: ${error.message ?? error.key ?? ''}`)),
        ]);
        if (!dryRun.checked) load();
      } catch (error) {
        toast({ message: error.message, tone: 'error' });
      }
    }
  }

  load();
  return () => {};
}

/* ----------------------------------------------------------- notifications */

export function notificationsScreen({ t }) {
  setPageTitle('nav.notifications');
  const host = h('div', { class: 'stack' });
  mount('#view', host);
  let tab = 'inbox';

  async function load() {
    mount(host, loading(t));
    try {
      const [list, preferences] = await Promise.all([
        api.get('/api/notifications', { pageSize: 50 }),
        api.get('/api/notifications/preferences'),
      ]);
      mount(host, render(list, preferences?.rows ?? []));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function message(row) {
    const title = t(row.titleKey ?? '', row.titleParams ?? {});
    const body = t(row.bodyKey ?? '', row.bodyParams ?? {});
    return {
      title: title === row.titleKey ? (row.title ?? row.titleKey) : title,
      body: body === row.bodyKey ? (row.body ?? '') : body,
    };
  }

  function render(payload, preferences) {
    const rows = payload?.rows ?? [];
    return [
      h('div', { class: 'toolbar' }, [
        h('div', {}, [
          h('h2', {}, t('notifications.title')),
          h('p', { class: 'muted small' }, `${t('notifications.unreadCount')}: ${localizeDigits(payload?.unread ?? 0)}`),
        ]),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'ghost', onclick: () => api.post('/api/notifications/refresh', {}).then(load) }, t('common.refresh')),
        h('button', { type: 'button', class: 'ghost', onclick: () => api.post('/api/notifications/read-all', {}).then(load) }, t('notifications.markAllRead')),
      ]),
      tabs([
        { key: 'inbox', label: t('notifications.inbox') },
        { key: 'settings', label: t('nav.settings') },
      ], tab, (key) => { tab = key; mount(host, render(payload, preferences)); }),
      tab === 'settings'
        ? card({
          t,
          title: t('notifications.preferences'),
          body: table([
            { key: 'label', label: 'common.type', render: (row) => t(row.labelKey) === row.labelKey ? row.kind : t(row.labelKey) },
            { key: 'enabled', label: 'common.enabled', render: (row) => h('input', {
              type: 'checkbox',
              checked: Boolean(row.enabled),
              onchange: (event) => api.put(`/api/notifications/preferences/${row.kind}`, { enabled: event.target.checked })
                .then(() => toast({ message: t('common.saved'), tone: 'ok' }))
                .catch((error) => toast({ message: error.message, tone: 'error' })),
            }) },
            { key: 'inApp', label: 'notifications.inApp' },
            { key: 'severity', label: 'audit.severity' },
          ], preferences, { t }),
        })
        : card({
          t,
          body: rows.length
            ? h('div', { class: 'stack' }, rows.map((row) => {
              const text = message(row);
              return h('div', { class: `notification-row ${row.isRead ? '' : 'unread'} severity-${row.severity ?? 'info'}`.trim() }, [
                h('div', {}, [
                  h('div', { class: 'strong' }, text.title),
                  text.body ? h('div', { class: 'small muted' }, text.body) : null,
                  h('div', { class: 'small muted' }, dateTime(row.createdAt)),
                ]),
                h('div', { class: 'row-actions' }, [
                  row.isRead
                    ? h('button', { type: 'button', class: 'link', onclick: () => api.post(`/api/notifications/${row.id}/unread`, {}).then(load) }, t('notifications.markUnread'))
                    : h('button', { type: 'button', class: 'link', onclick: () => api.post(`/api/notifications/${row.id}/read`, {}).then(load) }, t('notifications.markRead')),
                  h('button', { type: 'button', class: 'link', onclick: () => api.post(`/api/notifications/${row.id}/dismiss`, {}).then(load) }, t('common.dismiss')),
                ]),
              ]);
            }))
            : emptyState(t('notifications.empty'), t('notifications.emptyHint')),
        }),
    ];
  }

  load();
  return () => {};
}

/* -------------------------------------------------------------------- about */

export function aboutScreen({ t }) {
  setPageTitle('nav.about');
  const host = h('div', { class: 'stack' });
  mount('#view', host);

  async function load() {
    mount(host, loading(t));
    try {
      mount(host, render(await api.get('/api/about')));
    } catch (error) {
      mount(host, errorState(error, t, load));
    }
  }

  function render(about) {
    return [
      h('div', { class: 'card about-hero' }, h('div', { class: 'card-body stack' }, [
        h('h1', {}, about?.name ?? 'DENTIVA'),
        h('p', { class: 'muted' }, t('about.tagline')),
        h('div', { class: 'tag-list' }, [
          h('span', { class: 'pill accent' }, `${t('about.version')} ${about?.version ?? ''}`),
          h('span', { class: 'pill' }, `${t('about.build')} ${about?.build ?? ''}`),
          h('span', { class: 'pill' }, `${t('about.schema')} ${about?.schemaVersion ?? ''}`),
        ]),
      ])),
      h('div', { class: 'two-col' }, [
        card({
          t,
          title: t('about.credits'),
          body: kv([
            [t('about.publisher'), about?.publisher],
            [t('about.contact'), about?.contact],
            [t('about.whatsapp'), about?.whatsapp],
            [t('about.license'), about?.licensed ? t('about.licensedTo', { name: about.licensed }) : t('about.singleClinic')],
          ]),
        }),
        card({
          t,
          title: t('about.runtime'),
          body: kv([
            [t('about.runtime'), about?.runtime],
            [t('about.dataFolder'), about?.dataDir],
            [t('about.database'), about?.database],
          ]),
        }),
      ]),
      h('div', { class: 'two-col' }, [
        card({
          t,
          title: t('about.privacyTitle'),
          body: h('ul', { class: 'notes-list' }, [
            h('li', {}, t('about.privacyOffline')),
            h('li', {}, t('about.privacyTelemetry')),
            h('li', {}, t('about.privacyData')),
          ]),
        }),
        card({
          t,
          title: t('about.thirdParty'),
          body: h('ul', { class: 'notes-list' }, [
            h('li', {}, t('about.licenseBun')),
            h('li', {}, t('about.licenseFonts')),
            h('li', {}, t('about.licenseSqlite')),
            h('li', {}, t('about.licenseReport')),
          ]),
        }),
      ]),
      card({
        t,
        title: t('about.support'),
        body: h('div', { class: 'stack' }, [
          h('p', {}, t('about.supportHint')),
          h('div', { class: 'row-actions' }, [
            h('button', {
              type: 'button',
              class: 'ghost',
              onclick: () => exportReport('audit', { from: startOfMonth(), to: today() }).catch(() => {}),
            }, t('about.diagnostics')),
          ]),
        ]),
      }),
    ];
  }

  load();
  return () => {};
}

export { bars, money, patientPicker, recordLayout, buildForm };
