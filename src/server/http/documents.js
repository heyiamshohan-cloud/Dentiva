/**
 * Printable documents (spec § 36, § 55, § 74).
 *
 * Every document is server-rendered HTML with its own print stylesheet, so the
 * browser's own print engine handles pagination, paper size (A4, Letter, thermal
 * 80 mm/58 mm) and "Save as PDF". Nothing here needs a PDF library, and Bengali
 * text renders through the same fonts as the rest of the application.
 */
import { formatDate, formatTime, formatDateLong, todayIso } from '../domain/dates.js';
import { formatAmount } from '../domain/money.js';
import { createTranslator } from '../../shared/i18n/index.js';
import { en } from '../../shared/i18n/en.js';
import { PAPER_SIZES } from '../../shared/constants.js';

/** HTML escaping for every interpolated value (no raw user data in markup). */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAPER_CSS = {
  A4: 'A4',
  A5: 'A5',
  Letter: 'letter',
  Legal: 'legal',
  Receipt80: '80mm auto',
  Receipt58: '58mm auto',
};

function money(minor, clinic, settings = {}) {
  return formatAmount(Number(minor ?? 0), {
    symbol: clinic?.currency_symbol ?? '৳',
    minorUnits: Number(clinic?.currency_minor_units ?? 2),
    locale: clinic?.locale ?? 'en',
    showSymbol: settings.showSymbol !== false,
  });
}

function number(value, clinic) {
  const text = String(Number(value ?? 0));
  return clinic?.locale === 'bn' ? text.replace(/[0-9]/g, (digit) => '০১২৩৪৫৬৭৮৯'[Number(digit)]) : text;
}

