import { describe, expect, it, vi } from 'vitest';
import { invoiceIdFromEvent, parseInvoice, PayPalError } from '../shared/paypal/gateway.ts';
import { crc32 } from '../shared/paypal/simulator.ts';
import { handleWebhook, WEBHOOK_MAX_BYTES } from '../shared/webhook.ts';
import { activeProject, harness } from './helpers.ts';

async function sentInvoice() {
  const { h, projectId } = await activeProject(harness());
  await h.approveNext();
  const invoice = h.ws.data.invoices[0]!;
  const deps = { gateway: h.gateway, seen: h.seen, route: (id: string) => (h.ws.ownsInvoice(id) ? h.ws : undefined) };
  return { h, projectId, invoice, deps };
}

describe('webhook signature verification', () => {
  it('a correctly signed delivery is applied', async () => {
    const { h, invoice, deps } = await sentInvoice();
    const signed = await h.sim.pay(invoice.id);
    expect(await handleWebhook(deps, signed.headers, signed.rawBody)).toEqual({ status: 200, outcome: 'applied' });
    expect(h.ws.data.invoices[0]!.status).toBe('PAID');
  });

  it.each([
    ['a tampered body', (s: { headers: Record<string, string>; rawBody: string }) => ({ ...s, rawBody: s.rawBody.replace('PAID', 'PAID ') })],
    ['a re-serialised body', (s) => ({ ...s, rawBody: JSON.stringify(JSON.parse(s.rawBody), null, 1) })],
    ['a forged signature', (s) => ({ ...s, headers: { ...s.headers, 'paypal-transmission-sig': 'AAAA' + s.headers['paypal-transmission-sig']!.slice(4) } })],
    ['a missing signature', (s) => { const { ['paypal-transmission-sig']: _drop, ...rest } = s.headers; return { ...s, headers: rest }; }],
    ['a replayed signature with a new transmission id', (s) => ({ ...s, headers: { ...s.headers, 'paypal-transmission-id': 'sim-other' } })],
    ['a changed transmission time', (s) => ({ ...s, headers: { ...s.headers, 'paypal-transmission-time': '2026-10-06T00:00:00.000Z' } })],
    ['no PayPal headers at all', (s) => ({ ...s, headers: { 'content-type': 'application/json' } })],
  ] as [string, (s: { headers: Record<string, string>; rawBody: string }) => { headers: Record<string, string>; rawBody: string }][])('%s is rejected and changes nothing', async (_n, mutate) => {
    const { h, invoice, deps } = await sentInvoice();
    const signed = mutate(await h.sim.pay(invoice.id));
    const apply = vi.spyOn(h.ws, 'onInvoiceEvent');
    const res = await handleWebhook(deps, signed.headers, signed.rawBody);
    expect(res).toEqual({ status: 401, outcome: 'rejected', reason: 'signature_invalid' });
    expect(apply).not.toHaveBeenCalled();
    expect(h.ws.data.invoices[0]!.status).toBe('SENT');
    expect(h.ws.data.projects[0]!.schedule.items[1]!.workState).toBe('blocked');
    expect(h.seen.size).toBe(0);
  });

  it('a delivery signed by a different workspace\'s simulator is rejected', async () => {
    const a = await sentInvoice();
    const b = await sentInvoice();
    const signedByB = await b.h.sim.pay(b.invoice.id);
    expect((await handleWebhook(a.deps, signedByB.headers, signedByB.rawBody)).status).toBe(401);
  });

  it('header names are matched case-insensitively', async () => {
    const { h, invoice, deps } = await sentInvoice();
    const signed = await h.sim.pay(invoice.id);
    const upper = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toUpperCase(), v]));
    expect((await handleWebhook(deps, upper, signed.rawBody)).outcome).toBe('applied');
  });

  it('if the verifier cannot be reached the event is neither trusted nor dropped', async () => {
    const { h, invoice, deps } = await sentInvoice();
    const signed = await h.sim.pay(invoice.id);
    const res = await handleWebhook({ ...deps, gateway: { verifyWebhook: async () => { throw new Error('ECONNRESET'); } } }, signed.headers, signed.rawBody);
    expect(res).toEqual({ status: 500, outcome: 'failed', reason: 'verification_unavailable' });
    expect(h.ws.data.invoices[0]!.status).toBe('SENT');
    expect(h.seen.size).toBe(0);
  });

  it('oversized bodies are refused before verification', async () => {
    const { deps } = await sentInvoice();
    const verify = vi.fn();
    const res = await handleWebhook({ ...deps, gateway: { verifyWebhook: verify } }, {}, 'x'.repeat(WEBHOOK_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });

  it('crc32 matches the reference value', () => {
    expect(crc32('123456789')).toBe(0xcbf43926);
    expect(crc32('')).toBe(0);
  });
});

