/**
 * Tiny DOM toolkit — no framework, no build step.
 *
 * `h()` builds elements, `mount()` replaces a container's contents, `table()`
 * renders the server-paginated list contract used by every screen, and
 * `openModal()` / `confirmDialog()` / `toast()` cover the overlays.
 */
import { amount, date as fmtDate, localizeDigits, money, qty, time as fmtTime } from './format.js';

/**
 * The renderer deliberately treats built elements as `any`: a helper that
 * returns a precise DOM type would force a cast at every field access
 * (`input.value`, `button.disabled`, …) for no safety gain at runtime.
 *
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {any} [children]
 * @returns {any}
 */
export function h(tag, attrs = {}, children = []) {
  const element = /** @type {any} */ (document.createElement(tag));
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = String(value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value);
    else if (key === 'html') element.innerHTML = String(value);
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') element.value = value;
    else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

/** @param {any} parent @param {any} children */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
  return parent;
}

export function fragment(children) {
  return append(/** @type {any} */ (document.createDocumentFragment()), children);
}

/** @param {any} target @param {any} children */
export function mount(target, children) {
  const element = /** @type {any} */ (typeof target === 'string' ? document.querySelector(target) : target);
  if (!element) return null;
  element.textContent = '';
  append(element, children);
  return element;
}

export function clear(target) {
  const element = /** @type {any} */ (typeof target === 'string' ? document.querySelector(target) : target);
  if (element) element.textContent = '';
  return element;
}

