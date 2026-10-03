/**
 * REAL calls to the PayPal sandbox (api-m.sandbox.paypal.com), to verify
 * server/paypal/sandbox.ts against the live API. Not part of the test suite.
 *
 *   npx tsx --env-file=.env scripts/try-sandbox.ts                 # exercise every SandboxGateway call
 *   npx tsx --env-file=.env scripts/try-sandbox.ts webhooks        # list the app's webhooks
 *   npx tsx --env-file=.env scripts/try-sandbox.ts create-webhook https://host/api/webhooks/paypal
 *                                                                  # create one (or reuse the one with that URL)
 *                                                                  # and store its id as PAYPAL_WEBHOOK_ID in .env
 *   npx tsx --env-file=.env scripts/try-sandbox.ts record-payment INV2-…|PL-XXXX-001   # mark an invoice paid (external payment)
 *   npx tsx --env-file=.env scripts/try-sandbox.ts events [n]      # recent webhook events PayPal generated for the app
 *   npx tsx --env-file=.env scripts/try-sandbox.ts get INV2-…|PL-XXXX-001   # an invoice's raw JSON (emails redacted)
 *   npx tsx --env-file=.env scripts/try-sandbox.ts scope           # does the access token carry the invoicing scope?
 *   npx tsx --env-file=.env scripts/try-sandbox.ts refresh-token   # revoke the cached token so the next one picks up new app features
 *
 * This is an operator's verification tool. It calls the gateway's write methods
 * directly, bypassing the approval gate on purpose (the gate is the app's rule
 * for model-proposed actions; here the operator runs each call by hand). The
 * server never imports this file.
 *
 * Credentials come from the environment through server/config.ts and are never
 * printed: responses are logged with emails, tokens and ids shortened.
 * Every invoice is addressed to PACELINE_SANDBOX_BUYER_EMAIL.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadConfig, scrubEnvironment } from '../server/config.ts';
import { SandboxGateway, type FetchLike } from '../server/paypal/sandbox.ts';
import { PAYPAL_SANDBOX_HOST, PayPalError, type CreateInvoiceInput } from '../shared/paypal/gateway.ts';
import { addDays, dateInZone } from '../shared/dates.ts';

const BASE = `https://${PAYPAL_SANDBOX_HOST}`;
const INVOICING_SCOPE = 'https://uri.paypal.com/services/invoicing';
export const WEBHOOK_EVENTS = ['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.UPDATED'];

const env = { ...process.env };
const config = loadConfig({ ...env, PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_WEBHOOK_ID: env.PAYPAL_WEBHOOK_ID || 'NOTREGISTEREDYET' });
scrubEnvironment(process.env);
if (config.paypal.mode !== 'sandbox') throw new Error('unreachable');
const { clientId, clientSecret } = config.paypal;
const buyer = config.paypal.buyerEmail;
const webhookConfigured = Boolean(env.PAYPAL_WEBHOOK_ID);
/** The merchant-side "today" (see shared/dates.ts: PayPal schedules invoices dated after it). */
const today = (): string => dateInZone(new Date(), config.timeZone);

/** Shorten anything sensitive before it reaches the terminal. */
function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/A21[\w-]{20,}/g, '<token>')
    .replace(/WH-[A-Z0-9]{8,}/g, (m) => `WH-…${m.slice(-4)}`);
}

// Every request the gateway makes, with its status and (redacted) response.
interface Seen { method: string; path: string; status: number; body: string }
const seen: Seen[] = [];
const loggingFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  const text = await res.clone().text();
  const path = new URL(url).pathname;
  seen.push({ method: init?.method ?? 'GET', path, status: res.status, body: path.endsWith('/oauth2/token') ? '(token response not shown)' : redact(text).slice(0, 600) });
  return res;
};

const gateway = new SandboxGateway({ clientId, clientSecret, webhookId: env.PAYPAL_WEBHOOK_ID || 'NOTREGISTEREDYET', fetch: loggingFetch });

/* ───────────── a tiny raw client for calls the app itself never makes ───────────── */

const basic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
let token: { value: string; scope: string } | undefined;