describe('webhook idempotency', () => {
  it('the same delivery twice is applied once', async () => {
    const { h, invoice, deps } = await sentInvoice();
    const signed = await h.sim.pay(invoice.id);
    const apply = vi.spyOn(h.ws, 'onInvoiceEvent');
    expect((await handleWebhook(deps, signed.headers, signed.rawBody)).outcome).toBe('applied');
    const runs = h.ws.data.runs.length;
    const logs = h.ws.data.log.length;
    const change = h.ws.data.lastChange!.id;
    expect(await handleWebhook(deps, signed.headers, signed.rawBody)).toEqual({ status: 200, outcome: 'duplicate' });
    expect(await handleWebhook(deps, signed.headers, signed.rawBody)).toEqual({ status: 200, outcome: 'duplicate' });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(h.ws.data.runs).toHaveLength(runs);
    expect(h.ws.data.log).toHaveLength(logs);
    expect(h.ws.data.lastChange!.id).toBe(change);
  });

  it('two concurrent deliveries of one event are applied once', async () => {
    const { h, invoice, deps } = await sentInvoice();
    const signed = await h.sim.pay(invoice.id);
    const apply = vi.spyOn(h.ws, 'onInvoiceEvent');
    const results = await Promise.all([1, 2, 3].map(() => handleWebhook(deps, signed.headers, signed.rawBody)));
    expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'duplicate', 'duplicate']);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(h.ws.data.runs.filter((r) => r.kind === 'payment')).toHaveLength(1);
  });

  it('a second, different event for an already-paid invoice changes nothing', async () => {
    const { h, invoice, deps } = await sentInvoice();
    const first = await h.sim.pay(invoice.id);
    await handleWebhook(deps, first.headers, first.rawBody);
    const again = await h.sim.sign(h.sim.event('INVOICING.INVOICE.PAID', h.sim.state.invoices[invoice.id]!, 'duplicate notification, new event id'));
    expect((await handleWebhook(deps, again.headers, again.rawBody)).outcome).toBe('applied');
    expect(h.ws.data.runs.filter((r) => r.kind === 'payment')).toHaveLength(1);
    expect(h.ws.data.projects[0]!.schedule.items[1]!.workStart).toBe('2026-10-06');
  });

  it('an event is only recorded as processed after it was applied', async () => {
    const { h, invoice, deps } = await sentInvoice();
    const signed = await h.sim.pay(invoice.id);
    const target = { onInvoiceEvent: vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation((id: string, t: string) => h.ws.onInvoiceEvent(id, t)) };
    const failing = { ...deps, route: () => target };
    expect(await handleWebhook(failing, signed.headers, signed.rawBody)).toEqual({ status: 500, outcome: 'failed', reason: 'apply_failed' });
    expect(h.seen.size).toBe(0);
    expect((await handleWebhook(failing, signed.headers, signed.rawBody)).outcome).toBe('applied'); // PayPal's retry
    expect(h.seen.size).toBe(1);
  });

  it('events for invoices we do not own, or of other types, are acknowledged and ignored', async () => {
    const { h, deps } = await sentInvoice();
    const foreign = await h.sim.sign({ id: 'WH-SIM-FOREIGN00000001', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-AAAA-BBBB-CCCC-DDDD' } } });
    expect(await handleWebhook(deps, foreign.headers, foreign.rawBody)).toEqual({ status: 200, outcome: 'ignored', reason: 'unknown_invoice' });
    const other = await h.sim.sign({ id: 'WH-SIM-OTHER0000000001', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'x' } });
    expect(await handleWebhook(deps, other.headers, other.rawBody)).toEqual({ status: 200, outcome: 'ignored', reason: 'event_type_not_handled' });
    const junk = await h.sim.sign({ id: 'short', event_type: 'INVOICING.INVOICE.PAID' });
    expect((await handleWebhook(deps, junk.headers, junk.rawBody)).status).toBe(400);
  });

  it('figures come from re-reading the invoice, not from the webhook payload', async () => {
    const { h, invoice, deps } = await sentInvoice();
    // A validly signed event that lies about the amount and claims PAID while PayPal still says SENT.
    const lie = await h.sim.sign({ id: 'WH-SIM-LIE000000000001', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoice.id, status: 'PAID', amount: { currency_code: 'USD', value: '1.00' } } } });
    expect((await handleWebhook(deps, lie.headers, lie.rawBody)).outcome).toBe('applied');
    expect(h.ws.data.invoices[0]).toMatchObject({ status: 'SENT', amountMinor: 300_000 });
    expect(h.ws.data.projects[0]!.schedule.items[1]!.workState).toBe('blocked');
  });
});

