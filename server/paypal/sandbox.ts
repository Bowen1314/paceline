/**
 * PayPal sandbox gateway: Invoicing v2 over REST.
 *
 * STATUS: written from PayPal's OpenAPI spec (invoicing_v2.json,
 * notifications_webhooks_v1.json) and unit-tested against recorded-shape
 * responses. NOT YET EXERCISED AGAINST THE SANDBOX: there were no credentials
 * in phase 1. Every method below is unverified until phase 2.
 *
 * Why direct REST and not the `@paypal/agent-toolkit` package: the toolkit
 * (1.11.0) fetches its OAuth token from api.sandbox.paypal.com with no way to
 * pin the host, caches that token forever (sandbox tokens expire after ~9 h),
 * flattens API errors to strings without status or debug_id, has no webhook
 * verification, and is built to hand write tools straight to a model, which is
 * the opposite of Paceline's approval gate. The method names here mirror the
 * toolkit's tool names so the vocabulary stays PayPal's.
 *
 * The host is a constant. There is no setting for it, and every request
 * re-checks the URL it is about to call.
 */
import type { CreateInvoiceInput, InvoiceRecord, NotificationInput, PayPalGateway, PayPalInvoiceJson } from '../../shared/paypal/gateway.ts';
import { PAYPAL_SANDBOX_HOST, PayPalError, parseInvoice } from '../../shared/paypal/gateway.ts';
import { toPayPalValue } from '../../shared/money.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface SandboxOptions {
  clientId: string;
  clientSecret: string;
  webhookId: string;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

const BASE = `https://${PAYPAL_SANDBOX_HOST}`;
const INVOICE_ID_RE = /^[A-Za-z0-9-]{6,40}$/;

const header = (headers: Record<string, string | undefined>, name: string): string | undefined => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
};

export class SandboxGateway implements PayPalGateway {
  readonly mode = 'sandbox' as const;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | undefined;
  private tokenInFlight: Promise<string> | undefined;

