/**
 * The no-invention guard.
 *
 * The model may write prose, but every figure in that prose must already be a
 * fact: an amount from the approved plan or a PayPal response, a date from the
 * schedule, an invoice id PayPal returned, a status PayPal reported. This
 * module pulls every figure-like token out of a piece of text and checks it
 * against an explicit set of facts. Text with even one unknown figure is
 * rejected (the caller retries once, then falls back to deterministic text).
 */
import type { ISODate, Minor } from './contract.ts';
import { isISODate } from './dates.ts';
import { parseHumanAmount } from './money.ts';

export interface Facts {
  amountsMinor: Set<Minor>;
  dates: Set<ISODate>;
  /** Invoice ids and invoice numbers, upper-cased. */
  ids: Set<string>;
  /** Day counts, item counts, ordinals: any bare number the text may use. */
  numbers: Set<number>;
  /** Status words the text may use, lower-cased (see STATUS_WORDS). */
  statuses: Set<string>;
  emails: Set<string>;
  /**
   * Known proper names (project, client, milestone titles). They are removed
   * before checking so a title like "Phase 2" is not read as the number 2.
   */
  names: Set<string>;
}

export function emptyFacts(): Facts {
  return { amountsMinor: new Set(), dates: new Set(), ids: new Set(), numbers: new Set(), statuses: new Set(), emails: new Set(), names: new Set() };
}

export type ViolationKind = 'amount' | 'date' | 'id' | 'number' | 'status' | 'email';
export interface Violation {
  kind: ViolationKind;
  text: string;
}

/**
 * Status vocabulary that is checked. A word from this list must be in `facts.statuses`.
 * The first group only ever means a payment status, so it is checked wherever it appears.
 * The second group is also everyday English ("a reminder draft", "nothing will be sent",
 * "delivery is now scheduled for Nov 6"), so it is checked only where it is stated as a
 * status: after is / was / remains / marked as / status.
 */
export const STATUS_WORDS = ['paid', 'unpaid', 'overdue', 'cancelled', 'canceled', 'refunded'] as const;
export const STATUS_WORDS_IN_CONTEXT = ['sent', 'draft', 'scheduled', 'pending'] as const;
const STATUS_CLAIM = new RegExp(
  `\\b(?:is|was|are|were|been|remains?|stays?|as|status:?)\\s+(?:(?:still|now|already|currently|a)\\s+)?(${STATUS_WORDS_IN_CONTEXT.join('|')})\\b(?!\\s+(?:for|to|on|by|through)\\b)`,
  'gi',
);

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_ALT = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100, thousand: 1000,
};

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Return every figure in `text` that is not backed by `facts`.
 * An empty array means the text states nothing the system does not already know.
 */