/** @param {any} selector @param {any} [root] @returns {any} */
export const el = (selector, root = document) => root.querySelector(selector);
/** @param {any} selector @param {any} [root] @returns {any[]} */
export const els = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Run `fn` after the user stops typing. */
export function debounce(fn, delay = 250) {
  /** @type {any} */ let timer = 0;
  return (/** @type {any[]} */ ...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ pieces */

/** @param {string} text @param {string} [tone] */
export function pill(text, tone = '') {
  return h('span', { class: `pill ${tone}`.trim() }, text);
}

/** Humanise an unmapped enum value: `in_progress` → `In progress`. */
export function humanise(value) {
  const text = String(value ?? '').replace(/[_.]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

/**
 * Translate a namespaced enum value (`gender.male`, `status.paid`, …) and fall
 * back to a humanised raw value so a new server enum never prints a raw key.
 * @param {string} prefix @param {any} value @param {any} t
 */
export function enumLabel(prefix, value, t) {
  if (value === null || value === undefined || value === '') return '—';
  const key = `${prefix}.${value}`;
  const text = t(key);
  return text === key ? humanise(value) : text;
}

export function statusPill(status, t) {
  const tones = {
    active: 'ok', issued: 'info', paid: 'ok', completed: 'ok', present: 'ok', verified: 'ok', ok: 'ok',
    draft: 'warn', pending: 'warn', partial: 'warn', waiting: 'warn', called: 'info',
    low: 'warn', expiring: 'warn', planned: 'info', proposed: 'info', scheduled: 'info', in_progress: 'accent',
    in_treatment: 'accent', archived: 'danger', cancelled: 'danger', void: 'danger', overdue: 'danger',
    unpaid: 'danger', no_show: 'danger', missing: 'danger', locked: 'danger', disabled: 'danger', skipped: 'warn',
  };
  return pill(enumLabel('status', status, t), tones[status] ?? '');
}

/** @param {any} value */
export function bool(value, t) {
  return value ? t('misc.yes') : t('misc.no');
}

/**
 * Column spec:
 *   key          property on the row
 *   label        i18n key
 *   render(row)  custom renderer
 *   money|qty|date|time  shorthand renderers
 *   width        css width
 *   className
 */
export function table(columns, rows, { t, empty, onRowClick, rowClass } = /** @type {any} */ ({})) {
  if (!rows || rows.length === 0) {
    return h('div', { class: 'table-empty' }, empty ?? (t ? t('common.noResults') : 'No records'));
  }
  const head = h('thead', {}, h('tr', {}, columns.map((column) => h('th', {
    class: [column.num ? 'num' : '', column.className ?? ''].join(' ').trim(),
    style: column.width ? { width: column.width } : undefined,
  }, t ? t(column.label) : column.label))));

  const body = h('tbody', {}, rows.map((row) => {
    const tr = h('tr', {
      dataset: onRowClick ? { clickable: 'true' } : undefined,
      class: rowClass ? rowClass(row) : '',
      onclick: onRowClick ? (event) => {
        if (event.target.closest('button, a, input, select')) return;
        onRowClick(row);
      } : undefined,
    }, columns.map((column) => h('td', {
      class: [column.num ? 'num' : '', column.className ?? ''].join(' ').trim(),
    }, cell(column, row, t))));
    return tr;
  }));

  return h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, [head, body]));
}

function cell(column, row, t) {
  if (column.render) return column.render(row, t);
  /** @type {any} */
  const value = column.key ? row[column.key] : null;
  if (value === null || value === undefined || value === '') return t ? t('common.empty') : '—';
  if (column.money) return amount(value);
  if (column.qty) return qty(value);
  if (column.date) return fmtDate(value);
  if (column.time) return fmtTime(value);
  if (column.bool) return bool(value, t);
  if (column.localize === false) return value;
  return localizeDigits(value);
}

/** Pager for the `{total,page,pageSize,pages}` contract. */
export function pager(meta, onPage, t) {
  const page = Number(meta?.page ?? 1);
  const pages = Math.max(1, Number(meta?.pages ?? 1));
  const total = Number(meta?.total ?? 0);
  return h('div', { class: 'pager' }, [
    h('span', {}, t('common.showing', { from: total === 0 ? 0 : (page - 1) * Number(meta.pageSize ?? 25) + 1, to: Math.min(page * Number(meta.pageSize ?? 25), total), total: localizeDigits(total) })),
    h('span', { class: 'pages' }, [
      h('button', { type: 'button', disabled: page <= 1, onclick: () => onPage(1) }, '«'),
      h('button', { type: 'button', disabled: page <= 1, onclick: () => onPage(page - 1) }, '‹'),
      h('span', { class: 'muted small' }, `${localizeDigits(page)} / ${localizeDigits(pages)}`),
      h('button', { type: 'button', disabled: page >= pages, onclick: () => onPage(page + 1) }, '›'),
      h('button', { type: 'button', disabled: page >= pages, onclick: () => onPage(pages) }, '»'),
    ]),
  ]);
}

/* ------------------------------------------------------------------ fields */

/**
 * Field spec:
 *   name, label(i18n), type: text|number|money|qty|date|time|select|checkbox|textarea|password|email|tel|hidden
 *   options: [{value,label}], required, min, max, step, span, hint, placeholder, readonly, disabled
 */
export function field(spec, value, t) {
  /** @type {any} */
  const id = `f-${spec.name}-${Math.random().toString(36).slice(2, 7)}`;
  const errors = spec.errors ?? [];
  const control = (() => {
    const common = {
      name: spec.name,
      id,
      required: spec.required,
      disabled: spec.disabled,
      readonly: spec.readonly,
      placeholder: spec.placeholder ? t(spec.placeholder) : undefined,
      'aria-invalid': errors.length ? 'true' : undefined,
    };
    switch (spec.type) {
      case 'select':
        return h('select', { ...common }, (spec.options ?? []).map((option) => h('option', {
          value: option.value,
          selected: String(option.value) === String(value ?? '') ? true : undefined,
        }, t(option.label))));
      case 'checkbox':
        return h('input', { ...common, type: 'checkbox', checked: Boolean(value), class: '' });
      case 'textarea':
        return h('textarea', { ...common, rows: spec.rows ?? 3 }, value ?? '');
      case 'money':
        return h('input', { ...common, type: 'number', step: '0.01', min: '0', value: value === undefined || value === null ? '' : (Number(value) / 10 ** 2).toFixed(2) });
      case 'qty':
        return h('input', { ...common, type: 'number', step: '0.001', min: '0', value: value === undefined || value === null ? '' : (Number(value) / 1000).toFixed(3) });
      default:
        return h('input', { ...common, type: spec.type ?? 'text', value: value ?? '', min: spec.min, max: spec.max, step: spec.step });
    }
  })();

  if (spec.type === 'checkbox') {
    return h('label', { class: 'checkbox span-all' }, [control, h('span', {}, t(spec.label))]);
  }
  return h('label', { class: spec.span === 2 ? 'span-2' : spec.span === 3 ? 'span-3' : spec.span === 'all' ? 'span-all' : '' }, [
    h('span', {}, [t(spec.label), spec.required ? h('span', { class: 'muted' }, ' *') : null]),
    control,
    spec.hint ? h('p', { class: 'field-hint' }, t(spec.hint)) : null,
    errors.length ? h('p', { class: 'field-error' }, errors.map((error) => t(error.key, error.params)).join(', ')) : null,
  ]);
}

/**
 * Build a form from field specs.
 * @returns {{ form: HTMLFormElement, values: () => Record<string, any>, setErrors: (list: any[]) => void, setValues: (values: Record<string, any>) => void, focus: () => void }}
 */
export function form(specs, t, { values = {}, columns = 2 } = /** @type {any} */ ({})) {
  /** @type {any} */
  const current = { ...values };
  const errorsByField = {};
  let host;

  const renderFields = () => {
    host = h('div', { class: columns === 1 ? 'stack' : columns === 3 ? 'grid-3' : 'grid-2' }, specs
      .filter((spec) => !spec.hidden)
      .map((spec) => field({ ...spec, errors: errorsByField[spec.name] }, current[spec.name], t)));
    return host;
  };

  const formElement = /** @type {any} */ (h('form', { class: 'stack', onsubmit: (event) => event.preventDefault() }, renderFields()));
  // Re-render on validation so inline messages appear without losing layout.
  const refresh = () => {
    const next = renderFields();
    formElement.replaceChild(next, formElement.firstChild);
  };

  return {
    form: formElement,
    values() {
      /** @type {Record<string, any>} */
      const output = {};
      for (const spec of specs) {
        if (spec.readonly || spec.disabled) continue;
        const input = /** @type {HTMLInputElement} */ (formElement.querySelector(`[name="${spec.name}"]`));
        if (!input) continue;
        if (spec.type === 'checkbox') output[spec.name] = input.checked;
        else if (spec.type === 'money') output[spec.name] = Math.round(Number(input.value || 0) * 100);
        else if (spec.type === 'qty') output[spec.name] = Math.round(Number(input.value || 0) * 1000);
        else if (spec.type === 'number') output[spec.name] = input.value === '' ? null : Number(input.value);
        else if (spec.type === 'select' && spec.numericValues) output[spec.name] = input.value === '' ? null : Number(input.value);
        else output[spec.name] = input.value === '' ? null : input.value;
      }
      return output;
    },
    setValues(next) {
      Object.assign(current, next);
      refresh();
    },
    setErrors(list) {
      for (const key of Object.keys(errorsByField)) delete errorsByField[key];
      for (const error of list ?? []) {
        if (!error || !error.field) continue;
        const top = String(error.field).split('.')[0];
        (errorsByField[top] ??= []).push(error);
      }
      refresh();
    },
    focus() {
      const first = formElement.querySelector('input:not([type=hidden]), select, textarea');
      if (first) first.focus();
    },
  };
}

/* ------------------------------------------------------------------ modals */

let modalCounter = 0;

/**
 * @param {{ title: string, body: any, footer?: any, wide?: boolean, narrow?: boolean, onClose?: () => void, closable?: boolean }} options
 */
export function openModal({ title, body, footer, wide, narrow, onClose, closable = true }) {
  modalCounter += 1;
  const id = `modal-${modalCounter}`;
  const backdrop = h('div', { class: 'modal-backdrop', id });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape' && closable) close();
  };
  document.addEventListener('keydown', onKey);

  const panel = h('div', { class: `modal ${wide ? 'wide' : narrow ? 'narrow' : ''}`.trim(), role: 'dialog', 'aria-modal': 'true' }, [
    h('header', { class: 'modal-head' }, [
      h('h2', {}, title),
      closable ? h('button', { type: 'button', class: 'icon-button', onclick: close, 'aria-label': 'Close' }, '✕') : null,
    ]),
    h('div', { class: 'modal-body' }, body),
    footer ? h('footer', { class: 'modal-foot' }, footer) : null,
  ]);
  backdrop.appendChild(panel);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop && closable) close();
  });
  const modalHost = /** @type {any} */ (document.getElementById('modals'));
  modalHost.appendChild(backdrop);
  const first = /** @type {any} */ (panel.querySelector('input:not([type=hidden]), select, textarea, button'));
  if (first) first.focus();
  return { close, panel };
}

