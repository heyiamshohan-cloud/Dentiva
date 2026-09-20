/**
 * Money arithmetic.
 *
 * All amounts inside Dentiva are INTEGER minor units (poisha/cents).
 * No float ever touches a stored amount, a total or a balance (§ 10, § 71).
 *
 * Basis points (bp) are used for percentage rates: 500 bp = 5.00 %.
 */

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

/** Convert latin digits in a string to Bengali digits (and back). */
export function toBengaliDigits(value) {
  return String(value).replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
}

export function fromBengaliDigits(value) {
  return String(value).replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
}

/**
 * Parse a user-entered amount into minor units.
 * Accepts "1,250.50", "1250", "৳ 1 250,50", Bengali digits.
 * @param {string|number} input
 * @param {number} [minorUnits]
 * @returns {number|null} integer minor units, or null when not parseable
 */
export function parseAmount(input, minorUnits = 2) {
  if (input === null || input === undefined || input === '') return 0;
  let text = fromBengaliDigits(String(input)).trim();
  if (!text) return 0;
  text = text.replace(/[^\d.,\-]/g, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // Whichever appears last is the decimal separator.
    if (lastComma > lastDot) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimals = text.length - lastComma - 1;
    if (decimals > 0 && decimals <= (minorUnits === 0 ? 0 : 2)) text = text.replace(',', '.');
    else text = text.replace(/,/g, '');
  }
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10 ** minorUnits);
}

/**
 * Format minor units for display.
 * @param {number} minor
 * @param {{ minorUnits?: number, symbol?: string, locale?: string, showSymbol?: boolean, showDecimals?: boolean, signed?: boolean }} [options]
 */
export function formatAmount(minor, options = {}) {
  const minorUnits = options.minorUnits ?? 2;
  const locale = options.locale === 'bn' ? 'bn-BD' : 'en-US';
  const value = Number(minor ?? 0) / 10 ** minorUnits;
  const showDecimals = options.showDecimals ?? minorUnits > 0;
  let text = new Intl.NumberFormat(locale, {
    minimumFractionDigits: showDecimals ? minorUnits : 0,
    maximumFractionDigits: showDecimals ? minorUnits : 0,
  }).format(value);
  if (options.locale === 'bn') text = toBengaliDigits(text);
  const symbol = options.symbol ?? '';
  const negative = value < 0;
  if (options.showSymbol && symbol) {
    text = negative ? `${symbol} ${text.slice(1)}` : `${symbol} ${text}`;
  }
  if (negative && !options.showSymbol) text = `-${text.slice(1)}`;
  if (options.signed && value > 0) text = `+${text}`;
  return text;
}

/** Formats from a decimal number (display helpers, reports, charts). */
export function formatFromUnits(units, options = {}) {
  const minorUnits = options.minorUnits ?? 2;
  return formatAmount(Math.round(Number(units ?? 0) * 10 ** minorUnits), options);
}

export function unitsToMinor(units, minorUnits = 2) {
  return Math.round(Number(units ?? 0) * 10 ** minorUnits);
}

export function minorToUnits(minor, minorUnits = 2) {
  return Number(minor ?? 0) / 10 ** minorUnits;
}

/** Percentage of an amount using basis points, rounded half-up to a whole minor unit. */
export function percentOf(amountMinor, rateBp) {
  if (!rateBp) return 0;
  return Math.round((amountMinor * rateBp) / 10000);
}