export function checkProse(text: string, facts: Facts): Violation[] {
  const violations: Violation[] = [];
  let rest = text;
  /** Run `re` over what is left, call `visit` per match, then blank the matches out. */
  const consume = (re: RegExp, visit: (m: RegExpMatchArray) => void): void => {
    for (const m of rest.matchAll(re)) visit(m);
    rest = rest.replace(re, (s) => ' '.repeat(s.length));
  };

  // 0. Known names, longest first, so figures inside a title are not treated as claims.
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of [...facts.names].filter((n) => n.trim().length > 1).sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(escape(name), 'gi'), (s) => ' '.repeat(s.length));
  }

  // 1. Emails (before anything else: they contain digits and dots).
  consume(/[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/gi, (m) => {
    if (!facts.emails.has(m[0].toLowerCase())) violations.push({ kind: 'email', text: m[0] });
  });

  // 2. Invoice ids and numbers: PayPal ids (INV2-XXXX-…) and prefixed numbers (PL-AB12-003, INV-0001, #0042).
  consume(/\b[A-Z][A-Z0-9]{1,5}(?:-[A-Z0-9]{2,})+\b|#\d{2,}/g, (m) => {
    const id = m[0].replace(/^#/, '').toUpperCase();
    if (!facts.ids.has(id)) violations.push({ kind: 'id', text: m[0] });
  });

  // 3. ISO dates.
  consume(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => {
    if (!isISODate(m[0]) || !facts.dates.has(m[0])) violations.push({ kind: 'date', text: m[0] });
  });

  // 4. Written dates: "Oct 14", "October 14th, 2026", "14 Oct 2026".
  const monthDays = new Set([...facts.dates].map((d) => d.slice(5)));
  const checkWritten = (raw: string, month: string, day: string, year?: string): void => {
    const md = `${pad(MONTHS[month.toLowerCase()] ?? 0)}-${pad(Number(day))}`;
    const ok = year ? facts.dates.has(`${year}-${md}`) : monthDays.has(md);
    if (!ok) violations.push({ kind: 'date', text: raw.trim() });
  };
  consume(new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'), (m) => checkWritten(m[0], m[1]!, m[2]!, m[3]));
  consume(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi'), (m) => checkWritten(m[0], m[2]!, m[1]!, m[3]));

  // 5. Numeric dates: 10/14, 10/14/2026.
  consume(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => {
    const md = `${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
    const year = m[3] ? (m[3].length === 2 ? `20${m[3]}` : m[3]) : undefined;
    const ok = year ? facts.dates.has(`${year}-${md}`) : monthDays.has(md);
    if (!ok) violations.push({ kind: 'date', text: m[0] });
  });

  // 6. Money: "$1,200", "$1,200.00", "USD 300", "1,200 USD", "$1.2k".
  const money = (raw: string): void => {
    const v = parseHumanAmount(raw.replace(/\s?(USD|EUR|GBP|CAD|AUD|dollars|euros|pounds)\b/gi, '').replace(/^(USD|EUR|GBP|CAD|AUD|CA\$|A\$)\s?/i, ''));
    if (v === null || !facts.amountsMinor.has(v)) violations.push({ kind: 'amount', text: raw.trim() });
  };
  consume(/(?:CA\$|A\$|[$€£]|\b(?:USD|EUR|GBP|CAD|AUD)\s?)\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s?[kK]?\b/g, (m) => money(m[0]));
  consume(/\b(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s?[kK]?\s?(?:USD|EUR|GBP|CAD|AUD|dollars|euros|pounds)\b/gi, (m) => money(m[0]));

  // 7. Any number that is left: day counts, item counts, ordinals, percentages.
  consume(/\b\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?\b/g, (m) => {
    const n = Number(m[0].replace(/,/g, '').replace(/(st|nd|rd|th)$/i, ''));
    if (!Number.isFinite(n) || !facts.numbers.has(n)) violations.push({ kind: 'number', text: m[0] });
  });

  // 8. Numbers written as words ("three days"). "one"/"a" are left alone: too common as pronouns.
  consume(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'gi'), (m) => {
    const n = NUMBER_WORDS[m[1]!.toLowerCase()]!;
    if (!facts.numbers.has(n)) violations.push({ kind: 'number', text: m[0] });
  });

  // 9. Status vocabulary.
  consume(new RegExp(`\\b(${STATUS_WORDS.join('|')})\\b`, 'gi'), (m) => {
    const w = m[1]!.toLowerCase().replace('canceled', 'cancelled');
    if (!facts.statuses.has(w)) violations.push({ kind: 'status', text: m[0] });
  });
  consume(STATUS_CLAIM, (m) => {
    if (!facts.statuses.has(m[1]!.toLowerCase())) violations.push({ kind: 'status', text: m[1]! });
  });

  return violations;
}

export function describeViolations(v: Violation[]): string {
  return v.map((x) => `${x.kind} "${x.text}"`).join(', ');
}

/** Merge fact sets (later sets only add). */
export function mergeFacts(...all: Partial<Facts>[]): Facts {
  const out = emptyFacts();
  for (const f of all) {
    f.amountsMinor?.forEach((x) => out.amountsMinor.add(x));
    f.dates?.forEach((x) => out.dates.add(x));
    f.ids?.forEach((x) => out.ids.add(x.toUpperCase()));
    f.numbers?.forEach((x) => out.numbers.add(x));
    f.statuses?.forEach((x) => out.statuses.add(x.toLowerCase()));
    f.emails?.forEach((x) => out.emails.add(x.toLowerCase()));
    f.names?.forEach((x) => out.names.add(x));
  }
  return out;
}
