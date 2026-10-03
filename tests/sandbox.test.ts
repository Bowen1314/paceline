/**
 * The real PayPal client against recorded responses. No network.
 *
 * The fixtures were first written from PayPal's Invoicing v2 OpenAPI document;
 * on 2026-10-02 every call was run against the real sandbox
 * (scripts/try-sandbox.ts) and the fixtures below were corrected to what it
 * actually returned: links on api.sandbox.paypal.com, an empty `invoicer`,
 * `amount.breakdown`, 202 + SCHEDULED for a future-dated invoice, and the 422
 * bodies for reminding or cancelling a scheduled invoice.
 */
import { describe, expect, it } from 'vitest';
import { SandboxGateway } from '../server/paypal/sandbox.ts';
import { PayPalError, type CreateInvoiceInput } from '../shared/paypal/gateway.ts';

interface Call { url: string; method: string; headers: Record<string, string>; body: string | undefined }
type Reply = { status: number; json?: unknown; text?: string } | ((call: Call) => { status: number; json?: unknown; text?: string });

function fake(replies: Record<string, Reply | Reply[]>): { calls: Call[]; fetch: (url: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  const counters: Record<string, number> = {};
  return {
    calls,
    fetch: async (url, init = {}) => {
      const u = new URL(url);
      const call: Call = { url, method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), body: init.body as string | undefined };
      calls.push(call);
      const key = `${call.method} ${u.pathname}`;
      const entry = replies[key];
      if (entry === undefined) throw new Error(`unexpected call ${key}`);
      const n = counters[key] ?? 0;
      counters[key] = n + 1;
      const pick = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)]! : entry;
      const r = typeof pick === 'function' ? pick(call) : pick;
      const body = r.status === 204 ? null : (r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json)));
      return new Response(body, { status: r.status, headers: { 'content-type': 'application/json' } });
    },
  };
}

const TOKEN = { status: 200, json: { scope: 'https://uri.paypal.com/services/invoicing', access_token: 'A21AAtoken1', token_type: 'Bearer', app_id: 'APP-80W284485P519543T', expires_in: 32400, nonce: 'n' } };

/** Shape of GET /v2/invoicing/invoices/{id} as the real sandbox returned it on 2026-10-02 (ids and names changed). */
const invoiceJson = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'INV2-Z56S-5LLA-Q52L-CPZ5',
  status,
  detail: {
    reference: 'paceline:ws:proj_1:m1', currency_code: 'USD', note: 'Thanks', category_code: 'SHIPPABLE', invoice_number: 'PL-AB12-001', invoice_date: '2026-10-05',
    payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-12' },
    viewed_by_recipient: false, group_draft: false,
    metadata: {
      create_time: '2026-10-05T14:02:11Z', last_update_time: '2026-10-05T14:02:11Z', created_by_flow: 'REGULAR_SINGLE',
      recipient_view_url: 'https://www.sandbox.paypal.com/invoice/p/#Z56S5LLAQ52LCPZ5', invoicer_view_url: 'https://www.sandbox.paypal.com/invoice/details/INV2-Z56S-5LLA-Q52L-CPZ5',
      caller_type: 'API_V2_INVOICE', spam_info: {},
    },
    archived: false,
  },
  invoicer: {},
  primary_recipients: [{ billing_info: { business_name: 'Juniper & Rye', email_address: 'buyer@example.com' } }],
  items: [{ id: 'ITEM-9VJ789179G9595918', name: 'Deposit', description: 'Kickoff deposit', quantity: '1', unit_amount: { currency_code: 'USD', value: '3000.00' }, unit_of_measure: 'AMOUNT' }],
  configuration: { tax_calculated_after_discount: true, tax_inclusive: false, allow_tip: false, allow_only_pay_by_bank: false, allow_vba_payments: false, save_item_for_future: true, template_id: 'TEMP-65501895SM1233141' },
  amount: {
    breakdown: { item_total: { currency_code: 'USD', value: '3000.00' }, discount: { invoice_discount: { amount: { currency_code: 'USD', value: '0.00' } }, item_discount: { currency_code: 'USD', value: '0.00' } }, tax_total: { currency_code: 'USD', value: '0.00' } },
    currency_code: 'USD', value: '3000.00',
  },
  due_amount: { currency_code: 'USD', value: status === 'PAID' || status === 'MARKED_AS_PAID' ? '0.00' : '3000.00' },
  links: [
    { href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5', rel: 'self', method: 'GET' },
    { href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/remind', rel: 'remind', method: 'POST' },
  ],
  unilateral: false,
  settings: {},
  ...extra,
});