  constructor(private readonly opts: SandboxOptions) {
    if (!opts.clientId || !opts.clientSecret || !opts.webhookId) throw new Error('SandboxGateway needs a client id, a client secret and a webhook id.');
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Every outgoing call goes through here. Anything but the sandbox host is a bug, so it throws. */
  private async call(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, BASE);
    if (url.protocol !== 'https:' || url.host !== PAYPAL_SANDBOX_HOST) throw new Error(`Refusing to call ${url.host}: Paceline is sandbox-only (${PAYPAL_SANDBOX_HOST}).`);
    try {
      return await this.fetch(url.toString(), { ...init, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new PayPalError(`Could not reach PayPal sandbox: ${(e as Error).message}`, 503);
    }
  }

  /** OAuth2 client credentials. Cached until one minute before `expires_in`. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    this.tokenInFlight ??= (async () => {
      try {
        const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
        const res = await this.call('/v1/oauth2/token', {
          method: 'POST',
          headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: 'grant_type=client_credentials',
        });
        const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
        if (!res.ok || typeof json.access_token !== 'string') {
          throw new PayPalError(`PayPal sandbox rejected the client credentials: ${json.error_description ?? json.error ?? res.status}`, res.status === 200 ? 502 : res.status, json.error);
        }
        const ttl = typeof json.expires_in === 'number' && json.expires_in > 120 ? json.expires_in : 120;
        this.token = { value: json.access_token, expiresAt: this.now() + (ttl - 60) * 1000 };
        return json.access_token;
      } finally {
        this.tokenInFlight = undefined;
      }
    })();
    return this.tokenInFlight;
  }

  private async api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, rawBody?: string): Promise<{ status: number; json: unknown }> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.call(path, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      });
      if (res.status === 401 && attempt === 0) {
        this.token = undefined; // expired or revoked: fetch a new token once
        continue;
      }
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      if (!res.ok) {
        const err = (json ?? {}) as { name?: string; message?: string; debug_id?: string; details?: { issue?: string; description?: string; field?: string }[] };
        const issues = (err.details ?? []).map((d) => d.issue).filter((x): x is string => typeof x === 'string');
        throw new PayPalError(err.message ?? `PayPal returned HTTP ${res.status}`, res.status, err.name, err.debug_id, issues);
      }
      return { status: res.status, json };
    }
  }

  private static id(invoiceId: string): string {
    if (!INVOICE_ID_RE.test(invoiceId)) throw new PayPalError(`Not a PayPal invoice id: ${invoiceId}`, 400);
    return invoiceId;
  }

  /** create_invoice — POST /v2/invoicing/invoices. Creates a DRAFT; nothing is sent to the payer. */
  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceRecord> {
    const value = toPayPalValue(input.amountMinor);
    const body: PayPalInvoiceJson & { configuration: unknown } = {
      detail: {
        invoice_number: input.number,
        reference: input.reference,
        invoice_date: input.invoiceDate,
        currency_code: input.currency,
        note: input.note,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: input.dueDate },
      },
      primary_recipients: [{ billing_info: { business_name: input.recipientName, email_address: input.recipientEmail } }],
      items: [{ name: input.itemName, description: input.itemDescription || undefined, quantity: '1', unit_amount: { currency_code: input.currency, value }, unit_of_measure: 'AMOUNT' }],
      configuration: { partial_payment: { allow_partial_payment: false }, allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
    };
    const { json } = await this.api('POST', '/v2/invoicing/invoices', body, { prefer: 'return=representation', 'paypal-request-id': input.requestId });
    const created = json as (PayPalInvoiceJson & { href?: string; rel?: string }) | undefined;
    if (created?.id && created.status) return parseInvoice(created);
    // Without return=representation PayPal answers with a link to the new invoice.
    const href = created?.href ?? created?.links?.find((l) => l.rel === 'self')?.href;
    const id = href?.split('/').pop()?.split('?')[0];
    if (!id) throw new PayPalError('PayPal created the invoice but returned neither the invoice nor a link to it.', 502);
    return this.getInvoice(id);
  }

  /** send_invoice — POST /v2/invoicing/invoices/{id}/send. 200 = sent now, 202 = scheduled. */
  async sendInvoice(invoiceId: string, n: NotificationInput & { requestId: string }): Promise<InvoiceRecord> {
    const id = SandboxGateway.id(invoiceId);
    await this.api('POST', `/v2/invoicing/invoices/${id}/send`, { subject: n.subject, note: n.note, send_to_invoicer: false, send_to_recipient: true }, { 'paypal-request-id': n.requestId });
    return this.getInvoice(id);
  }

  /** get_invoice — GET /v2/invoicing/invoices/{id}. */
  async getInvoice(invoiceId: string): Promise<InvoiceRecord> {
    const { json } = await this.api('GET', `/v2/invoicing/invoices/${SandboxGateway.id(invoiceId)}`);
    return parseInvoice(json as PayPalInvoiceJson);
  }

  /** send_invoice_reminder — POST /v2/invoicing/invoices/{id}/remind. 204 on success. */
  async sendReminder(invoiceId: string, n: NotificationInput): Promise<void> {
    await this.api('POST', `/v2/invoicing/invoices/${SandboxGateway.id(invoiceId)}/remind`, { subject: n.subject, note: n.note, send_to_invoicer: false, send_to_recipient: true });
  }

  /** cancel_sent_invoice — POST /v2/invoicing/invoices/{id}/cancel. 204 on success. */
  async cancelInvoice(invoiceId: string, n: NotificationInput): Promise<void> {
    await this.api('POST', `/v2/invoicing/invoices/${SandboxGateway.id(invoiceId)}/cancel`, { subject: n.subject, note: n.note, send_to_invoicer: false, send_to_recipient: true });
  }

  /**
   * POST /v1/notifications/verify-webhook-signature.
   *
   * PayPal requires `webhook_event` to be the delivery body byte for byte, so
   * the raw body is spliced into the request as text instead of being parsed
   * and re-serialised. It is parsed once first, only to prove it is a single
   * JSON object (so the splice cannot smuggle extra fields such as a second
   * `webhook_id`). Mock events from PayPal's dashboard simulator cannot be
   * verified by this API and are therefore rejected.
   */
  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    const fields = {
      auth_algo: header(headers, 'paypal-auth-algo'),
      cert_url: header(headers, 'paypal-cert-url'),
      transmission_id: header(headers, 'paypal-transmission-id'),
      transmission_sig: header(headers, 'paypal-transmission-sig'),
      transmission_time: header(headers, 'paypal-transmission-time'),
    };
    if (Object.values(fields).some((v) => !v || v.length > 600)) return false;
    try {
      const cert = new URL(fields.cert_url!);
      if (cert.protocol !== 'https:' || !(cert.hostname === 'paypal.com' || cert.hostname.endsWith('.paypal.com'))) return false;
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    } catch {
      return false;
    }
    const envelope = JSON.stringify({ ...fields, webhook_id: this.opts.webhookId });
    const request = `${envelope.slice(0, -1)},"webhook_event":${rawBody}}`;
    const { json } = await this.api('POST', '/v1/notifications/verify-webhook-signature', undefined, {}, request);
    return (json as { verification_status?: string } | undefined)?.verification_status === 'SUCCESS';
  }
}
