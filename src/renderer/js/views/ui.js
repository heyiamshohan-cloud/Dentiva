/**
 * Shared screen scaffolding.
 *
 * `page()` frames a screen, `listScreen()` implements the standard
 * search + filter + table + pager pattern against any list endpoint, and
 * `recordScreen()` frames a single record with tabs.
 */
import { api, ApiError } from '../core/api.js';
import { h, mount, pager, table, openModal, confirmDialog, toast, form as buildForm, debounce } from '../core/dom.js';
import { money, localizeDigits } from '../core/format.js';

/**
 * @param {{ title: string, subtitle?: string, actions?: any[], body: any, t: any }} options
 */
export function page({ title, subtitle, actions, body, t }) {
  return h('div', {}, [
    h('div', { class: 'toolbar' }, [
      h('div', {}, [h('h2', {}, title), subtitle ? h('p', { class: 'muted small' }, subtitle) : null]),
      h('span', { class: 'spacer' }),
      ...(actions ?? []),
    ]),
    body,
    t ? null : null,
  ]);
}

/** @param {{ title?: any, actions?: any, body?: any, className?: any, t?: any }} options */
export function card({ title, actions, body, className = '', t }) {
  return h('section', { class: `card ${className}`.trim() }, [
    title || actions ? h('header', { class: 'card-head' }, [
      typeof title === 'string' ? h('h3', {}, title) : title,
      actions ? h('div', { class: 'row-actions' }, actions) : null,
    ]) : null,
    h('div', { class: 'card-body' }, body),
  ]);
}

/** Definition list from `[[label, value], …]`. */
export function kv(rows) {
  const items = rows.filter(Boolean);
  return h('dl', { class: 'kv' }, items.flatMap(([label, value]) => [h('dt', {}, label), h('dd', {}, value ?? '—')]));
}

/** @param {{ label?: any, value?: any, delta?: any, tone?: any }} options */
export function statCard({ label, value, delta, tone }) {
  return h('div', { class: `card stat ${tone ?? ''}`.trim() }, [
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    delta ? h('div', { class: `delta ${delta.tone ?? ''}`.trim() }, delta.text) : null,
  ]);
}

export function loading(t) {
  return h('div', { class: 'table-empty' }, t('common.loading'));
}

export function errorState(error, t, onRetry) {
  const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
  return h('div', { class: 'card' }, h('div', { class: 'card-body stack' }, [
    h('div', { class: 'alert' }, message),
    onRetry ? h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'ghost', onclick: onRetry }, t('app.retry'))) : null,
  ]));
}

export function emptyState(title, hint, action) {
  return h('div', { class: 'empty-state' }, [
    h('h3', {}, title),
    hint ? h('p', { class: 'muted' }, hint) : null,
    action ? h('div', { class: 'row-actions', style: { justifyContent: 'center' } }, action) : null,
  ]);
}

/** A `<select>` bound to the toolbar. */
export function select(name, options, value, onChange, t) {
  /** @type {any} */
  return h('select', { name, onchange: (event) => onChange(event.target.value) },
    options.map((option) => h('option', {
      value: option.value,
      selected: String(option.value) === String(value ?? '') ? true : undefined,
    }, t(option.label))));
}

/**
 * Generic list screen.
 *
 * @param {{
 *   t: any,
 *   title: string, subtitle?: string,
 *   endpoint: string,
 *   columns: any[],
 *   query?: Record<string, any>,
 *   search?: boolean,
 *   filters?: any[],
 *   actions?: any[],
 *   onCreate?: any,
 *   createLabel?: string,
 *   onRowClick?: (row: any) => void,
 *   rowClass?: (row: any) => string,
 *   empty?: string,
 *   emptyHint?: any,
 *   pageSize?: number,
 *   container?: HTMLElement,
 * }} options
 */