function quantity(milli) {
  const value = Number(milli ?? 0) / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function clinicBlock(clinic) {
  const lines = [clinic?.address, clinic?.city, clinic?.postal_code].filter(Boolean).join(', ');
  return `
    <div class="clinic">
      <div class="clinic-mark">${escapeHtml((clinic?.name ?? 'D').trim().slice(0, 1).toUpperCase())}</div>
      <div class="clinic-text">
        <h1>${escapeHtml(clinic?.name ?? '')}</h1>
        ${clinic?.legal_name ? `<p class="muted">${escapeHtml(clinic.legal_name)}</p>` : ''}
        ${lines ? `<p>${escapeHtml(lines)}</p>` : ''}
        <p class="muted">
          ${clinic?.phone ? `${escapeHtml(clinic.phone)}` : ''}
          ${clinic?.email ? ` · ${escapeHtml(clinic.email)}` : ''}
        </p>
        ${clinic?.tax_id ? `<p class="muted">${escapeHtml(clinic.tax_id)}</p>` : ''}
      </div>
    </div>`;
}

function patientBlock(patient, title) {
  if (!patient) return '';
  return `
    <div class="block">
      <h2>${escapeHtml(title)}</h2>
      <p class="strong">${escapeHtml(patient.full_name ?? patient.patient_name ?? '')}</p>
      <p class="muted">${escapeHtml(patient.patient_code ?? '')}${patient.phone ? ` · ${escapeHtml(patient.phone)}` : ''}</p>
      ${patient.address ? `<p class="muted">${escapeHtml(patient.address)}</p>` : ''}
      ${patient.gender ? `<p class="muted">${escapeHtml(patient.gender)}${patient.dob ? ` · ${escapeHtml(patient.dob)}` : ''}</p>` : ''}
    </div>`;
}

function metaRow(pairs) {
  return `<table class="meta"><tbody>${pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join('')}</tbody></table>`;
}

function watermark(status) {
  if (status === 'void') return `<div class="watermark">${escapeHtml(en['doc.voidWatermark'])}</div>`;
  if (status === 'draft') return `<div class="watermark draft">${escapeHtml(en['doc.draftWatermark'])}</div>`;
  return '';
}

/**
 * @param {{
 *   locale?: string, clinic: any, title: string, subtitle?: string|null, status?: string|null,
 *   body: string, paper?: string, orientation?: string, marginMm?: number, toolbar?: boolean,
 *   footerText?: string|null, footerNote?: string|null, fileName?: string, scale?: number,
 *   showSignatures?: boolean, autoPrint?: boolean,
 * }} options
 */
export function renderDocument(options) {
  const t = createTranslator(options.locale ?? 'en');
  const paper = PAPER_CSS[options.paper ?? 'A4'] ?? 'A4';
  const orientation = options.orientation === 'landscape' ? ' landscape' : '';
  const margin = Number.isFinite(options.marginMm) ? Number(options.marginMm) : 12;
  const scale = Number.isFinite(options.scale) ? Number(options.scale) / 100 : 1;
  const thermal = String(options.paper ?? '').startsWith('Receipt');
  const footer = options.footerNote ?? t('doc.pageFooter', {
    clinic: options.clinic?.name ?? '',
    phone: options.clinic?.phone ?? '',
    address: [options.clinic?.address, options.clinic?.city].filter(Boolean).join(', '),
  });

  return `<!doctype html>
<html lang="${escapeHtml(options.locale ?? 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<link rel="stylesheet" href="/fonts/fonts.css">
<style>
  :root {
    --ink: #16202b;
    --muted: #5b6b7c;
    --line: #d7e0e8;
    --accent: #0d6b63;
    --tint: #f2f7f7;
  }
  @page { size: ${paper}${orientation}; margin: ${thermal ? 4 : margin}mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #eef2f5; color: var(--ink); }
  body {
    font-family: 'Inter', 'Noto Sans Bengali', 'Segoe UI', system-ui, -apple-system, sans-serif;
    font-size: ${thermal ? '11px' : '12.5px'};
    line-height: 1.45;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .toolbar {
    position: sticky; top: 0; z-index: 5;
    display: flex; gap: 8px; align-items: center; justify-content: flex-end;
    padding: 10px 16px; background: #ffffff; border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .toolbar .hint { margin-right: auto; color: var(--muted); }
  .toolbar button {
    font: inherit; padding: 7px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--line); background: #fff; color: var(--ink);
  }
  .toolbar button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .sheet {
    background: #fff; margin: 18px auto; padding: ${thermal ? '6mm 4mm' : `${margin}mm`};
    width: ${thermal ? (String(options.paper).endsWith('58') ? '58mm' : '80mm') : paper === 'letter' ? '216mm' : paper === 'legal' ? '216mm' : paper === 'A5' ? '148mm' : '210mm'};
    min-height: 120mm;
    box-shadow: 0 10px 30px rgba(18, 38, 58, .12);
    position: relative;
    zoom: ${scale};
  }
  @media print {
    html, body { background: #fff; }
    .toolbar { display: none !important; }
    .sheet { box-shadow: none; margin: 0; width: auto; zoom: ${scale}; }
  }
  .clinic { display: flex; gap: 10px; align-items: flex-start; }
  .clinic-mark {
    width: 34px; height: 34px; border-radius: 9px; background: var(--accent); color: #fff;
    display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 17px;
  }
  .clinic-text h1 { font-size: ${thermal ? '14px' : '17px'}; margin: 0 0 2px; letter-spacing: -0.01em; }
  .clinic-text p { margin: 0; }
  .muted { color: var(--muted); }
  .strong { font-weight: 600; margin: 0; }
  .doc-title {
    display: flex; justify-content: space-between; align-items: flex-end;
    margin: 14px 0 8px; padding-bottom: 6px; border-bottom: 2px solid var(--accent);
  }
  .doc-title h2 { margin: 0; font-size: ${thermal ? '13px' : '15px'}; text-transform: uppercase; letter-spacing: .08em; }
  .doc-title .number { font-size: ${thermal ? '12px' : '14px'}; font-weight: 600; }
  .grid { display: flex; gap: 14px; margin: 10px 0; }
  .grid > * { flex: 1; }
  .block h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin: 0 0 4px; }
  table { border-collapse: collapse; width: 100%; }
  table.meta th { text-align: left; font-weight: 500; color: var(--muted); padding: 1px 10px 1px 0; white-space: nowrap; vertical-align: top; }
  table.items { margin-top: 10px; }
  table.items th {
    text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--muted); border-bottom: 1px solid var(--line); padding: 5px 6px;
  }
  table.items td { padding: 6px; border-bottom: 1px solid #eef2f5; vertical-align: top; }
  table.items td.num, table.items th.num { text-align: right; white-space: nowrap; }
  table.totals { width: 62mm; margin-left: auto; margin-top: 8px; }
  table.totals td { padding: 3px 6px; }
  table.totals tr.grand td { border-top: 2px solid var(--accent); font-weight: 700; font-size: 1.06em; padding-top: 6px; }
  .pill {
    display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 10.5px;
    background: var(--tint); border: 1px solid var(--line); text-transform: uppercase; letter-spacing: .06em;
  }
  .signatures { display: flex; gap: 24px; margin-top: 26px; }
  .signatures div { flex: 1; border-top: 1px solid var(--line); padding-top: 5px; font-size: 11px; color: var(--muted); }
  .doc-footer { margin-top: 18px; font-size: 10.5px; color: var(--muted); border-top: 1px solid var(--line); padding-top: 6px; }
  .doc-footer p { margin: 2px 0; }
  .watermark {
    position: fixed; top: 38%; left: 0; right: 0; text-align: center;
    font-size: 84px; font-weight: 800; letter-spacing: .12em; color: rgba(192, 32, 32, .1);
    transform: rotate(-18deg); pointer-events: none; z-index: 0;
  }
  .watermark.draft { color: rgba(70, 90, 110, .12); }
  .rx { font-size: 20px; font-weight: 700; color: var(--accent); }
  .lines > div { border-bottom: 1px dotted var(--line); padding: 3px 0; }
  .thermal { text-align: ${thermal ? 'left' : 'inherit'}; }
  .center { text-align: center; }
  .small { font-size: 10.5px; }
  .admin-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .note-box { background: var(--tint); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; margin-top: 8px; }
</style>
</head>
<body>
  ${options.toolbar === false ? '' : `<div class="toolbar">
    <span class="hint">${escapeHtml(createTranslator(options.locale ?? 'en')('doc.savePdfHint'))}</span>
    <button type="button" onclick="window.print()">${escapeHtml(createTranslator(options.locale ?? 'en')('doc.print'))}</button>
    <button type="button" class="primary" onclick="window.close()">${escapeHtml(createTranslator(options.locale ?? 'en')('doc.close'))}</button>
  </div>`}
  <div class="sheet">
    ${watermark(options.status)}
    ${clinicBlock(options.clinic)}
    <div class="doc-title">
      <h2>${escapeHtml(options.title)}</h2>
      <div class="number">${escapeHtml(options.subtitle ?? '')}</div>
    </div>
    ${options.body}
    ${
      options.showSignatures === false || thermal
        ? ''
        : `<div class="signatures"><div>${escapeHtml(t('doc.patientSignature'))}</div><div>${escapeHtml(t('doc.doctorSignature'))}</div></div>`
    }
    <div class="doc-footer">
      ${options.footerText ? `<p>${escapeHtml(options.footerText)}</p>` : ''}
      ${options.footerNote ? `<p>${escapeHtml(options.footerNote)}</p>` : ''}
      <p>${escapeHtml(footer)}</p>
    </div>
  </div>
  ${options.autoPrint ? '<script>window.addEventListener("load", () => window.print());</script>' : ''}
</body>
</html>`;
}

/* ------------------------------------------------------------- documents */

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ invoice: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function invoiceHtml(db, ctx, { invoice, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const showTax = Number(invoice.taxMinor ?? 0) !== 0;
  const rows = (invoice.items ?? [])
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.description ?? '')}${item.toothCodes?.length ? `<span class="muted small"> · ${escapeHtml(item.toothCodes.join(', '))}</span>` : ''}</td>
        <td class="num">${escapeHtml(quantity(item.quantityMilli))}</td>
        <td class="num">${escapeHtml(money(item.unitPriceMinor, clinic))}</td>
        ${showTax ? `<td class="num">${escapeHtml(money(item.taxMinor, clinic))}</td>` : ''}
        <td class="num">${escapeHtml(money(item.lineTotalMinor, clinic))}</td>
      </tr>`,
    )
    .join('');

  const body = `
    <div class="grid">
      ${patientBlock(
        { full_name: invoice.patientName, patient_code: invoice.patientCode, phone: invoice.patientPhone },
        t('doc.billTo'),
      )}
      <div class="block">
        ${metaRow([
          [t('doc.issueDate'), formatDate(invoice.invoiceDate, 'DD MMM YYYY', clinic?.locale ?? 'en')],
          [t('doc.dueDate'), invoice.dueDate ? formatDate(invoice.dueDate, 'DD MMM YYYY', clinic?.locale ?? 'en') : null],
          [t('doc.status'), t(`billing.status${invoice.status.charAt(0).toUpperCase()}${invoice.status.slice(1)}`)],
        ])}
        <p class="pill">${escapeHtml(invoice.paymentStatus ?? '')}</p>
      </div>
    </div>
    <table class="items">
      <thead>
        <tr>
          <th>${escapeHtml(t('doc.details'))}</th>
          <th class="num">${escapeHtml(t('doc.quantity'))}</th>
          <th class="num">${escapeHtml(t('doc.unitPrice'))}</th>
          ${showTax ? `<th class="num">${escapeHtml(t('doc.tax'))}</th>` : ''}
          <th class="num">${escapeHtml(t('doc.lineTotal'))}</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="5" class="muted">${escapeHtml(t('common.empty'))}</td></tr>`}</tbody>
    </table>
    <table class="totals">
      <tr><td>${escapeHtml(t('doc.subtotal'))}</td><td class="num">${escapeHtml(money(invoice.subtotalMinor, clinic))}</td></tr>
      ${Number(invoice.discountMinor) ? `<tr><td>${escapeHtml(t('doc.discount'))}</td><td class="num">−${escapeHtml(money(invoice.discountMinor, clinic))}</td></tr>` : ''}
      ${showTax ? `<tr><td>${escapeHtml(settings?.termLabel ?? t('doc.tax'))}</td><td class="num">${escapeHtml(money(invoice.taxMinor, clinic))}</td></tr>` : ''}
      ${Number(invoice.roundOffMinor) ? `<tr><td>${escapeHtml(t('billing.roundOff'))}</td><td class="num">${escapeHtml(money(invoice.roundOffMinor, clinic))}</td></tr>` : ''}
      <tr class="grand"><td>${escapeHtml(t('doc.total'))}</td><td class="num">${escapeHtml(money(invoice.totalMinor, clinic))}</td></tr>
      <tr><td>${escapeHtml(t('doc.paid'))}</td><td class="num">${escapeHtml(money(invoice.paidMinor, clinic))}</td></tr>
      <tr><td><strong>${escapeHtml(t('doc.balanceDue'))}</strong></td><td class="num"><strong>${escapeHtml(money(invoice.dueMinor, clinic))}</strong></td></tr>
    </table>
    ${invoice.notes ? `<div class="note-box small">${escapeHtml(invoice.notes)}</div>` : ''}`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: settings?.termLabel ? `${t('doc.taxInvoice')}` : t('doc.invoice'),
    subtitle: invoice.invoiceNumber ?? '',
    status: invoice.status,
    body,
    paper: settings?.paper ?? 'A4',
    orientation: settings?.orientation ?? 'portrait',
    marginMm: settings?.marginMm,
    scale: settings?.scale,
    footerText: invoice.footerText ?? settings?.footer ?? '',
    footerNote: invoice.terms ?? settings?.terms ?? '',
    showSignatures: settings?.showSignatures !== false,
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ payment: any, clinic: any, invoice?: any, patientCreditMinor?: number, settings: any }} payload
 * @returns {string}
 */