async function fetchToken(): Promise<{ value: string; scope: string }> {
  const res = await fetch(`${BASE}/v1/oauth2/token`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: 'grant_type=client_credentials' });
  const json = (await res.json()) as { access_token?: string; scope?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`token: HTTP ${res.status} ${json.error_description ?? ''}`);
  return { value: json.access_token, scope: json.scope ?? '' };
}

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  token ??= await fetchToken();
  const url = new URL(path, BASE);
  if (url.host !== PAYPAL_SANDBOX_HOST) throw new Error('sandbox only');
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${token.value}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error' });
  const text = await res.text();
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json, text };
}

/* ───────────── commands ───────────── */

async function scope(): Promise<void> {
  const t = await fetchToken();
  console.log(`invoicing scope: ${t.scope.split(' ').includes(INVOICING_SCOPE)} (${t.scope.split(' ').length} scopes)`);
}

/**
 * PayPal hands back the SAME client-credentials token until it expires (about
 * 9 hours), so a feature enabled on the app later (e.g. Invoicing) does not
 * show up in the token's scope. Revoking the cached token once fixes that.
 */
async function refreshToken(): Promise<void> {
  const t = await fetchToken();
  const res = await fetch(`${BASE}/v1/oauth2/token/terminate`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: t.value, token_type_hint: 'ACCESS_TOKEN' }).toString() });
  console.log(`terminate: HTTP ${res.status}`);
  await scope();
}

async function listWebhooks(): Promise<{ id: string; url: string; event_types: { name: string }[] }[]> {
  const r = await raw('GET', '/v1/notifications/webhooks');
  if (r.status !== 200) throw new Error(`list webhooks: HTTP ${r.status} ${redact(r.text).slice(0, 300)}`);
  return r.json.webhooks ?? [];
}

async function webhooks(): Promise<void> {
  const list = await listWebhooks();
  console.log(`${list.length} webhook(s) on this app`);
  for (const w of list) console.log(`  …${w.id.slice(-4)}  ${w.url}  [${w.event_types.map((e) => e.name).join(', ')}]`);
}

