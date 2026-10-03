/**
 * PayPal simulator. No network. Keeps invoices in memory in PayPal's own JSON
 * shape and can emit a signed INVOICING.INVOICE.PAID webhook on demand.
 *
 * It exists because phase 1 has no sandbox credentials, and it stays useful
 * afterwards as the `?mock=1` backend and as the test double. The UI labels
 * this mode "Simulated PayPal — no sandbox calls made" wherever it is active.
 *
 * Simulated ids carry a SIM0 segment (INV2-SIM0-…) so they can never be
 * mistaken for real sandbox invoices.
 */
import type { ISODate } from '../contract.ts';
import { dateOf } from '../dates.ts';
import { toPayPalValue } from '../money.ts';
import {
  PayPalError, parseInvoice,
  type CreateInvoiceInput, type InvoiceRecord, type NotificationInput, type PayPalGateway, type PayPalInvoiceJson, type PayPalWebhookEvent,
} from './gateway.ts';

export interface SimulatorState {
  secret: string;
  webhookId: string;
  invoices: Record<string, PayPalInvoiceJson>;
  /** requestId -> invoice id, for PayPal-Request-Id style idempotency */
  requests: Record<string, string>;
  reminders: Record<string, number>;
}

export interface SignedWebhook {
  headers: Record<string, string>;
  rawBody: string;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomToken(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export function newSimulatorState(): SimulatorState {
  return { secret: randomToken(32), webhookId: `SIM-WH-${randomToken(12)}`, invoices: {}, requests: {}, reminders: {} };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(text: string): number {
  let c = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function hmacBase64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const header = (headers: Record<string, string | undefined>, name: string): string | undefined => {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
};

export class PayPalSimulator implements PayPalGateway {
  readonly mode = 'simulator' as const;

  constructor(
    public state: SimulatorState,
    private readonly now: () => Date,
  ) {}

  private must(id: string): PayPalInvoiceJson {
    const inv = this.state.invoices[id];
    if (!inv) throw new PayPalError(`The specified resource does not exist. (simulated, invoice ${id})`, 404, 'RESOURCE_NOT_FOUND');
    return inv;
  }

  async createInvoice(input: CreateInvoiceInput): Promise<InvoiceRecord> {
    const existing = this.state.requests[input.requestId];
    if (existing) return parseInvoice(this.must(existing));
    if (Object.values(this.state.invoices).some((i) => i.detail?.invoice_number === input.number)) {
      throw new PayPalError('Invoice number already exists. (simulated)', 422, 'UNPROCESSABLE_ENTITY', undefined, ['DUPLICATE_INVOICE_NUMBER']);
    }
    const id = `INV2-SIM0-${randomToken(4)}-${randomToken(4)}-${randomToken(4)}`;
    const value = toPayPalValue(input.amountMinor);
    this.state.invoices[id] = {
      id,
      status: 'DRAFT',
      detail: {
        invoice_number: input.number,
        reference: input.reference,
        invoice_date: input.invoiceDate,
        currency_code: input.currency,
        note: input.note,
        payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: input.dueDate },
        metadata: { create_time: this.now().toISOString() },
      },
      primary_recipients: [{ billing_info: { business_name: input.recipientName, email_address: input.recipientEmail } }],
      items: [{ name: input.itemName, description: input.itemDescription, quantity: '1', unit_amount: { currency_code: input.currency, value }, unit_of_measure: 'AMOUNT' }],
      amount: { currency_code: input.currency, value },
      due_amount: { currency_code: input.currency, value },
    };
    this.state.requests[input.requestId] = id;
    return parseInvoice(this.state.invoices[id]!);
  }

  async sendInvoice(invoiceId: string, _n: NotificationInput & { requestId: string }): Promise<InvoiceRecord> {
    const inv = this.must(invoiceId);
    if (inv.status === 'DRAFT') {
      inv.status = 'SENT';
      const at = this.now().toISOString();
      inv.detail!.metadata = { ...inv.detail!.metadata, first_sent_time: at, last_sent_time: at };
    } else if (inv.status !== 'SENT') {
      throw new PayPalError(`Invoice cannot be sent in status ${inv.status}. (simulated)`, 422, 'UNPROCESSABLE_ENTITY');
    }
    return parseInvoice(inv);
  }

  async getInvoice(invoiceId: string): Promise<InvoiceRecord> {
    return parseInvoice(this.must(invoiceId));
  }

  async sendReminder(invoiceId: string, _n: NotificationInput): Promise<void> {
    const inv = this.must(invoiceId);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status ?? '')) {
      throw new PayPalError(`A reminder cannot be sent for an invoice in status ${inv.status}. (simulated)`, 422, 'UNPROCESSABLE_ENTITY');
    }
    this.state.reminders[invoiceId] = (this.state.reminders[invoiceId] ?? 0) + 1;
  }

  async cancelInvoice(invoiceId: string, _n: NotificationInput): Promise<void> {
    const inv = this.must(invoiceId);
    if (!['SENT', 'UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'].includes(inv.status ?? '')) {
      throw new PayPalError(`Only a sent invoice can be cancelled; this one is ${inv.status}. (simulated)`, 422, 'UNPROCESSABLE_ENTITY');
    }
    inv.status = 'CANCELLED';
    inv.detail!.metadata = { ...inv.detail!.metadata, cancel_time: this.now().toISOString() };
  }

  /** The string PayPal signs: `transmissionId|transmissionTime|webhookId|crc32(body)`. */
  private signedString(transmissionId: string, time: string, rawBody: string): string {
    return `${transmissionId}|${time}|${this.state.webhookId}|${crc32(rawBody)}`;
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    const id = header(headers, 'paypal-transmission-id');
    const time = header(headers, 'paypal-transmission-time');
    const sig = header(headers, 'paypal-transmission-sig');
    if (!id || !time || !sig) return false;
    const expected = await hmacBase64(this.state.secret, this.signedString(id, time, rawBody));
    return timingSafeEqual(expected, sig);
  }

  /** Wrap an event in a delivery signed with this simulator's secret. */
  async sign(event: PayPalWebhookEvent): Promise<SignedWebhook> {
    const rawBody = JSON.stringify(event);
    const transmissionId = `sim-${randomToken(20).toLowerCase()}`;
    const time = this.now().toISOString();
    return {
      rawBody,
      headers: {
        'content-type': 'application/json',
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': time,
        'paypal-transmission-sig': await hmacBase64(this.state.secret, this.signedString(transmissionId, time, rawBody)),
        'paypal-auth-algo': 'SIM-HMAC-SHA256',
        'paypal-cert-url': 'simulator://no-certificate',
      },
    };
  }

  /**
   * Play the buyer: pay the invoice in full and return the webhook PayPal
   * would deliver. The caller feeds it to the same handler real deliveries use.
   */
  async pay(invoiceId: string, paidOn: ISODate = dateOf(this.now())): Promise<SignedWebhook> {
    const inv = this.must(invoiceId);
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status ?? '')) {
      throw new PayPalError(`Invoice ${invoiceId} is ${inv.status}; only a sent, unpaid invoice can be paid. (simulated)`, 422, 'UNPROCESSABLE_ENTITY');
    }
    const amount = inv.due_amount ?? { currency_code: inv.amount!.currency_code!, value: inv.amount!.value! };
    inv.status = 'PAID';
    inv.payments = {
      paid_amount: { currency_code: inv.amount!.currency_code!, value: inv.amount!.value! },
      transactions: [
        ...(inv.payments?.transactions ?? []),
        { type: 'PAYPAL', payment_id: `SIM${randomToken(14)}`, payment_date: paidOn, method: 'PAYPAL', amount },
      ],
    };
    inv.due_amount = { currency_code: amount.currency_code, value: '0.00' };
    return this.sign(this.event('INVOICING.INVOICE.PAID', inv, 'A simulated buyer paid the invoice.'));
  }

  event(eventType: string, inv: PayPalInvoiceJson, summary: string): PayPalWebhookEvent {
    return {
      id: `WH-SIM-${randomToken(17)}`,
      event_version: '1.0',
      create_time: this.now().toISOString(),
      resource_type: 'invoices',
      resource_version: '2.0',
      event_type: eventType,
      summary,
      resource: { invoice: structuredClone(inv) },
      links: [],
    };
  }

  remindersSent(invoiceId: string): number {
    return this.state.reminders[invoiceId] ?? 0;
  }
}