export function receiptHtml(db, ctx, { payment, clinic, invoice, patientCreditMinor, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const body = `
    <div class="grid">
      ${patientBlock({ full_name: payment.patientName, patient_code: payment.patientCode, phone: payment.patientPhone }, t('doc.receivedFrom'))}
      <div class="block">
        ${metaRow([
          [t('doc.issueDate'), formatDate(payment.paymentDate, 'DD MMM YYYY', clinic?.locale ?? 'en')],
          [t('doc.method'), payment.methodLabel ?? payment.methodCode],
          [t('doc.reference'), payment.referenceNo],
          [t('doc.receivedBy'), payment.receivedBy],
        ])}
      </div>
    </div>
    <table class="totals" style="width:100%">
      <tr class="grand"><td>${escapeHtml(t('payments.amount'))}</td><td class="num">${escapeHtml(money(payment.amountMinor, clinic))}</td></tr>
    </table>
    ${
      invoice
        ? `<div class="block" style="margin-top:10px">
            <h2>${escapeHtml(t('doc.paymentFor'))}</h2>
            ${metaRow([
              [t('doc.number'), invoice.invoiceNumber],
              [t('doc.issueDate'), formatDate(invoice.invoiceDate, 'DD MMM YYYY', clinic?.locale ?? 'en')],
              [t('doc.total'), money(invoice.totalMinor, clinic)],
              [t('doc.paid'), money(invoice.paidMinor, clinic)],
              [t('doc.balanceDue'), money(invoice.dueMinor, clinic)],
            ])}
          </div>`
        : ''
    }
    ${
      Number(patientCreditMinor) > 0
        ? `<div class="note-box small">${escapeHtml(t('doc.creditBalance'))}: <strong>${escapeHtml(money(patientCreditMinor, clinic))}</strong></div>`
        : ''
    }
    <p class="center muted small" style="margin-top:16px">${escapeHtml(t('doc.thankYou'))}</p>`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.receipt'),
    subtitle: payment.receiptNumber ?? '',
    status: payment.voidedAt ? 'void' : null,
    body,
    paper: settings?.receiptPaper ?? 'Receipt80',
    marginMm: 6,
    footerText: settings?.footer ?? '',
    showSignatures: false,
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ prescription: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function prescriptionHtml(db, ctx, { prescription, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const medicines = (prescription.items ?? [])
    .map(
      (item, index) => `<tr>
        <td class="num">${index + 1}</td>
        <td><span class="strong">${escapeHtml(item.medication ?? '')}</span>${item.strength ? ` <span class="muted">${escapeHtml(item.strength)}</span>` : ''}
          ${item.instructions ? `<div class="muted small">${escapeHtml(item.instructions)}</div>` : ''}</td>
        <td>${escapeHtml(item.dose ?? '')}</td>
        <td>${escapeHtml(item.frequency ?? '')}</td>
        <td>${escapeHtml(item.duration ?? '')}</td>
        <td>${escapeHtml(item.route ?? '')}</td>
      </tr>`,
    )
    .join('');

  const body = `
    <div class="grid">
      ${patientBlock(
        { full_name: prescription.patientName, patient_code: prescription.patientCode, phone: prescription.patientPhone, gender: prescription.patientGender, dob: prescription.patientDob },
        t('doc.issuedTo'),
      )}
      <div class="block">
        ${metaRow([
          [t('prescriptions.date'), formatDate(prescription.rxDate, 'DD MMM YYYY', clinic?.locale ?? 'en')],
          [t('prescriptions.diagnosis'), prescription.diagnosis],
          [t('common.practitioner'), prescription.practitionerName],
        ])}
        <p class="rx">℞</p>
      </div>
    </div>
    <table class="items">
      <thead>
        <tr>
          <th class="num">#</th>
          <th>${escapeHtml(t('prescriptions.medicine'))}</th>
          <th>${escapeHtml(t('prescriptions.dose'))}</th>
          <th>${escapeHtml(t('prescriptions.frequency'))}</th>
          <th>${escapeHtml(t('prescriptions.duration'))}</th>
          <th>${escapeHtml(t('prescriptions.route'))}</th>
        </tr>
      </thead>
      <tbody>${medicines || `<tr><td colspan="6" class="muted">${escapeHtml(t('common.empty'))}</td></tr>`}</tbody>
    </table>
    ${prescription.advice ? `<div class="note-box"><strong>${escapeHtml(t('doc.advice'))}:</strong> ${escapeHtml(prescription.advice)}</div>` : ''}
    ${prescription.investigations ? `<div class="note-box"><strong>${escapeHtml(t('doc.investigations'))}:</strong> ${escapeHtml(prescription.investigations)}</div>` : ''}
    ${
      prescription.followupDate
        ? `<p style="margin-top:10px"><strong>${escapeHtml(t('prescriptions.followup'))}:</strong> ${escapeHtml(formatDate(prescription.followupDate, 'DD MMM YYYY', clinic?.locale ?? 'en'))}</p>`
        : ''
    }`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.prescription'),
    subtitle: prescription.rxCode ?? '',
    body,
    paper: settings?.paper ?? 'A4',
    showSignatures: settings?.showSignatures !== false,
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ plan: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function planHtml(db, ctx, { plan, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const stages = new Map();
  for (const item of plan.items ?? []) {
    const key = item.stage ?? 'stage1';
    if (!stages.has(key)) stages.set(key, []);
    stages.get(key).push(item);
  }
  const stageLabels = { stage1: 'plans.stage1', stage2: 'plans.stage2', stage3: 'plans.stage3', stage4: 'plans.stage4' };
  const body = `
    <div class="grid">
      ${patientBlock({ full_name: plan.patientName, patient_code: plan.patientCode, phone: plan.patientPhone }, t('doc.issuedTo'))}
      <div class="block">
        ${metaRow([
          [t('prescriptions.date'), formatDate(plan.proposedDate ?? plan.createdAt?.slice(0, 10), 'DD MMM YYYY', clinic?.locale ?? 'en')],
          [t('plans.diagnosis'), plan.diagnosis],
          [t('plans.patientDecision'), t(`plans.decision${(plan.patientDecision ?? 'pending').charAt(0).toUpperCase()}${(plan.patientDecision ?? 'pending').slice(1)}`)],
        ])}
      </div>
    </div>
    <h2 style="margin-top:10px">${escapeHtml(t('doc.treatmentPlan'))}</h2>
    ${[...stages.entries()]
      .map(
        ([stage, items]) => `
        <h3 class="small muted" style="margin:10px 0 4px">${escapeHtml(t(stageLabels[stage] ?? 'doc.stage'))}</h3>
        <table class="items">
          <thead><tr>
            <th>${escapeHtml(t('doc.procedure'))}</th>
            <th>${escapeHtml(t('doc.tooth'))}</th>
            <th class="num">${escapeHtml(t('doc.quantity'))}</th>
            <th class="num">${escapeHtml(t('doc.unitPrice'))}</th>
            <th class="num">${escapeHtml(t('doc.lineTotal'))}</th>
          </tr></thead>
          <tbody>${items
            .map(
              (item) => `<tr>
                <td>${escapeHtml(item.name ?? item.description ?? '')}</td>
                <td>${escapeHtml((item.toothCodes ?? []).join(', ') || '—')}</td>
                <td class="num">${escapeHtml(quantity(item.quantityMilli))}</td>
                <td class="num">${escapeHtml(money(item.unitPriceMinor, clinic))}</td>
                <td class="num">${escapeHtml(money(item.lineTotalMinor, clinic))}</td>
              </tr>`,
            )
            .join('')}</tbody>
        </table>`,
      )
      .join('')}
    <table class="totals">
      <tr><td>${escapeHtml(t('doc.subtotal'))}</td><td class="num">${escapeHtml(money(plan.subtotalMinor, clinic))}</td></tr>
      ${Number(plan.discountMinor) ? `<tr><td>${escapeHtml(t('doc.discount'))}</td><td class="num">−${escapeHtml(money(plan.discountMinor, clinic))}</td></tr>` : ''}
      ${Number(plan.taxMinor) ? `<tr><td>${escapeHtml(t('doc.tax'))}</td><td class="num">${escapeHtml(money(plan.taxMinor, clinic))}</td></tr>` : ''}
      <tr class="grand"><td>${escapeHtml(t('doc.estimateTotal'))}</td><td class="num">${escapeHtml(money(plan.totalMinor, clinic))}</td></tr>
    </table>
    <p class="muted small">${escapeHtml(t('doc.validFor'))}</p>`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.plan'),
    subtitle: plan.planCode ?? '',
    body,
    paper: settings?.paper ?? 'A4',
    showSignatures: settings?.showSignatures !== false,
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ visit: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function visitHtml(db, ctx, { visit, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const section = (label, value) =>
    value ? `<div class="note-box"><strong>${escapeHtml(label)}:</strong><div>${escapeHtml(value)}</div></div>` : '';
  const body = `
    <div class="grid">
      ${patientBlock(
        { full_name: visit.patientName, patient_code: visit.patientCode, phone: visit.patientPhone, gender: visit.patientGender, dob: visit.patientDob },
        t('doc.issuedTo'),
      )}
      <div class="block">
        ${metaRow([
          [t('visits.date'), formatDate(visit.visitDate, 'DD MMM YYYY', clinic?.locale ?? 'en')],
          [t('visits.time'), visit.visitTime ? formatTime(visit.visitTime, '12h', clinic?.locale ?? 'en') : null],
          [t('common.practitioner'), visit.practitionerName],
          [t('visits.code'), visit.visitCode],
        ])}
      </div>
    </div>
    ${section(t('visits.chiefComplaint'), visit.chiefComplaint)}
    ${section(t('visits.examination'), visit.examination)}
    ${section(t('visits.diagnosis'), visit.diagnosis)}
    ${section(t('visits.treatmentGiven'), visit.treatmentGiven)}
    ${section(t('visits.advice'), visit.instructions ?? visit.advice)}
    ${section(t('prescriptions.medications'), (visit.medications ?? []).join(', '))}
    ${section(t('visits.followupDate'), visit.followupDate ? formatDate(visit.followupDate, 'DD MMM YYYY', clinic?.locale ?? 'en') : null)}`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.visitSummary'),
    subtitle: visit.visitCode ?? '',
    body,
    paper: settings?.paper ?? 'A4',
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ referral: any, patient?: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function referralHtml(db, ctx, { referral, patient, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const body = `
    <div class="grid">
      ${patientBlock(
        { full_name: patient?.full_name ?? referral.patientName, patient_code: patient?.patient_code ?? referral.patientCode, phone: patient?.phone, gender: patient?.gender, dob: patient?.dob },
        t('doc.issuedTo'),
      )}
      <div class="block">
        ${metaRow([
          [t('referrals.date'), formatDate(referral.referralDate, 'DD MMM YYYY', clinic?.locale ?? 'en')],
          [t('referrals.urgency'), t(`referrals.${referral.urgency ?? 'routine'}`)],
          [t('common.practitioner'), referral.practitionerName],
        ])}
      </div>
    </div>
    <div class="note-box">
      <strong>${escapeHtml(t('referrals.provider'))}:</strong> ${escapeHtml(referral.providerName ?? '')}
      ${referral.specialty ? ` · ${escapeHtml(referral.specialty)}` : ''}
      ${referral.institution ? `<div>${escapeHtml(referral.institution)}</div>` : ''}
      ${referral.providerPhone ? `<div class="muted small">${escapeHtml(referral.providerPhone)}</div>` : ''}
    </div>
    ${referral.reason ? `<div class="note-box"><strong>${escapeHtml(t('referrals.reason'))}:</strong><div>${escapeHtml(referral.reason)}</div></div>` : ''}
    ${referral.clinicalSummary ? `<div class="note-box"><strong>${escapeHtml(t('doc.clinicalSummary'))}:</strong><div>${escapeHtml(referral.clinicalSummary)}</div></div>` : ''}
    ${referral.expectations ? `<div class="note-box"><strong>${escapeHtml(t('referrals.expectations'))}:</strong><div>${escapeHtml(referral.expectations)}</div></div>` : ''}
    ${referral.followupDate ? `<p><strong>${escapeHtml(t('referrals.followupDate'))}:</strong> ${escapeHtml(formatDate(referral.followupDate, 'DD MMM YYYY', clinic?.locale ?? 'en'))}</p>` : ''}`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.referralLetter'),
    subtitle: referral.referralCode ?? '',
    body,
    paper: settings?.paper ?? 'A4',
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ statement: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function statementHtml(db, ctx, { statement, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const rows = (statement.ledger ?? [])
    .map(
      (entry) => `<tr>
        <td>${escapeHtml(formatDate(entry.date, 'DD MMM YYYY', clinic?.locale ?? 'en'))}</td>
        <td>${escapeHtml(entry.reference ?? '')}</td>
        <td>${escapeHtml(entry.kind ?? '')}</td>
        <td class="num">${entry.direction === 'debit' ? escapeHtml(money(entry.amount_minor, clinic)) : ''}</td>
        <td class="num">${entry.direction === 'credit' ? escapeHtml(money(entry.amount_minor, clinic)) : ''}</td>
        <td class="num">${escapeHtml(money(entry.balanceMinor, clinic))}</td>
      </tr>`,
    )
    .join('');
  const body = `
    ${patientBlock(statement.patient, t('doc.issuedTo'))}
    <p class="muted small">${escapeHtml(t('finance.rangeHint', { from: formatDate(statement.range.from, 'DD MMM YYYY', clinic?.locale ?? 'en'), to: formatDate(statement.range.to, 'DD MMM YYYY', clinic?.locale ?? 'en') }))}</p>
    <table class="items">
      <thead><tr>
        <th>${escapeHtml(t('doc.issueDate'))}</th>
        <th>${escapeHtml(t('doc.details'))}</th>
        <th>${escapeHtml(t('doc.status'))}</th>
        <th class="num">${escapeHtml(t('doc.debit'))}</th>
        <th class="num">${escapeHtml(t('doc.credit'))}</th>
        <th class="num">${escapeHtml(t('common.balance'))}</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="muted">${escapeHtml(t('reports.noData'))}</td></tr>`}</tbody>
    </table>
    <table class="totals">
      <tr><td>${escapeHtml(t('finance.invoiced'))}</td><td class="num">${escapeHtml(money(statement.summary.invoicedMinor, clinic))}</td></tr>
      <tr><td>${escapeHtml(t('doc.paid'))}</td><td class="num">${escapeHtml(money(statement.summary.paidMinor, clinic))}</td></tr>
      ${Number(statement.summary.refundedMinor) ? `<tr><td>${escapeHtml(t('finance.refunds'))}</td><td class="num">${escapeHtml(money(statement.summary.refundedMinor, clinic))}</td></tr>` : ''}
      <tr class="grand"><td>${escapeHtml(t('doc.closingBalance'))}</td><td class="num">${escapeHtml(money(statement.summary.outstandingMinor, clinic))}</td></tr>
      ${Number(statement.summary.creditMinor) ? `<tr><td>${escapeHtml(t('doc.creditBalance'))}</td><td class="num">${escapeHtml(money(statement.summary.creditMinor, clinic))}</td></tr>` : ''}
    </table>`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.statement'),
    subtitle: statement.patient?.patient_code ?? '',
    body,
    paper: settings?.paper ?? 'A4',
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ patient: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function patientCardHtml(db, ctx, { patient, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const body = `
    <div class="grid">
      <div class="block">
        <h2>${escapeHtml(t('patients.profile'))}</h2>
        <p class="strong">${escapeHtml(patient.fullName ?? '')}</p>
        <p class="muted">${escapeHtml(patient.patientCode ?? '')}</p>
        ${metaRow([
          [t('common.phone'), patient.phone],
          [t('common.gender'), patient.gender],
          [t('common.dob'), patient.dob ? formatDate(patient.dob, 'DD MMM YYYY', clinic?.locale ?? 'en') : null],
          [t('common.age'), patient.age !== undefined ? String(patient.age) : null],
          [t('patients.bloodGroup'), patient.bloodGroup],
          [t('common.address'), patient.address],
          [t('patients.emergency'), patient.emergencyName ? `${patient.emergencyName} ${patient.emergencyPhone ?? ''}` : null],
        ])}
      </div>
      <div class="block">
        <h2>${escapeHtml(t('patients.medicalTitle'))}</h2>
        ${metaRow([
          [t('patients.allergies'), patient.medical?.allergies],
          [t('patients.conditions'), patient.medical?.conditions],
          [t('patients.medications'), patient.medical?.currentMedications],
        ])}
        <h2 style="margin-top:10px">${escapeHtml(t('patients.stats'))}</h2>
        ${metaRow([
          [t('patients.visitsCount'), number(patient.stats?.visits ?? 0, clinic)],
          [t('patients.treatmentsCount'), number(patient.stats?.treatments ?? 0, clinic)],
          [t('patients.outstanding'), money(patient.stats?.outstandingMinor ?? 0, clinic)],
        ])}
      </div>
    </div>`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.patientCard'),
    subtitle: patient.patientCode ?? '',
    body,
    paper: settings?.paper ?? 'A5',
    showSignatures: false,
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ entry: any, ahead?: number, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function queueTicketHtml(db, ctx, { entry, ahead, clinic, settings }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const body = `
    <div class="center">
      <p class="muted small">${escapeHtml(t('doc.issueDate'))}: ${escapeHtml(formatDate(todayIso(), 'DD MMM YYYY', clinic?.locale ?? 'en'))} · ${escapeHtml(formatTime(new Date().toTimeString().slice(0, 5), '12h', clinic?.locale ?? 'en'))}</p>
      <div style="font-size:52px;font-weight:800;letter-spacing:.02em;margin:6px 0">${escapeHtml(String(entry.serialNo ?? ''))}</div>
      <p class="strong">${escapeHtml(entry.patientName ?? '')}</p>
      <p class="muted small">${escapeHtml(entry.patientCode ?? '')}</p>
      <p>${escapeHtml(t('doc.peopleAhead', { count: ahead ?? 0 }))}</p>
      <p class="muted small">${escapeHtml(t('doc.pleaseWait'))}</p>
    </div>`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: t('doc.queueTicket'),
    subtitle: '',
    body,
    paper: settings?.receiptPaper ?? 'Receipt80',
    marginMm: 5,
    showSignatures: false,
    toolbar: true,
  });
}

/** `status.scheduled` → “Scheduled”, falling back to the raw value. */
function statusLabel(t, value) {
  if (!value) return '';
  const key = `status.${value}`;
  const text = t(key);
  return text === key ? String(value) : text;
}

/**
 * Appointment slip — the paper the patient leaves the desk with. Printed on the
 * receipt roll by default because that is what a front desk usually has loaded.
 * @param {any} db
 * @param {any} ctx
 * @param {{ appointment: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function appointmentSlipHtml(db, ctx, { appointment, clinic, settings }) {
  const locale = clinic?.locale ?? 'en';
  const t = createTranslator(locale);
  const body = `
    <div class="grid">
      ${patientBlock({ full_name: appointment.patientName, patient_code: appointment.patientCode, phone: appointment.patientPhone }, t('doc.issuedTo'))}
      <div class="block">
        ${metaRow([
          [t('doc.number'), appointment.appointmentCode],
          [t('doc.date'), formatDate(appointment.apptDate, 'DD MMM YYYY', locale)],
          [t('doc.time'), appointment.startTime ? `${formatTime(appointment.startTime, '12h', locale)} – ${formatTime(appointment.endTime, '12h', locale)}` : null],
          [t('doc.practitioner'), appointment.practitionerName],
          [t('doc.status'), statusLabel(t, appointment.status)],
        ])}
      </div>
    </div>
    ${appointment.typeLabel || appointment.reason ? `<div class="note-box small">${escapeHtml(appointment.typeLabel ?? '')}${appointment.typeLabel && appointment.reason ? ' · ' : ''}${escapeHtml(appointment.reason ?? '')}</div>` : ''}
    <p class="small muted">${escapeHtml(t('doc.arriveEarly'))}</p>`;

  return renderDocument({
    locale,
    clinic,
    title: t('doc.appointmentSlip'),
    subtitle: appointment.appointmentCode ?? '',
    body,
    paper: settings?.receiptPaper ?? 'Receipt80',
    marginMm: 5,
    showSignatures: false,
  });
}

/**
 * Payslip — gross, deductions, net, paid and due for one payroll period, with a
 * signature line for the clinic.
 * @param {any} db
 * @param {any} ctx
 * @param {{ payroll: any, clinic: any, settings: any }} payload
 * @returns {string}
 */
export function payslipHtml(db, ctx, { payroll, clinic, settings }) {
  const locale = clinic?.locale ?? 'en';
  const t = createTranslator(locale);
  const body = `
    <div class="grid">
      ${patientBlock({ full_name: payroll.staffName, patient_code: payroll.staffCode, gender: null, dob: null }, t('doc.staffMember'))}
      <div class="block">
        ${metaRow([
          [t('doc.period'), `${formatDate(payroll.periodStart, 'DD MMM YYYY', locale)} – ${formatDate(payroll.periodEnd, 'DD MMM YYYY', locale)}`],
          [t('doc.method'), payroll.methodCode ? statusLabel(t, payroll.methodCode) : null],
          [t('doc.paid'), payroll.paidOn ? formatDate(payroll.paidOn, 'DD MMM YYYY', locale) : null],
          [t('doc.status'), t(`payroll.status${String(payroll.status ?? '').charAt(0).toUpperCase()}${String(payroll.status ?? '').slice(1)}`)],
        ])}
      </div>
    </div>
    <table class="totals">
      <tr><td>${escapeHtml(t('doc.grossEarnings'))}</td><td class="num">${escapeHtml(money(payroll.grossMinor, clinic))}</td></tr>
      <tr><td>${escapeHtml(t('doc.deductions'))}</td><td class="num">−${escapeHtml(money(payroll.deductionMinor, clinic))}</td></tr>
      <tr class="grand"><td>${escapeHtml(t('doc.netPay'))}</td><td class="num">${escapeHtml(money(payroll.netMinor, clinic))}</td></tr>
      <tr><td>${escapeHtml(t('doc.paid'))}</td><td class="num">${escapeHtml(money(payroll.paidMinor, clinic))}</td></tr>
      <tr><td><strong>${escapeHtml(t('doc.balanceDue'))}</strong></td><td class="num"><strong>${escapeHtml(money(payroll.dueMinor, clinic))}</strong></td></tr>
    </table>
    ${payroll.notes ? `<div class="note-box small">${escapeHtml(payroll.notes)}</div>` : ''}`;

  return renderDocument({
    locale,
    clinic,
    title: t('doc.payslip'),
    subtitle: payroll.staffCode ?? '',
    status: payroll.status === 'cancelled' ? 'void' : null,
    body,
    paper: settings?.paper ?? 'A5',
    orientation: settings?.orientation ?? 'portrait',
    marginMm: settings?.marginMm,
    scale: settings?.scale,
    showSignatures: settings?.showSignatures !== false,
  });
}

/**
 * Render the document to a standalone printable HTML page.
 * @param {any} db
 * @param {any} ctx
 * @param {{ report: any, clinic: any, settings: any, titleKey?: string }} payload
 * @returns {string}
 */
export function reportHtml(db, ctx, { report, clinic, settings, titleKey }) {
  const t = createTranslator(clinic?.locale ?? 'en');
  const columns = report.columns ?? [];
  const head = columns.map((column) => `<th class="${String(column.key).endsWith('_minor') ? 'num' : ''}">${escapeHtml(t(column.labelKey ?? column.key))}</th>`).join('');
  const rows = (report.rows ?? [])
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => {
            const value = row[column.key];
            if (column.money) return `<td class="num">${escapeHtml(money(value ?? 0, clinic))}</td>`;
            return `<td>${escapeHtml(value === null || value === undefined ? '' : String(value))}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');

  const body = `
    <p class="muted small">${escapeHtml(
      t('finance.rangeHint', { from: formatDate(report.range.from, 'DD MMM YYYY', clinic?.locale ?? 'en'), to: formatDate(report.range.to, 'DD MMM YYYY', clinic?.locale ?? 'en') }),
    )} · ${escapeHtml(t('reports.rowCount', { count: report.rows?.length ?? 0 }))}</p>
    <table class="items">
      <thead><tr>${head}</tr></thead>
      <tbody>${rows || `<tr><td colspan="${columns.length}" class="muted">${escapeHtml(t('reports.noData'))}</td></tr>`}</tbody>
    </table>`;

  return renderDocument({
    locale: clinic?.locale ?? 'en',
    clinic,
    title: titleKey ? t(titleKey) : t('doc.report'),
    subtitle: t('reports.generatedAt', { timestamp: formatDateLong(new Date(), clinic?.locale ?? 'en') }),
    body,
    paper: settings?.paper ?? 'A4',
    orientation: 'portrait',
    showSignatures: false,
  });
}

/** Paper size resolution shared by the document routes. */
export function paperFor(settings, key = 'print.defaultPaper') {
  // `PAPER_SIZES` holds objects, so this has to compare codes: comparing the
  // value against the array silently answered "A4" for every choice, which is
  // how an A5 or 80 mm thermal receipt came out as an A4 page.
  const value = settings?.[key] ?? 'A4';
  return PAPER_SIZES.some((paper) => paper.code === value) ? value : 'A4';
}
