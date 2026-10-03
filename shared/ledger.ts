/**
 * Ledger rows and the rule-based natural-language ledger query.
 *
 * `buildLedgerRows` is the single source of what the grid shows: one row per
 * PayPal invoice plus one "planned" row per approved milestone that has no
 * invoice yet. `parseLedgerQuery` turns phrases such as "overdue over $500
 * grouped by client" into a typed `LedgerIntent` without a model; the server
 * uses it when no model key is set and as the fallback when the model's answer
 * fails validation.
 */
import type { ISODate, Invoice, LedgerColumn, LedgerFilter, LedgerIntent, LedgerRow, LedgerStatus, PayPalInvoiceStatus, Project } from './contract.ts';
import { addDays, diffDays, weekday } from './dates.ts';
import { formatMoney, parseHumanAmount } from './money.ts';
import { sandboxPayerUrl } from './paypal/gateway.ts';
import { isDead, isSettled } from './schedule.ts';

export function ledgerStatus(status: PayPalInvoiceStatus, overdue: boolean): LedgerStatus {
  if (isSettled(status)) return 'paid';
  if (status === 'CANCELLED' || status === 'AUTO_CANCELLED') return 'cancelled';
  if (isDead(status)) return 'refunded';
  if (status === 'DRAFT') return 'draft';
  return overdue ? 'overdue' : 'awaiting';
}

export function buildLedgerRows(projects: Project[], invoices: Invoice[], today: ISODate): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  for (const inv of invoices) {
    const project = byId.get(inv.projectId);
    if (!project) continue;
    const m = project.plan.milestones.find((x) => x.id === inv.milestoneId);
    const status = ledgerStatus(inv.status, inv.overdue);
    const paid = inv.payments.reduce((s, p) => s + p.amountMinor, 0);
    const open = status === 'awaiting' || status === 'overdue';
    const last = inv.payments.at(-1);
    rows.push({
      rowId: inv.id,
      kind: 'invoice',
      invoiceId: inv.id,
      number: inv.number,
      client: project.plan.client.name,
      project: project.plan.title,
      projectId: project.id,
      milestone: m?.title ?? inv.milestoneId,
      milestoneId: inv.milestoneId,
      status,
      paypalStatus: inv.status,
      currency: inv.currency,
      amountMinor: inv.amountMinor,
      paidMinor: paid,
      balanceMinor: open ? inv.dueAmountMinor : 0,
      issuedOn: inv.invoiceDate,
      dueOn: inv.dueDate,
      paidOn: inv.paidOn,
      daysPastDue: open ? diffDays(inv.dueDate, today) : undefined,
      paymentId: last?.id,
      paymentMethod: last?.method,
      remindersSent: inv.remindersSent,
      payerViewUrl: open && inv.source === 'sandbox' ? sandboxPayerUrl(inv.payerViewUrl) : undefined,
    });
  }
  for (const project of projects) {
    if (project.status === 'draft') continue;
    for (const item of project.schedule.items) {
      const invoiceId = project.progress[item.milestoneId]?.invoiceId;
      if (invoiceId && invoices.some((i) => i.id === invoiceId)) continue;
      const m = project.plan.milestones.find((x) => x.id === item.milestoneId)!;
      rows.push({
        rowId: `planned:${project.id}:${m.id}`,
        kind: 'planned',
        number: '—',
        client: project.plan.client.name,
        project: project.plan.title,
        projectId: project.id,
        milestone: m.title,
        milestoneId: m.id,
        status: 'planned',
        currency: project.plan.currency,
        amountMinor: m.amountMinor,
        paidMinor: 0,
        balanceMinor: 0,
        dueOn: item.dueOn,
        remindersSent: 0,
      });
    }
  }
  return rows;
}

export interface LedgerQueryContext {
  today: ISODate;
  /** Known client and project names, so "for Northwind" can be recognised. */
  clients: string[];
  projects: string[];
}

export interface ParsedLedgerQuery {
  intent: LedgerIntent;
  understood: boolean;
  explanation: string;
}

const COLUMN_WORDS: [RegExp, LedgerColumn, string][] = [
  [/\bclients?\b|\bcustomers?\b/, 'client', 'client'],
  [/\bprojects?\b/, 'project', 'project'],
  [/\bstatus(?:es)?\b/, 'status', 'status'],
  [/\bmilestones?\b/, 'milestone', 'milestone'],
  [/\bbalance\b|\boutstanding amount\b/, 'balanceMinor', 'balance'],
  [/\bamounts?\b|\bvalue\b|\bsize\b/, 'amountMinor', 'amount'],
  [/\bdue(?: date)?\b/, 'dueOn', 'due date'],
  [/\bpaid(?: date| on)?\b/, 'paidOn', 'paid date'],
  [/\bissued?(?: date)?\b|\binvoice date\b/, 'issuedOn', 'issue date'],
  [/\bnumber\b/, 'number', 'invoice number'],
];

function columnIn(text: string): [LedgerColumn, string] | null {
  for (const [re, col, label] of COLUMN_WORDS) if (re.test(text)) return [col, label];
  return null;
}