/** Parse "12.5" or "12,5" percent into basis points. */
export function parsePercentToBp(value) {
  if (value === null || value === undefined || value === '') return 0;
  const text = fromBengaliDigits(String(value)).replace('%', '').replace(',', '.').trim();
  const num = Number(text);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function formatBp(rateBp, locale = 'en') {
  const text = new Intl.NumberFormat(locale === 'bn' ? 'bn-BD' : 'en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(rateBp ?? 0) / 100);
  return locale === 'bn' ? toBengaliDigits(text) : text;
}

export function sumMinor(values) {
  let total = 0;
  for (const value of values ?? []) total += Math.round(Number(value) || 0);
  return total;
}

/**
 * Discount for a line.
 * @param {number} baseMinor
 * @param {'amount'|'percent'} type
 * @param {number} value amount in minor units, or basis points for percent
 */
export function discountFor(baseMinor, type, value) {
  const raw = type === 'percent' ? percentOf(baseMinor, value) : Math.round(Number(value) || 0);
  return Math.max(0, Math.min(raw, baseMinor));
}

/**
 * Round a final payable amount to the nearest whole currency unit using
 * symmetric half-up rounding and report the round-off adjustment (§ 71).
 * @returns {{ roundedMinor: number, roundOffMinor: number }}
 */
export function roundToWhole(totalMinor, minorUnits = 2) {
  if (minorUnits === 0) return { roundedMinor: totalMinor, roundOffMinor: 0 };
  const step = 10 ** minorUnits;
  const rounded = Math.round(totalMinor / step) * step;
  return { roundedMinor: rounded, roundOffMinor: rounded - totalMinor };
}

/**
 * Split an amount across weights without losing or inventing a single minor
 * unit (largest remainder method). Used for invoice-level discounts and
 * proportional refunds.
 * @param {number} amountMinor
 * @param {number[]} weights
 * @returns {number[]}
 */
export function allocate(amountMinor, weights) {
  const total = weights.reduce((sum, w) => sum + Math.max(0, Number(w) || 0), 0);
  const result = weights.map(() => 0);
  if (total <= 0) return result;
  let assigned = 0;
  const remainders = [];
  weights.forEach((weight, index) => {
    const exact = (Math.max(0, Number(weight) || 0) * amountMinor) / total;
    const base = Math.floor(exact);
    result[index] = base;
    assigned += base;
    remainders.push({ index, remainder: exact - base });
  });
  let leftover = amountMinor - assigned;
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  let cursor = 0;
  while (leftover > 0 && remainders.length) {
    result[remainders[cursor % remainders.length].index] += 1;
    leftover -= 1;
    cursor += 1;
  }
  while (leftover < 0) {
    const target = remainders[(cursor += 1) % remainders.length].index;
    if (result[target] > 0) {
      result[target] -= 1;
      leftover += 1;
    }
    if (cursor > remainders.length * 4) break;
  }
  return result;
}

/**
 * Full line calculation for an invoice item, treatment or plan item.
 * @param {{ quantityMilli?: number, unitPriceMinor?: number, discountType?: 'amount'|'percent', discountValue?: number, taxRateBp?: number }} line
 */
export function calculateLine(line) {
  const quantityMilli = Math.max(0, Math.round(Number(line.quantityMilli ?? 1000)));
  const unitPriceMinor = Math.max(0, Math.round(Number(line.unitPriceMinor ?? 0)));
  const lineSubtotalMinor = Math.round((quantityMilli * unitPriceMinor) / 1000);
  const discountMinor = discountFor(lineSubtotalMinor, line.discountType ?? 'amount', line.discountValue ?? 0);
  const netMinor = lineSubtotalMinor - discountMinor;
  const taxMinor = percentOf(netMinor, Number(line.taxRateBp ?? 0));
  return {
    quantityMilli,
    unitPriceMinor,
    lineSubtotalMinor,
    discountMinor,
    taxMinor,
    lineTotalMinor: netMinor + taxMinor,
  };
}

/**
 * Document totals from a list of calculated lines plus an optional document
 * level discount (amount or percent of the net subtotal).
 * @param {{ lineTotalMinor: number, discountMinor: number, taxMinor: number, lineSubtotalMinor: number }[]} lines
 * @param {{ discountType?: 'amount'|'percent', discountValue?: number, roundToWhole?: boolean, minorUnits?: number }} [options]
 */
export function calculateTotals(lines, options = {}) {
  const subtotalMinor = sumMinor(lines.map((l) => l.lineSubtotalMinor));
  let lineDiscountMinor = sumMinor(lines.map((l) => l.discountMinor));
  let taxMinor = sumMinor(lines.map((l) => l.taxMinor));

  let documentDiscountMinor = 0;
  if (options.discountValue) {
    const netBefore = lines.reduce((sum, l) => sum + l.lineSubtotalMinor - l.discountMinor, 0);
    documentDiscountMinor = discountFor(netBefore, options.discountType ?? 'amount', options.discountValue);
    if (taxMinor > 0 && netBefore > 0) {
      // Re-proportion tax after the document discount so the client is not
      // charged tax on money they never pay.
      taxMinor = Math.round((taxMinor * (netBefore - documentDiscountMinor)) / netBefore);
    }
  }

  const discountMinor = lineDiscountMinor + documentDiscountMinor;
  const grossTotal = subtotalMinor - discountMinor + taxMinor;
  let totalMinor = grossTotal;
  let roundOffMinor = 0;
  if (options.roundToWhole) {
    const rounded = roundToWhole(grossTotal, options.minorUnits ?? 2);
    totalMinor = rounded.roundedMinor;
    roundOffMinor = rounded.roundOffMinor;
  }
  return {
    subtotalMinor,
    discountMinor,
    taxMinor,
    roundOffMinor,
    totalMinor,
    netMinor: subtotalMinor - discountMinor,
  };
}

/** Outstanding balance helper used across billing, dashboards and reports. */
export function balanceOf(totalMinor, paidMinor) {
  return Math.max(0, Math.round(Number(totalMinor) || 0) - Math.round(Number(paidMinor) || 0));
}