/** @param {{ title: string, message: string, confirmLabel?: string, danger?: boolean, t: any }} options */
export function confirmDialog({ title, message, confirmLabel, danger, t }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };
    const modal = openModal({
      title,
      narrow: true,
      onClose: () => done(false),
      body: h('p', {}, message),
      footer: [
        h('button', { type: 'button', class: 'ghost', onclick: () => done(false) }, t('common.cancel')),
        h('button', {
          type: 'button',
          class: danger ? 'danger' : 'primary',
          onclick: () => done(true),
        }, confirmLabel ?? t('common.confirm')),
      ],
    });
  });
}

/** @param {{ title?: string, message: string, tone?: string }} options */
export function toast({ title, message, tone = '' }) {
  const host = /** @type {any} */ (document.getElementById('toasts'));
  if (!host) return;
  const node = h('div', { class: `toast ${tone}`.trim() }, [
    title ? h('div', { class: 'toast-title' }, title) : null,
    h('div', { class: 'toast-body' }, message),
  ]);
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, tone === 'error' ? 6500 : 3800);
}

/* ------------------------------------------------------------------ charts */

/** Horizontal bar list: `[{label, value, hint}]` */
export function bars(items, { money: isMoney = false, t } = /** @type {any} */ ({})) {
  const max = Math.max(1, ...items.map((item) => Number(item.value ?? 0)));
  if (!items.length) return h('p', { class: 'muted small' }, t ? t('common.noResults') : '—');
  return h('div', { class: 'bars' }, items.map((item, index) => h('div', { class: 'bar-row' }, [
    h('span', { class: 'muted small nowrap' }, item.label),
    h('span', { class: 'bar-track' }, h('span', {
      class: `bar-fill ${index % 2 ? 'alt' : ''}`.trim(),
      style: { width: `${Math.max(2, (Number(item.value ?? 0) / max) * 100)}%` },
    })),
    h('span', { class: 'right small' }, isMoney ? money(item.value) : localizeDigits(item.value ?? 0)),
  ])));
}

/** Minimal SVG line chart for the 14-day trends. */
export function sparkline(points, { t, money: isMoney = true } = /** @type {any} */ ({})) {
  if (!points || points.length < 2) return h('p', { class: 'muted small' }, t ? t('reports.noData') : '—');
  const values = points.map((point) => Number(point.value ?? 0));
  const max = Math.max(1, ...values);
  const width = 640;
  const height = 120;
  const step = width / Math.max(1, points.length - 1);
  const coords = values.map((value, index) => [index * step, height - (value / max) * (height - 18) - 6]);
  const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const svg = `
    <svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line class="grid" x1="0" y1="${height - 6}" x2="${width}" y2="${height - 6}" />
      <path class="area" d="${area}" />
      <path class="line" d="${line}" />
      <text x="4" y="12">${escapeHtml(isMoney ? money(max) : String(max))}</text>
      <text x="${width - 84}" y="${height - 8}">${escapeHtml(points[points.length - 1].label ?? '')}</text>
    </svg>`;
  return h('div', { html: svg });
}