function weekStart(d: ISODate): ISODate {
  return addDays(d, -((weekday(d) + 6) % 7));
}

export function parseLedgerQuery(query: string, ctx: LedgerQueryContext): ParsedLedgerQuery {
  const q = ` ${query.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const filters: LedgerFilter[] = [];
  const groupBy: LedgerColumn[] = [];
  const sort: LedgerIntent['sort'] = [];
  const said: string[] = [];
  let reset = false;

  if (/\b(clear|reset|show (?:me )?(?:all|everything)|all invoices|start over|remove (?:all )?filters?)\b/.test(q)) {
    reset = true;
  }

  // Group by
  const GROUPABLE = '(?:client|customer|project|status|milestone)s?';
  const g = new RegExp(`\\b(?:(?:group(?:ed)?|grouping|bucket(?:ed)?|break(?:down| down)?|split|roll(?:ed)? up|totals?|subtotals?) )?(?<!\\b(?:sort|sorted|order|ordered|rank|ranked) )(?:by|per) (${GROUPABLE}(?:(?:, | and | then | & )(?:by )?${GROUPABLE})*)\\b`).exec(q);
  if (g) {
    for (const part of g[1]!.split(/ and |, | then | & /)) {
      const col = columnIn(` ${part} `);
      if (col && ['client', 'project', 'status', 'milestone'].includes(col[0]) && !groupBy.includes(col[0])) groupBy.push(col[0]);
    }
    if (groupBy.length) said.push(`grouped by ${groupBy.map((c) => COLUMN_WORDS.find((w) => w[1] === c)![2]).join(' then ')}`);
  }

  // Status
  const statuses = new Set<LedgerStatus>();
  if (/\b(overdue|late|past due|behind)\b/.test(q) && !/\bdays? (overdue|late)\b/.test(q)) statuses.add('overdue');
  if (/\b(unpaid|outstanding|open|owed|awaiting|waiting|not paid|pending)\b/.test(q)) { statuses.add('awaiting'); statuses.add('overdue'); }
  else if (/\bpaid\b|\bsettled\b|\bcollected\b|\breceived\b/.test(q) && !/\bsort(?:ed)? by paid\b/.test(q)) statuses.add('paid');
  if (/\b(planned|upcoming|not (?:yet )?invoiced|future|scheduled)\b/.test(q)) statuses.add('planned');
  if (/\bcancell?ed\b/.test(q)) statuses.add('cancelled');
  if (/\brefunded\b/.test(q)) statuses.add('refunded');
  if (/\bdrafts?\b/.test(q)) statuses.add('draft');
  if (statuses.size) {
    filters.push({ column: 'status', op: 'in', values: [...statuses] });
    said.push(`status ${[...statuses].join(' or ')}`);
  }

  // Days overdue: "more than 5 days overdue"
  const dOver = /\b(?:more than|over|at least|>=?)\s*(\d+)\s*days? (?:overdue|late|past due)\b/.exec(q);
  if (dOver) {
    filters.push({ column: 'daysPastDue', op: 'gt', value: Number(dOver[1]) });
    if (!statuses.size) filters.push({ column: 'status', op: 'in', values: ['overdue'] });
    said.push(`more than ${dOver[1]} days overdue`);
  }

  // Amount comparisons
  const amountCol: 'amountMinor' | 'balanceMinor' = /\bbalance\b/.test(q) ? 'balanceMinor' : 'amountMinor';
  const cmp = (re: RegExp, op: 'gt' | 'lt' | 'gte' | 'lte', word: string): void => {
    const m = re.exec(q);
    if (!m) return;
    const v = parseHumanAmount(m[1]!.trim());
    if (v === null) return;
    filters.push({ column: amountCol, op, value: v });
    said.push(`${amountCol === 'balanceMinor' ? 'balance' : 'amount'} ${word} ${formatMoney(v)}`);
  };
  const AMT = '((?:[$€£]\\s?)?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d{1,2})?\\s?k?)(?! ?days?)';
  cmp(new RegExp(`\\b(?:over|above|more than|greater than|exceeding|bigger than|larger than|>)\\s*${AMT}`), 'gt', 'over');
  cmp(new RegExp(`\\b(?:at least|>=|minimum of|no less than)\\s*${AMT}`), 'gte', 'at least');
  cmp(new RegExp(`\\b(?:under|below|less than|smaller than|<)\\s*${AMT}`), 'lt', 'under');
  cmp(new RegExp(`\\b(?:at most|<=|up to|no more than)\\s*${AMT}`), 'lte', 'at most');

  // Dates: "due this week", "paid this month", "due next week"
  const dateCol: 'dueOn' | 'paidOn' | 'issuedOn' = /\bpaid (?:this|last|next)\b/.test(q) ? 'paidOn' : /\bissued (?:this|last|next)\b/.test(q) ? 'issuedOn' : 'dueOn';
  const range = /\b(this|next|last) (week|month)\b/.exec(q);
  if (range) {
    const t = ctx.today;
    let from: ISODate;
    let to: ISODate;
    if (range[2] === 'week') {
      const start = addDays(weekStart(t), range[1] === 'next' ? 7 : range[1] === 'last' ? -7 : 0);
      from = start;
      to = addDays(start, 6);
    } else {
      let y = Number(t.slice(0, 4));
      let mo = Number(t.slice(5, 7)) + (range[1] === 'next' ? 1 : range[1] === 'last' ? -1 : 0);
      if (mo > 12) { mo = 1; y++; }
      if (mo < 1) { mo = 12; y--; }
      const pad = (n: number): string => String(n).padStart(2, '0');
      from = `${y}-${pad(mo)}-01`;
      const nextMonth = mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`;
      to = addDays(nextMonth, -1);
    }
    filters.push({ column: dateCol, op: 'between', from, to });
    said.push(`${dateCol === 'dueOn' ? 'due' : dateCol === 'paidOn' ? 'paid' : 'issued'} ${range[1]} ${range[2]}`);
  }

  // Known names
  // A name matches in full, or by its first word ("Harbor" for "Harbor Coffee").
  const mentions = (name: string): boolean => {
    const lower = name.toLowerCase();
    if (q.includes(lower)) return true;
    const first = lower.split(/[^a-z0-9]+/).find((w) => w.length > 0) ?? '';
    return first.length >= 4 && new RegExp(`\\b${first}\\b`).test(q);
  };
  for (const name of ctx.clients) {
    if (name.length > 2 && mentions(name)) {
      filters.push({ column: 'client', op: 'contains', value: name });
      said.push(`client ${name}`);
      break;
    }
  }
  if (!filters.some((f) => f.column === 'client')) {
    for (const name of ctx.projects) {
      if (name.length > 2 && q.includes(name.toLowerCase())) {
        filters.push({ column: 'project', op: 'contains', value: name });
        said.push(`project ${name}`);
        break;
      }
    }
  }

  // Sort
  const s = /\b(?:sort(?:ed)?|order(?:ed)?|rank(?:ed)?) by\s+([a-z ]+?)(?:\s+(asc|ascending|desc|descending|low to high|high to low))?(?=,|$| and | then )/.exec(q);
  if (s) {
    const col = columnIn(` ${s[1]} `);
    if (col) {
      const dir = /desc|high to low/.test(s[2] ?? '') ? 'desc' : /asc|low to high/.test(s[2] ?? '') ? 'asc' : ['amountMinor', 'balanceMinor'].includes(col[0]) ? 'desc' : 'asc';
      sort.push({ column: col[0], dir });
      said.push(`sorted by ${col[1]} ${dir === 'desc' ? 'descending' : 'ascending'}`);
    }
  } else if (/\b(largest|biggest|highest)\b/.test(q)) {
    sort.push({ column: 'amountMinor', dir: 'desc' });
    said.push('largest first');
  } else if (/\b(smallest|lowest)\b/.test(q)) {
    sort.push({ column: 'amountMinor', dir: 'asc' });
    said.push('smallest first');
  } else if (/\b(oldest|earliest|soonest)\b/.test(q)) {
    sort.push({ column: 'dueOn', dir: 'asc' });
    said.push('earliest due first');
  } else if (/\b(newest|latest|most recent)\b/.test(q)) {
    sort.push({ column: 'dueOn', dir: 'desc' });
    said.push('latest due first');
  }

  const understood = reset || filters.length > 0 || groupBy.length > 0 || sort.length > 0;
  const explanation = !understood
    ? 'I could not turn that into a ledger view. Try "overdue over $500", "group by client" or "paid this month".'
    : said.length === 0
      ? 'Cleared all filters, grouping and sorting.'
      : `Showing ${said.join(', ')}.`;
  return { intent: { filters, groupBy, sort, reset: reset || understood }, understood, explanation };
}