const INPUT: CreateInvoiceInput = {
  requestId: 'prop_1-create', number: 'PL-AB12-001', reference: 'paceline:ws:proj_1:m1', currency: 'USD', recipientName: 'Juniper & Rye',
  recipientEmail: 'buyer@example.com', itemName: 'Deposit', itemDescription: 'Kickoff deposit', amountMinor: 300000, invoiceDate: '2026-10-05', dueDate: '2026-10-12', note: 'Thanks',
};

const gateway = (f: ReturnType<typeof fake>, now?: () => number): SandboxGateway =>
  new SandboxGateway({ clientId: 'client-id', clientSecret: 'client-secret', webhookId: '8PT597110X687430LKGECATA', fetch: f.fetch, now });

describe('SandboxGateway (recorded-shape responses, no network)', () => {
  it('fetches an OAuth token with client credentials and reuses it', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: invoiceJson('SENT') } });
    const g = gateway(f);
    await g.getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5');
    await g.getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5');
    const tokenCalls = f.calls.filter((c) => c.url.endsWith('/v1/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.headers.authorization).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    expect(tokenCalls[0]!.body).toBe('grant_type=client_credentials');
    expect(f.calls[1]!.headers.authorization).toBe('Bearer A21AAtoken1');
  });

  it('only ever calls https://api-m.sandbox.paypal.com and refuses redirects', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: invoiceJson('SENT') } });
    await gateway(f).getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5');
    for (const c of f.calls) expect(new URL(c.url).origin).toBe('https://api-m.sandbox.paypal.com');
    // An id that would change the path or host is rejected before any request is made.
    const g = gateway(fake({}));
    await expect(g.getInvoice('../../v1/payments')).rejects.toThrow(PayPalError);
    await expect(g.getInvoice('x@api-m.paypal.com/INV2')).rejects.toThrow(PayPalError);
  });

  it('refreshes the token after expiry and once on a 401', async () => {
    let t = 1_000_000;
    const f = fake({
      'POST /v1/oauth2/token': [TOKEN, { status: 200, json: { access_token: 'A21AAtoken2', expires_in: 32400 } }, { status: 200, json: { access_token: 'A21AAtoken3', expires_in: 32400 } }],
      'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': (c) =>
        c.headers.authorization === 'Bearer A21AAtoken2' ? { status: 401, json: { error: 'invalid_token', error_description: 'Token signature verification failed' } } : { status: 200, json: invoiceJson('SENT') },
    });
    const g = gateway(f, () => t);
    await g.getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5');
    t += 32400 * 1000; // past expiry (cache drops one minute early)
    await g.getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5'); // token2 -> 401 -> token3 -> ok
    expect(f.calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(3);
    expect(f.calls.at(-1)!.headers.authorization).toBe('Bearer A21AAtoken3');
  });

  it('rejects bad client credentials with a PayPalError and no bearer call', async () => {
    const f = fake({ 'POST /v1/oauth2/token': { status: 401, json: { error: 'invalid_client', error_description: 'Client Authentication failed' } } });
    await expect(gateway(f).getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5')).rejects.toMatchObject({ name: 'PayPalError', status: 401, paypalName: 'invalid_client' });
    expect(f.calls).toHaveLength(1);
  });

  it('create_invoice posts a draft with the approved figures and parses the representation', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'POST /v2/invoicing/invoices': { status: 201, json: invoiceJson('DRAFT') } });
    const inv = await gateway(f).createInvoice(INPUT);
    const call = f.calls[1]!;
    expect(call.headers.prefer).toBe('return=representation');
    expect(call.headers['paypal-request-id']).toBe('prop_1-create');
    const body = JSON.parse(call.body!) as Record<string, any>;
    expect(body.detail).toMatchObject({ invoice_number: 'PL-AB12-001', reference: 'paceline:ws:proj_1:m1', invoice_date: '2026-10-05', currency_code: 'USD', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-12' } });
    expect(body.primary_recipients[0].billing_info.email_address).toBe('buyer@example.com');
    expect(body.items).toEqual([{ name: 'Deposit', description: 'Kickoff deposit', quantity: '1', unit_amount: { currency_code: 'USD', value: '3000.00' }, unit_of_measure: 'AMOUNT' }]);
    expect(body.configuration.partial_payment.allow_partial_payment).toBe(false);
    expect(inv).toMatchObject({ id: 'INV2-Z56S-5LLA-Q52L-CPZ5', status: 'DRAFT', number: 'PL-AB12-001', amountMinor: 300000, dueAmountMinor: 300000, dueDate: '2026-10-12' });
  });

  it('create_invoice follows the link when PayPal returns only a link_description', async () => {
    const f = fake({
      'POST /v1/oauth2/token': TOKEN,
      'POST /v2/invoicing/invoices': { status: 201, json: { rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5', method: 'GET' } },
      'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: invoiceJson('DRAFT') },
    });
    expect((await gateway(f).createInvoice(INPUT)).id).toBe('INV2-Z56S-5LLA-Q52L-CPZ5');
  });

  it('send_invoice posts the notification, then re-reads the invoice', async () => {
    const f = fake({
      'POST /v1/oauth2/token': TOKEN,
      'POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/send': { status: 200, json: { rel: 'payer-view', href: 'https://www.sandbox.paypal.com/invoice/p/#Z56S5LLAQ52LCPZ5', method: 'GET' } },
      'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: invoiceJson('SENT') },
    });
    const inv = await gateway(f).sendInvoice('INV2-Z56S-5LLA-Q52L-CPZ5', { subject: 'Invoice PL-AB12-001', note: 'Thanks', requestId: 'prop_1-send' });
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ subject: 'Invoice PL-AB12-001', note: 'Thanks', send_to_invoicer: false, send_to_recipient: true });
    expect(f.calls[1]!.headers['paypal-request-id']).toBe('prop_1-send');
    expect(inv.status).toBe('SENT');
    expect(inv.payerViewUrl).toContain('sandbox.paypal.com');
  });

  it('send_invoice: 202 Accepted means PayPal scheduled it (invoice dated after the merchant\'s today)', async () => {
    const f = fake({
      'POST /v1/oauth2/token': TOKEN,
      'POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/send': { status: 202, json: { href: 'https://www.sandbox.paypal.com/invoice/p/#Z56S5LLAQ52LCPZ5', rel: 'payer-view', method: 'GET' } },
      'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: invoiceJson('SCHEDULED') },
    });
    const inv = await gateway(f).sendInvoice('INV2-Z56S-5LLA-Q52L-CPZ5', { subject: 's', note: 'n', requestId: 'prop_1-send' });
    expect(inv.status).toBe('SCHEDULED');
  });

  it('remind and cancel of a scheduled invoice: PayPal\'s 422 bodies come through with their issue codes', async () => {
    const f = fake({
      'POST /v1/oauth2/token': TOKEN,
      'POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/remind': { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed, semantically incorrect, or failed business validation.', debug_id: 'ca447d9146af0', details: [{ issue: 'CANNOT_REMIND_INVOICE', description: 'You cannot remind an invoice which is in SCHEDULED status. Only UNPAID, SENT and PARTIALLY_PAID invoices can be reminded.' }], links: [{ href: 'https://developer.paypal.com/docs/api/invoicing/#errors', method: 'GET' }] } },
      'POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/cancel': { status: 422, json: { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed, semantically incorrect, or failed business validation.', debug_id: 'ca447d91dfb3e', details: [{ field: 'invoiceId', value: 'INV2-Z56S-5LLA-Q52L-CPZ5', location: 'path', issue: 'CANNOT_CANCEL_SCHEDULED_INVOICE', description: 'Cannot cancel a scheduled invoice.' }], links: [] } },
    });
    const g = gateway(f);
    await expect(g.sendReminder('INV2-Z56S-5LLA-Q52L-CPZ5', { subject: 's', note: 'n' })).rejects.toMatchObject({ status: 422, paypalName: 'UNPROCESSABLE_ENTITY', debugId: 'ca447d9146af0', issues: ['CANNOT_REMIND_INVOICE'] });
    await expect(g.cancelInvoice('INV2-Z56S-5LLA-Q52L-CPZ5', { subject: 's', note: 'n' })).rejects.toMatchObject({ status: 422, issues: ['CANNOT_CANCEL_SCHEDULED_INVOICE'] });
  });

  it('parses a recorded (external) payment: MARKED_AS_PAID with the payment', async () => {
    // Shape of GET /v2/invoicing/invoices/{id} after POST .../payments, as returned by the sandbox on 2026-10-03.
    const marked = invoiceJson('MARKED_AS_PAID', { payments: { paid_amount: { currency_code: 'USD', value: '3000.00' }, transactions: [{ type: 'EXTERNAL', payment_id: 'EXTR-86F38350LX4353815', payment_date: '2026-10-05', payment_date_time: '2026-10-05T00:00:00Z', method: 'OTHER', note: 'Recorded', amount: { currency_code: 'USD', value: '3000.00' } }] } });
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: marked } });
    expect(await gateway(f).getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5')).toMatchObject({ status: 'MARKED_AS_PAID', dueAmountMinor: 0, paidOn: '2026-10-05', payments: [{ id: 'EXTR-86F38350LX4353815', method: 'OTHER', amountMinor: 300000 }] });
  });

  it('remind and cancel accept 204 with an empty body', async () => {
    const f = fake({
      'POST /v1/oauth2/token': TOKEN,
      'POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/remind': { status: 204 },
      'POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/cancel': { status: 204 },
    });
    const g = gateway(f);
    await expect(g.sendReminder('INV2-Z56S-5LLA-Q52L-CPZ5', { subject: 's', note: 'n' })).resolves.toBeUndefined();
    await expect(g.cancelInvoice('INV2-Z56S-5LLA-Q52L-CPZ5', { subject: 's', note: 'n' })).resolves.toBeUndefined();
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/oauth2/token', '/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/remind', '/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/cancel']);
  });

  it('maps a PayPal error body to PayPalError with name, debug id and issues', async () => {
    const f = fake({
      'POST /v1/oauth2/token': TOKEN,
      'POST /v2/invoicing/invoices': {
        status: 422,
        json: { name: 'UNPROCESSABLE_ENTITY', message: 'The requested action could not be performed, semantically incorrect, or failed business validation.', debug_id: 'a1b2c3d4e5f6', details: [{ issue: 'DUPLICATE_INVOICE_NUMBER', description: 'Invoice number is duplicate.' }] },
      },
    });
    await expect(gateway(f).createInvoice(INPUT)).rejects.toMatchObject({ status: 422, paypalName: 'UNPROCESSABLE_ENTITY', debugId: 'a1b2c3d4e5f6', issues: ['DUPLICATE_INVOICE_NUMBER'] });
  });

  it('parses a PAID invoice with its payment', async () => {
    const paid = invoiceJson('PAID', { payments: { paid_amount: { currency_code: 'USD', value: '3000.00' }, transactions: [{ payment_id: '5XY12345AB678901C', payment_date: '2026-10-07', method: 'PAYPAL', amount: { currency_code: 'USD', value: '3000.00' } }] } });
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: paid } });
    const inv = await gateway(f).getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5');
    expect(inv).toMatchObject({ status: 'PAID', dueAmountMinor: 0, paidOn: '2026-10-07' });
    expect(inv.payments).toEqual([{ id: '5XY12345AB678901C', date: '2026-10-07', amountMinor: 300000, method: 'PAYPAL' }]);
  });

  it('refuses a response with a status outside the documented enum instead of guessing', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5': { status: 200, json: invoiceJson('SOMETHING_NEW') } });
    await expect(gateway(f).getInvoice('INV2-Z56S-5LLA-Q52L-CPZ5')).rejects.toThrow();
  });
});