function storeWebhookId(id: string): void {
  const path = '.env';
  let text = readFileSync(path, 'utf8');
  const line = `PAYPAL_WEBHOOK_ID=${id}`;
  text = /^PAYPAL_WEBHOOK_ID=.*$/m.test(text) ? text.replace(/^PAYPAL_WEBHOOK_ID=.*$/m, line) : `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;
  writeFileSync(path, text, { mode: 0o600 });
  console.log(`stored PAYPAL_WEBHOOK_ID in .env (…${id.slice(-4)})`);
}

async function createWebhook(url: string | undefined): Promise<void> {
  if (!url || !/^https:\/\/[\w.-]+\/api\/webhooks\/paypal$/.test(url)) throw new Error('usage: create-webhook https://<host>/api/webhooks/paypal');
  const list = await listWebhooks();
  console.log(`${list.length} existing webhook(s); none will be modified.`);
  const existing = list.find((w) => w.url === url);
  if (existing) {
    console.log(`a webhook for ${url} already exists (…${existing.id.slice(-4)}): reusing it`);
    storeWebhookId(existing.id);
    return;
  }
  const r = await raw('POST', '/v1/notifications/webhooks', { url, event_types: WEBHOOK_EVENTS.map((name) => ({ name })) });
  if (r.status !== 201 || typeof r.json?.id !== 'string') throw new Error(`create webhook: HTTP ${r.status} ${redact(r.text).slice(0, 400)}`);
  console.log(`created webhook …${r.json.id.slice(-4)} for ${url}: [${r.json.event_types.map((e: { name: string }) => e.name).join(', ')}]`);
  storeWebhookId(r.json.id);
}

/**
 * Record an external payment for the full due amount. PayPal sets the invoice
 * to MARKED_AS_PAID. Used to finish the end-to-end test without signing in as
 * the buyer.
 */
async function recordPayment(arg: string | undefined): Promise<void> {
  const invoiceId = await resolveInvoice(arg, 'record-payment');
  const inv = await raw('GET', `/v2/invoicing/invoices/${invoiceId}`);
  if (inv.status !== 200) throw new Error(`get: HTTP ${inv.status} ${redact(inv.text).slice(0, 300)}`);
  const due = inv.json.due_amount ?? inv.json.amount;
  const r = await raw('POST', `/v2/invoicing/invoices/${invoiceId}/payments`, {
    method: 'OTHER',
    payment_date: today(),
    amount: { currency_code: due.currency_code, value: due.value },
    note: 'Recorded by scripts/try-sandbox.ts (Paceline end-to-end test).',
  });
  console.log(`record payment: HTTP ${r.status} ${redact(r.text).slice(0, 300)}`);
  const after = await raw('GET', `/v2/invoicing/invoices/${invoiceId}`);
  console.log(`invoice status now: ${after.json?.status}; due ${after.json?.due_amount?.value ?? '?'}; paid ${after.json?.payments?.paid_amount?.value ?? '?'}`);
}

/**
 * Accept either PayPal's id (INV2-…) or the invoice number Paceline shows in the
 * ledger (PL-XXXX-001), which is looked up with PayPal's invoice search.
 */
async function resolveInvoice(arg: string | undefined, cmd: string): Promise<string> {
  if (arg && /^INV2-[A-Z0-9-]{4,40}$/.test(arg)) return arg;
  if (!arg || !/^PL-[A-Z0-9]{2,12}-\d{3,6}$/.test(arg)) throw new Error(`usage: ${cmd} INV2-XXXX-XXXX-XXXX-XXXX | PL-XXXX-001`);
  const r = await raw('POST', '/v2/invoicing/search-invoices?page=1&page_size=5&total_required=true', { invoice_number: arg });
  if (r.status !== 200) throw new Error(`search: HTTP ${r.status} ${redact(r.text).slice(0, 300)}`);
  const hits = ((r.json.items ?? []) as { id: string; detail?: { invoice_number?: string } }[]).filter((i) => i.detail?.invoice_number === arg);
  if (hits.length !== 1) throw new Error(`search: ${hits.length} invoices numbered ${arg}`);
  console.log(`${arg} is ${hits[0]!.id}`);
  return hits[0]!.id;
}

async function getRaw(arg: string | undefined): Promise<void> {
  const invoiceId = await resolveInvoice(arg, 'get');
  const r = await raw('GET', `/v2/invoicing/invoices/${invoiceId}`);
  console.log(`HTTP ${r.status}`);
  console.log(redact(JSON.stringify(r.json, null, 2)));
}

async function events(n = 10): Promise<void> {
  // Without a window PayPal may return nothing; ask for the last three days explicitly.
  const start = new Date(Date.now() - 3 * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const end = new Date(Date.now() + 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const r = await raw('GET', `/v1/notifications/webhooks-events?page_size=${Math.min(Math.max(n, 1), 50)}&start_time=${start}&end_time=${end}`);
  if (r.status !== 200) throw new Error(`events: HTTP ${r.status} ${redact(r.text).slice(0, 300)}`);
  const list = r.json.events ?? [];
  console.log(`${list.length} event(s) since ${start}${list.length ? '' : ' (PayPal lists events with a delay; deliveries can arrive before they show here)'}`);
  for (const e of list) {
    const inv = e.resource?.invoice?.id ?? e.resource?.id ?? '?';
    console.log(`${e.create_time}  ${e.event_type.padEnd(28)}  ${inv}  status=${e.resource?.invoice?.status ?? e.resource?.status ?? '?'}  ${e.id}`);
  }
}

/* ───────────── the verification run ───────────── */

interface Result { step: string; ok: boolean; detail: string }
const results: Result[] = [];

async function step<T>(name: string, fn: () => Promise<T>, describe: (v: T) => string): Promise<T | undefined> {
  const before = seen.length;
  try {
    const v = await fn();
    results.push({ step: name, ok: true, detail: describe(v) });
    console.log(`ok    ${name}: ${describe(v)}`);
    return v;
  } catch (e) {
    const detail = e instanceof PayPalError ? `${e.status} ${e.paypalName ?? ''} ${e.message} ${e.issues.join(',')} debug_id=${e.debugId ?? '-'}` : String((e as Error).message ?? e);
    results.push({ step: name, ok: false, detail });
    console.log(`FAIL  ${name}: ${redact(detail)}`);
    return undefined;
  } finally {
    for (const s of seen.slice(before)) console.log(`        ${s.method} ${s.path} -> ${s.status}  ${s.status >= 300 || process.argv.includes('-v') ? s.body : ''}`);
  }
}

function input(n: number, tag: string, today: string): CreateInvoiceInput {
  return {
    requestId: `try-${tag}-${n}-create`,
    number: `PL-TRY${tag}-${String(n).padStart(3, '0')}`,
    reference: `paceline:try-sandbox:${tag}:m${n}`,
    currency: 'USD',
    recipientName: 'Sandbox Buyer (Paceline test)',
    recipientEmail: buyer!,
    itemName: `Paceline sandbox check: milestone ${n}`,
    itemDescription: 'Created by scripts/try-sandbox.ts to verify the Invoicing v2 client.',
    amountMinor: 1_000 + n * 100,
    invoiceDate: today,
    dueDate: addDays(today, 7),
    note: 'Test invoice from the Paceline sandbox verification script.',
  };
}

async function all(): Promise<void> {
  if (!buyer) throw new Error('PACELINE_SANDBOX_BUYER_EMAIL is not set.');
  const tag = randomBytes(2).toString('hex').toUpperCase();
  const day = today();
  console.log(`PayPal sandbox verification, ${new Date().toISOString()} (today in ${config.timeZone}: ${day}), run tag ${tag}\n`);

  await step('oauth token (client credentials) + invoicing scope', async () => {
    const t = await fetchToken();
    if (!t.scope.split(' ').includes(INVOICING_SCOPE)) throw new Error('token lacks the invoicing scope (enable Invoicing on the app, then run refresh-token)');
    return t;
  }, () => 'token issued with the invoicing scope');

  const draft = await step('create_invoice (draft, to the sandbox buyer)', () => gateway.createInvoice(input(1, tag, day)), (i) => `${i.id} ${i.status} ${i.number} amount ${i.amountMinor} due ${i.dueDate}`);
  if (draft) {
    await step('send_invoice', () => gateway.sendInvoice(draft.id, { subject: `Invoice ${draft.number}`, note: 'Paceline sandbox check.', requestId: `try-${tag}-1-send` }), (i) => `${i.status}; payer view ${i.payerViewUrl ? new URL(i.payerViewUrl).host : 'none'}`);
    await step('get_invoice', () => gateway.getInvoice(draft.id), (i) => `${i.status} due ${i.dueAmountMinor} of ${i.amountMinor}`);
    await step('send_invoice_reminder', () => gateway.sendReminder(draft.id, { subject: `Reminder: ${draft.number}`, note: 'Friendly reminder (sandbox check).' }), () => 'accepted');
  }
  const second = await step('create_invoice (second, for cancel)', () => gateway.createInvoice(input(2, tag, day)), (i) => `${i.id} ${i.status}`);
  if (second) {
    await step('send_invoice (second)', () => gateway.sendInvoice(second.id, { subject: `Invoice ${second.number}`, note: 'Will be cancelled.', requestId: `try-${tag}-2-send` }), (i) => i.status);
    await step('cancel_sent_invoice', () => gateway.cancelInvoice(second.id, { subject: `Cancelled: ${second.number}`, note: 'Cancelled by the sandbox check.' }), () => 'accepted');
    await step('get_invoice after cancel', () => gateway.getInvoice(second.id), (i) => i.status);
  }
  // A delivery we fabricated must come back as FAILURE (not a 400): proves the request shape is accepted.
  await step('verify-webhook-signature (fabricated delivery, expect FAILURE)', async () => {
    const ok = await gateway.verifyWebhook({
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
      'paypal-transmission-id': '00000000-0000-0000-0000-000000000000',
      'paypal-transmission-sig': Buffer.from('not a signature').toString('base64'),
      'paypal-transmission-time': new Date().toISOString(),
    }, JSON.stringify({ id: 'WH-TEST-0000000000000000', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: draft?.id ?? 'INV2-TEST' } } }));
    if (ok) throw new Error('a fabricated signature verified');
    return ok;
  }, () => `verification_status FAILURE${webhookConfigured ? '' : ' (no webhook registered yet; real deliveries are checked end to end)'}`);

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps ok`);
  if (draft) console.log(`Invoices left in the sandbox: ${draft.number} (SENT, reminded)${second ? `, ${second.number} (CANCELLED)` : ''}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

const [cmd = 'all', arg] = process.argv.slice(2).filter((a) => a !== '-v');
const commands: Record<string, () => Promise<void>> = {
  all, scope, webhooks, events: () => events(Number(arg ?? 10)), get: () => getRaw(arg),
  'refresh-token': refreshToken, 'create-webhook': () => createWebhook(arg), 'record-payment': () => recordPayment(arg),
};
const run = commands[cmd];
if (!run) {
  console.error(`unknown command ${cmd}; one of ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
run().catch((e: unknown) => {
  console.error(redact(String((e as Error).message ?? e)));
  process.exit(1);
});
