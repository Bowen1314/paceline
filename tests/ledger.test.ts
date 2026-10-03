import { describe, expect, it } from 'vitest';
import type { LedgerRow } from '../shared/contract.ts';
import { applyIntent, buildLedgerRows, ledgerStatus, parseLedgerQuery } from '../shared/ledger.ts';
import { sandboxPayerUrl } from '../shared/paypal/gateway.ts';
import { loadSampleWorkspace } from '../shared/sample.ts';
import { harness } from './helpers.ts';

const ctx = { today: '2026-10-05', clients: ['Northwind Outfitters', 'Harbor Coffee Roasters'], projects: ['Storefront redesign', 'Loyalty app prototype'] };
const q = (text: string) => parseLedgerQuery(text, ctx);

async function sampleRows(): Promise<LedgerRow[]> {
  const h = harness();
  await loadSampleWorkspace(h.ws, { gateway: h.gateway, seen: h.seen });
  return buildLedgerRows(h.ws.data.projects, h.ws.data.invoices, h.ws.today());
}

describe('natural-language ledger queries (rule-based)', () => {
  it('"overdue over $500"', () => {
    const r = q('overdue over $500');
    expect(r.understood).toBe(true);
    expect(r.intent.filters).toEqual([{ column: 'status', op: 'in', values: ['overdue'] }, { column: 'amountMinor', op: 'gt', value: 50_000 }]);
    expect(r.explanation).toBe('Showing status overdue, amount over $500.');
  });

  it('"group by client"', () => {
    expect(q('group by client').intent).toMatchObject({ groupBy: ['client'], filters: [] });
    expect(q('totals per client').intent.groupBy).toEqual(['client']);
    expect(q('group by client then status').intent.groupBy).toEqual(['client', 'status']);
    expect(q('sort by client').intent).toMatchObject({ groupBy: [], sort: [{ column: 'client', dir: 'asc' }] });
    expect(q('overdue over $500 grouped by client').intent).toMatchObject({ groupBy: ['client'] });
  });

  it.each([
    ['unpaid invoices', ['awaiting', 'overdue']],
    ['what is still outstanding?', ['awaiting', 'overdue']],
    ['paid', ['paid']],
    ['show planned', ['planned']],
    ['cancelled or refunded', ['cancelled', 'refunded']],
  ])('%s -> status %j', (text, statuses) => {
    expect(q(text).intent.filters[0]).toEqual({ column: 'status', op: 'in', values: statuses });
  });

  it.each([
    ['under 2k', 'lt', 200_000],
    ['at least $1,250.50', 'gte', 125_050],
    ['more than 3000', 'gt', 300_000],
    ['at most $900', 'lte', 90_000],
  ])('%s', (text, op, value) => expect(q(text).intent.filters).toContainEqual({ column: 'amountMinor', op, value }));

  it('date ranges are relative to the workspace clock', () => {
    expect(q('due this week').intent.filters).toEqual([{ column: 'dueOn', op: 'between', from: '2026-10-05', to: '2026-10-11' }]);
    expect(q('due next week').intent.filters).toEqual([{ column: 'dueOn', op: 'between', from: '2026-10-12', to: '2026-10-18' }]);
    expect(q('paid this month').intent.filters).toEqual([{ column: 'status', op: 'in', values: ['paid'] }, { column: 'paidOn', op: 'between', from: '2026-10-01', to: '2026-10-31' }]);
    expect(q('paid last month').intent.filters[1]).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('recognises known client names and sorting', () => {
    const r = q('Northwind Outfitters invoices sorted by amount');
    expect(r.intent.filters).toEqual([{ column: 'client', op: 'contains', value: 'Northwind Outfitters' }]);
    expect(r.intent.sort).toEqual([{ column: 'amountMinor', dir: 'desc' }]);
    expect(q('sort by due date ascending').intent.sort).toEqual([{ column: 'dueOn', dir: 'asc' }]);
    expect(q('largest first').intent.sort).toEqual([{ column: 'amountMinor', dir: 'desc' }]);
  });

  it('"more than 5 days overdue" filters on days, not dollars', () => {
    const r = q('more than 5 days overdue');
    expect(r.intent.filters).toEqual([{ column: 'daysPastDue', op: 'gt', value: 5 }, { column: 'status', op: 'in', values: ['overdue'] }]);
  });

  it('clears', () => {
    expect(q('clear').intent).toEqual({ filters: [], groupBy: [], sort: [], reset: true });
    expect(q('show everything').explanation).toMatch(/Cleared/);
  });

  it('admits when it does not understand instead of guessing', () => {
    const r = q('make it pop');
    expect(r.understood).toBe(false);
    expect(r.intent.filters).toEqual([]);
  });
});

describe('ledger rows', () => {
  it('maps PayPal statuses to ledger statuses', () => {
    expect(ledgerStatus('SENT', false)).toBe('awaiting');
    expect(ledgerStatus('SENT', true)).toBe('overdue');
    expect(ledgerStatus('PAID', false)).toBe('paid');
    expect(ledgerStatus('MARKED_AS_PAID', false)).toBe('paid');
    expect(ledgerStatus('CANCELLED', false)).toBe('cancelled');
    expect(ledgerStatus('REFUNDED', false)).toBe('refunded');
    expect(ledgerStatus('DRAFT', false)).toBe('draft');
  });

  it('one row per invoice plus one planned row per uninvoiced milestone; totals reconcile with the plans', async () => {
    const rows = await sampleRows();
    expect(rows).toHaveLength(7);
    const total = rows.reduce((s, r) => s + r.amountMinor, 0);
    expect(total).toBe(1_800_000 + 840_000);
    const paid = rows.filter((r) => r.status === 'paid');
    expect(paid.every((r) => r.balanceMinor === 0 && r.paidMinor === r.amountMinor && r.paymentId?.startsWith('SIM'))).toBe(true);
    const overdue = rows.find((r) => r.status === 'overdue')!;
    expect(overdue).toMatchObject({ client: 'Harbor Coffee Roasters', balanceMinor: 240_000, daysPastDue: 4 });
  });

  it('intents filter and sort the sample rows as stated', async () => {
    const rows = await sampleRows();
    expect(applyIntent(rows, q('overdue over $500').intent).map((r) => r.client)).toEqual(['Harbor Coffee Roasters']);
    expect(applyIntent(rows, q('overdue over $5,000').intent)).toEqual([]);
    expect(applyIntent(rows, q('paid, largest first').intent).map((r) => r.amountMinor)).toEqual([450_000, 450_000]);
    expect(applyIntent(rows, q('Northwind Outfitters planned').intent)).toHaveLength(2);
  });

  it('offers a payer link only for open sandbox invoices on sandbox.paypal.com', async () => {
    expect(sandboxPayerUrl('https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA-BBBB')).toBe('https://www.sandbox.paypal.com/invoice/p/#INV2-AAAA-BBBB');
    expect(sandboxPayerUrl('https://www.paypal.com/invoice/p/#INV2-AAAA-BBBB')).toBeUndefined(); // live site
    expect(sandboxPayerUrl('http://www.sandbox.paypal.com/invoice/p/')).toBeUndefined();
    expect(sandboxPayerUrl('https://www.sandbox.paypal.com.evil.example/x')).toBeUndefined();
    expect(sandboxPayerUrl('https://user:pw@www.sandbox.paypal.com/x')).toBeUndefined();
    expect(sandboxPayerUrl('javascript:alert(1)')).toBeUndefined();
    expect(sandboxPayerUrl(undefined)).toBeUndefined();

    // Simulator invoices never get a link, even if a URL were present.
    const rows = await sampleRows();
    expect(rows.every((r) => r.payerViewUrl === undefined)).toBe(true);

    const h = harness();
    await loadSampleWorkspace(h.ws, { gateway: h.gateway, seen: h.seen });
    const url = 'https://www.sandbox.paypal.com/invoice/p/#INV2-TEST';
    const invoices = h.ws.data.invoices.map((i) => ({ ...i, source: 'sandbox' as const, payerViewUrl: url }));
    const sandboxRows = buildLedgerRows(h.ws.data.projects, invoices, h.ws.today());
    for (const r of sandboxRows) expect(r.payerViewUrl).toBe(r.status === 'awaiting' || r.status === 'overdue' ? url : undefined);
    expect(sandboxRows.some((r) => r.payerViewUrl)).toBe(true);
  });

  it('handles the brief\'s own examples, punctuation included', () => {
    const ctx = { today: '2026-10-05', clients: ['Harbor Coffee', 'Northwind Outfitters'], projects: [] };
    const a = parseLedgerQuery('overdue over $500, group by client', ctx).intent;
    expect(a.filters).toEqual([{ column: 'status', op: 'in', values: ['overdue'] }, { column: 'amountMinor', op: 'gt', value: 50000 }]);
    expect(a.groupBy).toEqual(['client']);
    expect(parseLedgerQuery('invoices over $2,000 for Harbor', ctx).intent.filters).toEqual([
      { column: 'amountMinor', op: 'gt', value: 200000 }, { column: 'client', op: 'contains', value: 'Harbor Coffee' },
    ]);
    expect(parseLedgerQuery('northwind unpaid', ctx).intent.filters.at(-1)).toEqual({ column: 'client', op: 'contains', value: 'Northwind Outfitters' });
  });
});