describe('PayPal JSON parsing', () => {
  const base = {
    id: 'INV2-Z56S-5LLA-Q52L-CPZ5', status: 'SENT',
    detail: { invoice_number: 'PL-AB12-001', reference: 'r', invoice_date: '2026-10-05', currency_code: 'USD', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-12' }, metadata: { recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#Z56S5LLAQ52LCPZ5' } },
    amount: { currency_code: 'USD', value: '3000.00' }, due_amount: { currency_code: 'USD', value: '3000.00' },
  };

  it('reads the fields Paceline uses', () => {
    expect(parseInvoice(base)).toMatchObject({ id: base.id, number: 'PL-AB12-001', status: 'SENT', amountMinor: 300_000, dueAmountMinor: 300_000, invoiceDate: '2026-10-05', dueDate: '2026-10-12', payments: [], payerViewUrl: base.detail.metadata.recipient_view_url });
  });

  it('reads payments and derives the paid date', () => {
    const paid = { ...base, status: 'PAID', due_amount: { currency_code: 'USD', value: '0.00' }, payments: { paid_amount: { currency_code: 'USD', value: '3000.00' }, transactions: [{ type: 'PAYPAL', payment_id: '5XJ12345AB678901C', payment_date: '2026-10-07', method: 'PAYPAL', amount: { currency_code: 'USD', value: '3000.00' } }] } };
    expect(parseInvoice(paid)).toMatchObject({ status: 'PAID', paidOn: '2026-10-07', dueAmountMinor: 0, payments: [{ id: '5XJ12345AB678901C', amountMinor: 300_000 }] });
  });

  it('DUE_ON_RECEIPT has no due_date: due on the invoice date', () => {
    expect(parseInvoice({ ...base, detail: { ...base.detail, payment_term: { term_type: 'DUE_ON_RECEIPT' } } }).dueDate).toBe('2026-10-05');
  });

  it.each([
    ['an unknown status', { ...base, status: 'OVERDUE' }],
    ['a missing id', { ...base, id: undefined }],
    ['a malformed amount', { ...base, amount: { currency_code: 'USD', value: '3,000' } }],
    ['a missing amount', { ...base, amount: undefined }],
    ['an unsupported currency', { ...base, detail: { ...base.detail, currency_code: 'JPY' } }],
    ['a missing invoice date', { ...base, detail: { ...base.detail, invoice_date: undefined } }],
  ])('throws on %s rather than guessing', (_n, json) => expect(() => parseInvoice(json as never)).toThrow(PayPalError));

  it('finds the invoice id in both event shapes and rejects junk', () => {
    expect(invoiceIdFromEvent({ id: 'e', event_type: 't', resource: { invoice: { id: 'INV2-AAAA-BBBB-CCCC-DDDD' } } })).toBe('INV2-AAAA-BBBB-CCCC-DDDD');
    expect(invoiceIdFromEvent({ id: 'e', event_type: 't', resource: { id: 'INV2-AAAA-BBBB-CCCC-DDDD' } })).toBe('INV2-AAAA-BBBB-CCCC-DDDD');
    expect(invoiceIdFromEvent({ id: 'e', event_type: 't', resource: { invoice: { id: '../../etc/passwd' } } })).toBeUndefined();
    expect(invoiceIdFromEvent({ id: 'e', event_type: 't' })).toBeUndefined();
  });
});