export function listScreen(options) {
  /** @type {any} */
  const { t, endpoint, columns } = options;
  /** @type {any} */
  const query = { page: 1, pageSize: options.pageSize ?? 25, ...(options.query ?? {}) };
  const host = h('div', { class: 'stack' });
  let serverMeta = { page: 1, pages: 1, total: 0, pageSize: query.pageSize };
  let requestToken = 0;

  const reload = async () => {
    const token = ++requestToken;
    mount(host, loading(t));
    try {
      const payload = await api.get(endpoint, query);
      if (token !== requestToken) return;
      serverMeta = { ...serverMeta, ...(payload ?? {}) };
      const rows = payload?.rows ?? payload?.items ?? (Array.isArray(payload) ? payload : []);
      mount(host, [
        rows.length
          ? h('div', { class: 'card' }, [
            table(columns, rows, { t, empty: t('common.noResults'), onRowClick: options.onRowClick, rowClass: options.rowClass }),
            pager(serverMeta, (page) => {
              query.page = page;
              reload();
            }, t),
          ])
          : options.empty ? emptyState(options.empty, options.emptyHint) : emptyState(t('common.noResults'), t('common.emptyHint')),
      ]);
    } catch (error) {
      if (token !== requestToken) return;
      mount(host, errorState(error, t, reload));
    }
  };

  const searchInput = h('input', {
    type: 'search',
    class: 'search',
    placeholder: t('common.searchPlaceholder'),
    value: query.q ?? '',
    oninput: debounce((event) => {
      query.q = event.target.value.trim() || undefined;
      query.page = 1;
      reload();
    }, 280),
  });

  const filterNodes = (options.filters ?? []).map((filter) => select(
    filter.name,
    filter.options,
    query[filter.name],
    (value) => {
      query[filter.name] = value === '' ? undefined : value;
      query.page = 1;
      reload();
    },
    t,
  ));

  const toolbar = h('div', { class: 'toolbar' }, [
    options.search === false ? null : searchInput,
    ...filterNodes,
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'ghost', onclick: reload }, t('common.refresh')),
    ...(options.actions ?? []),
    options.onCreate ? h('button', { type: 'button', class: 'primary', onclick: options.onCreate }, options.createLabel ?? t('common.new')) : null,
  ]);

  const screen = h('div', {}, [
    h('div', { class: 'toolbar' }, [
      h('div', {}, [h('h2', {}, options.title), options.subtitle ? h('p', { class: 'muted small' }, options.subtitle) : null]),
    ]),
    toolbar,
    host,
  ]);

  reload();
  return { element: screen, reload, query };
}

/** Modal wrapper for create/edit forms. */
/** @param {{ t?: any, title?: any, fields?: any, values?: any, submit?: any, submitLabel?: any, columns?: any, onSaved?: any, wide?: any, note?: any }} options */
export function formModal({ t, title, fields, values, submit, submitLabel, columns, onSaved, wide, note }) {
  const builder = buildForm(fields, t, { values, columns: columns ?? 2 });
  const errorBox = h('div', { class: 'alert hidden' });
  const modal = openModal({
    title,
    wide,
    body: h('div', { class: 'stack' }, [note ? h('p', { class: 'help' }, note) : null, errorBox, builder.form]),
    footer: [
      h('button', { type: 'button', class: 'ghost', onclick: () => modal.close() }, t('common.cancel')),
      h('button', { type: 'button', class: 'primary', onclick: save }, submitLabel ?? t('common.save')),
    ],
  });

  async function save() {
    errorBox.classList.add('hidden');
    const button = modal.panel.querySelector('.modal-foot .primary');
    button.disabled = true;
    try {
      const payload = builder.values();
      const result = await submit(payload);
      modal.close();
      toast({ message: t('common.saved'), tone: 'ok' });
      if (onSaved) onSaved(result);
    } catch (error) {
      button.disabled = false;
      if (error instanceof ApiError && Array.isArray(error.details)) builder.setErrors(error.details);
      errorBox.textContent = error.message;
      errorBox.classList.remove('hidden');
    }
  }

  return modal;
}

/** Confirmation wrapper used before destructive actions. */
/** @param {{ t?: any, title?: any, message?: any, confirmLabel?: any, danger?: any, run?: any, onDone?: any }} options */
export function confirmAction({ t, title, message, confirmLabel, danger, run, onDone }) {
  confirmDialog({ t, title, message, confirmLabel, danger }).then(async (ok) => {
    if (!ok) return;
    try {
      await run();
      toast({ message: t('common.saved'), tone: 'ok' });
      if (onDone) onDone();
    } catch (error) {
      toast({ message: error.message, tone: 'error' });
    }
  });
}

/** Tabs for record screens. */
export function tabs(items, active, onSelect) {
  return h('div', { class: 'tabs' }, items.map((item) => h('button', {
    type: 'button',
    class: `tab ${item.key === active ? 'active' : ''}`.trim(),
    onclick: () => onSelect(item.key),
  }, item.label)));
}

export function moneyCell(value) {
  return h('span', { class: 'money' }, money(value));
}

export function count(value) {
  return h('span', { class: 'money' }, localizeDigits(value));
}

/** Two column record layout used by the detail screens. */
/** @param {{ t?: any, title?: any, subtitle?: any, meta?: any, actions?: any, tabsBar?: any, body?: any }} options */
export function recordLayout({ t, title, subtitle, meta, actions, tabsBar, body }) {
  return h('div', { class: 'stack' }, [
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, [
      h('div', { class: 'profile-head' }, [
        h('div', { class: 'profile-meta' }, [
          h('h2', {}, title),
          subtitle ? h('p', { class: 'muted' }, subtitle) : null,
          meta ?? null,
        ]),
        h('div', { class: 'profile-actions' }, actions ?? []),
      ]),
      tabsBar ?? null,
    ])),
    body,
    t ? null : null,
  ]);
}