describe('webhook signature verification request', () => {
  const HEADERS = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270',
    'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
    'paypal-transmission-sig': 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==',
    'paypal-transmission-time': '2026-10-07T20:01:35Z',
  };
  // Deliberately odd spacing and key order: the body must reach PayPal byte for byte.
  const RAW = '{ "id":"WH-58D329510W468432D-8HN650336L201105X",  "event_type":"INVOICING.INVOICE.PAID", "resource":{"invoice":{"id":"INV2-Z56S-5LLA-Q52L-CPZ5","amount":{"value":"3000.00"}}} }';

  it('sends the headers, the configured webhook id and the raw body unaltered', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'POST /v1/notifications/verify-webhook-signature': { status: 200, json: { verification_status: 'SUCCESS' } } });
    expect(await gateway(f).verifyWebhook(HEADERS, RAW)).toBe(true);
    const sent = f.calls[1]!.body!;
    expect(sent).toContain(`"webhook_event":${RAW}`);
    const parsed = JSON.parse(sent) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      auth_algo: 'SHA256withRSA', cert_url: HEADERS['paypal-cert-url'], transmission_id: HEADERS['paypal-transmission-id'],
      transmission_sig: HEADERS['paypal-transmission-sig'], transmission_time: HEADERS['paypal-transmission-time'], webhook_id: '8PT597110X687430LKGECATA',
    });
    expect(Object.keys(parsed).sort()).toEqual(['auth_algo', 'cert_url', 'transmission_id', 'transmission_sig', 'transmission_time', 'webhook_event', 'webhook_id']);
  });

  it('accepts header names in any case', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'POST /v1/notifications/verify-webhook-signature': { status: 200, json: { verification_status: 'SUCCESS' } } });
    const upper = Object.fromEntries(Object.entries(HEADERS).map(([k, v]) => [k.toUpperCase(), v]));
    expect(await gateway(f).verifyWebhook(upper, RAW)).toBe(true);
  });

  it('returns false on FAILURE', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'POST /v1/notifications/verify-webhook-signature': { status: 200, json: { verification_status: 'FAILURE' } } });
    expect(await gateway(f).verifyWebhook(HEADERS, RAW)).toBe(false);
  });

  it('rejects without calling PayPal when a signature header is missing', async () => {
    const f = fake({});
    const { 'paypal-transmission-sig': _omit, ...missing } = HEADERS;
    expect(await gateway(f).verifyWebhook(missing, RAW)).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a certificate URL that is not on paypal.com', async () => {
    const f = fake({});
    for (const cert of ['https://evil.example/cert.pem', 'http://api.sandbox.paypal.com/cert', 'https://paypal.com.evil.example/cert', 'not a url']) {
      expect(await gateway(f).verifyWebhook({ ...HEADERS, 'paypal-cert-url': cert }, RAW)).toBe(false);
    }
    expect(f.calls).toHaveLength(0);
  });

  it('rejects bodies that are not a single JSON object, so the splice cannot smuggle fields', async () => {
    const f = fake({});
    for (const body of ['', 'null', '[]', '"x"', '{"id":"a"},"webhook_id":"WH-ATTACKER"', '{"id":"a"}} ', '{bad json']) {
      expect(await gateway(f).verifyWebhook(HEADERS, body)).toBe(false);
    }
    expect(f.calls).toHaveLength(0);
  });

  it('a 400 from the verifier (e.g. a malformed webhook id) is an error, never a pass', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'POST /v1/notifications/verify-webhook-signature': { status: 400, json: { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.', debug_id: 'ca447d9218b23', details: [{ field: '/webhook_id', value: 'WH-NOT-REGISTERED-YET', location: 'body', issue: 'must match "^[a-zA-Z0-9]+$"' }], links: [] } } });
    await expect(gateway(f).verifyWebhook(HEADERS, RAW)).rejects.toMatchObject({ status: 400, paypalName: 'INVALID_REQUEST' });
  });

  it('a verifier outage throws (the handler answers 500 so PayPal retries)', async () => {
    const f = fake({ 'POST /v1/oauth2/token': TOKEN, 'POST /v1/notifications/verify-webhook-signature': { status: 503, json: { name: 'SERVICE_UNAVAILABLE', message: 'Service Unavailable.' } } });
    await expect(gateway(f).verifyWebhook(HEADERS, RAW)).rejects.toBeInstanceOf(PayPalError);
  });
});
