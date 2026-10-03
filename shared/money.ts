import type { CurrencyCode, Minor } from './contract.ts';

const SYMBOL: Record<CurrencyCode, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$' };

/** `123456` -> `$1,234.56`. Whole amounts drop the cents unless `cents` is forced. */
export function formatMoney(minor: Minor, currency: CurrencyCode = 'USD', opts: { cents?: boolean } = {}): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const showCents = opts.cents ?? frac !== 0;
  const body = showCents ? `${grouped}.${String(frac).padStart(2, '0')}` : grouped;
  return `${neg ? '-' : ''}${SYMBOL[currency]}${body}`;
}

/** PayPal money value: a decimal string with exactly two places, e.g. `"1234.50"`. */
export function toPayPalValue(minor: Minor): string {
  const abs = Math.abs(Math.round(minor));
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse a PayPal decimal string into minor units without going through floats.
 * Returns `null` for anything that is not a plain decimal with at most 2 places.
 */
export function fromPayPalValue(value: unknown): Minor | null {
  if (typeof value !== 'string') return null;
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0');
  return m[1] ? -minor : minor;
}

/** Parse a human amount such as `$12,000`, `4.5k`, `1,250.50` into minor units. */
export function parseHumanAmount(text: string): Minor | null {
  const m = /^\s*(?:[$€£]|USD|EUR|GBP|CAD|AUD)?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*([kK])?\s*$/.exec(text);
  if (!m) return null;
  const whole = Number(m[1]!.replace(/,/g, ''));
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  let minor = whole * 100 + frac;
  if (m[3]) minor *= 1000;
  return Number.isSafeInteger(minor) ? minor : null;
}