/** Apply an intent to rows in plain JS (used by tests and by the fallback table). */
export function applyIntent(rows: LedgerRow[], intent: LedgerIntent): LedgerRow[] {
  let out = rows.filter((r) => intent.filters.every((f) => matches(r, f)));
  for (const s of [...intent.sort].reverse()) {
    out = [...out].sort((a, b) => {
      const x = a[s.column] ?? '';
      const y = b[s.column] ?? '';
      const c = x < y ? -1 : x > y ? 1 : 0;
      return s.dir === 'asc' ? c : -c;
    });
  }
  return out;
}

function matches(r: LedgerRow, f: LedgerFilter): boolean {
  switch (f.op) {
    case 'in': return f.values.includes(r.status);
    case 'contains': return String(r[f.column]).toLowerCase().includes(f.value.toLowerCase());
    case 'gt': case 'lt': case 'gte': case 'lte': case 'eq': {
      const v = r[f.column];
      if (v === undefined) return false;
      return f.op === 'gt' ? v > f.value : f.op === 'lt' ? v < f.value : f.op === 'gte' ? v >= f.value : f.op === 'lte' ? v <= f.value : v === f.value;
    }
    case 'before': case 'after': case 'between': {
      const v = r[f.column];
      if (!v) return false;
      if (f.op === 'before') return !!f.to && v < f.to;
      if (f.op === 'after') return !!f.from && v > f.from;
      return (!f.from || v >= f.from) && (!f.to || v <= f.to);
    }
  }
}
