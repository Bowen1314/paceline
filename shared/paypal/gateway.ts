/**
 * The one interface through which Paceline reaches PayPal.
 *
 * Two implementations:
 *  - `PayPalSimulator` (shared/paypal/simulator.ts): invoices in memory, emits
 *    a signed "paid" webhook on demand. Runs in Node and in the browser mock.
 *  - `SandboxGateway` (server/paypal/sandbox.ts): Invoicing v2 REST on
 *    api-m.sandbox.paypal.com. Written from the docs; not yet exercised.
 *
 * Both speak PayPal's own JSON shapes at the edge (`PayPalInvoiceJson`), so the
 * same parser and the same webhook handler run in both modes.
 */
import type { CurrencyCode, ISODate, InvoicePayment, Minor, PayPalInvoiceStatus, PayPalMode } from '../contract.ts';
import { CURRENCIES } from '../contract.ts';
import { isISODate } from '../dates.ts';
import { fromPayPalValue } from '../money.ts';

/** The only PayPal API host this project will ever talk to. */
export const PAYPAL_SANDBOX_HOST = 'api-m.sandbox.paypal.com';

/**
 * The invoice's payer page, offered as a link in sandbox mode so the owner can
 * pay as the sandbox buyer. Only an https URL on PayPal's sandbox site passes;
 * anything else (a live paypal.com page, another host) is dropped.
 */
export function sandboxPayerUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'www.sandbox.paypal.com' || u.hostname === 'sandbox.paypal.com') && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Invoicing v2 `invoice` object, restricted to the fields Paceline reads or writes. */
export interface PayPalMoneyJson { currency_code: string; value: string }
export interface PayPalInvoiceJson {
  id?: string;
  status?: string;
  detail?: {
    invoice_number?: string;
    reference?: string;
    invoice_date?: string;
    currency_code?: string;
    note?: string;
    memo?: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: { create_time?: string; first_sent_time?: string; last_sent_time?: string; recipient_view_url?: string; invoicer_view_url?: string; cancel_time?: string };
  };
  invoicer?: { email_address?: string; name?: { given_name?: string; surname?: string }; business_name?: string };
  primary_recipients?: { billing_info?: { email_address?: string; business_name?: string; name?: { given_name?: string; surname?: string } } }[];
  items?: { name?: string; description?: string; quantity?: string; unit_amount?: PayPalMoneyJson; unit_of_measure?: string }[];
  amount?: { currency_code?: string; value?: string };
  due_amount?: PayPalMoneyJson;
  payments?: { paid_amount?: PayPalMoneyJson; transactions?: { type?: string; payment_id?: string; payment_date?: string; method?: string; amount?: PayPalMoneyJson }[] };
  links?: { href: string; rel: string; method?: string }[];
}

/** PayPal webhook event envelope (notifications v1 `event`). */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource_type?: string;
  resource_version?: string;
  event_version?: string;
  summary?: string;
  resource?: unknown;
  links?: unknown[];
}

/** What Paceline needs to know about an invoice, parsed out of PayPal's JSON. */
export interface InvoiceRecord {
  id: string;
  number: string;
  reference: string;
  status: PayPalInvoiceStatus;
  currency: CurrencyCode;
  amountMinor: Minor;
  dueAmountMinor: Minor;
  invoiceDate: ISODate;
  dueDate: ISODate;
  paidOn?: ISODate;
  payments: InvoicePayment[];
  payerViewUrl?: string;
}

export interface CreateInvoiceInput {
  /** Idempotency key (sent as PayPal-Request-Id). */
  requestId: string;
  number: string;
  /** Opaque Paceline reference: lets a webhook be routed back to its workspace. */
  reference: string;
  currency: CurrencyCode;
  recipientName: string;
  recipientEmail: string;
  itemName: string;
  itemDescription: string;
  amountMinor: Minor;
  invoiceDate: ISODate;
  dueDate: ISODate;
  note?: string;
}

export interface NotificationInput {
  subject?: string;
  note?: string;
}

export interface PayPalGateway {
  readonly mode: PayPalMode;
  /** create_invoice — POST /v2/invoicing/invoices (draft). */
  createInvoice(input: CreateInvoiceInput): Promise<InvoiceRecord>;
  /** send_invoice — POST /v2/invoicing/invoices/{id}/send. */
  sendInvoice(invoiceId: string, n: NotificationInput & { requestId: string }): Promise<InvoiceRecord>;
  /** get_invoice — GET /v2/invoicing/invoices/{id}. */
  getInvoice(invoiceId: string): Promise<InvoiceRecord>;
  /** send_invoice_reminder — POST /v2/invoicing/invoices/{id}/remind. */
  sendReminder(invoiceId: string, n: NotificationInput): Promise<void>;
  /** cancel_sent_invoice — POST /v2/invoicing/invoices/{id}/cancel. */
  cancelInvoice(invoiceId: string, n: NotificationInput): Promise<void>;
  /** Verify a webhook delivery. `rawBody` must be the bytes exactly as received. */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly paypalName?: string,
    public readonly debugId?: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}

const STATUSES: ReadonlySet<string> = new Set([
  'DRAFT', 'SENT', 'SCHEDULED', 'PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED',
  'MARKED_AS_REFUNDED', 'UNPAID', 'PAYMENT_PENDING', 'AUTO_CANCELLED', 'PAID_EXTERNAL', 'REFUNDED_EXTERNAL', 'SHARED',
]);

/**
 * Parse PayPal's invoice JSON into an `InvoiceRecord`. Throws rather than
 * guessing: an unknown status, a malformed amount or a missing id is an error,
 * never a default.
 */
export function parseInvoice(json: PayPalInvoiceJson): InvoiceRecord {
  const fail = (what: string): never => {
    throw new PayPalError(`PayPal invoice JSON is missing or has an unexpected ${what}`, 502);
  };
  if (!json || typeof json !== 'object') fail('body');
  const id = typeof json.id === 'string' && json.id ? json.id : fail('id');
  const status = typeof json.status === 'string' && STATUSES.has(json.status) ? (json.status as PayPalInvoiceStatus) : fail(`status (${String(json.status)})`);
  const detail = json.detail ?? fail('detail');
  const currencyRaw = detail.currency_code ?? json.amount?.currency_code;
  const currency = CURRENCIES.includes(currencyRaw as CurrencyCode) ? (currencyRaw as CurrencyCode) : fail(`currency (${String(currencyRaw)})`);
  const amountMinor = fromPayPalValue(json.amount?.value) ?? fail('amount.value');
  const invoiceDate = isISODate(detail.invoice_date) ? detail.invoice_date : fail('detail.invoice_date');
  const dueRaw = detail.payment_term?.due_date;
  const dueDate = isISODate(dueRaw) ? dueRaw : invoiceDate; // DUE_ON_RECEIPT / NO_DUE_DATE carry no due_date

  const payments: InvoicePayment[] = [];
  let paidMinor = 0;
  for (const t of json.payments?.transactions ?? []) {
    const amt = fromPayPalValue(t.amount?.value);
    if (amt === null || !isISODate(t.payment_date)) continue;
    payments.push({ id: t.payment_id ?? '', date: t.payment_date, method: t.method ?? 'PAYPAL', amountMinor: amt });
    paidMinor += amt;
  }
  const paidTotal = fromPayPalValue(json.payments?.paid_amount?.value) ?? paidMinor;
  const dueAmount = fromPayPalValue(json.due_amount?.value);
  const dueAmountMinor = dueAmount ?? Math.max(0, amountMinor - paidTotal);
  const lastPayment = payments.map((p) => p.date).sort().at(-1);

  return {
    id,
    number: detail.invoice_number ?? '',
    reference: detail.reference ?? '',
    status,
    currency,
    amountMinor,
    dueAmountMinor,
    invoiceDate,
    dueDate,
    paidOn: lastPayment,
    payments,
    payerViewUrl: detail.metadata?.recipient_view_url,
  };
}

/**
 * The invoice id a webhook event refers to. Invoicing v2 events wrap the
 * invoice as `resource.invoice`; older/simulated shapes put it at `resource`.
 * Only the id is read: the handler always re-fetches the invoice from PayPal.
 */
export function invoiceIdFromEvent(event: PayPalWebhookEvent): string | undefined {
  const r = event.resource as { id?: unknown; invoice?: { id?: unknown } } | undefined;
  const id = r?.invoice?.id ?? r?.id;
  return typeof id === 'string' && /^[A-Za-z0-9-]{6,40}$/.test(id) ? id : undefined;
}

export const INVOICE_EVENT_TYPES = [
  'INVOICING.INVOICE.PAID',
  'INVOICING.INVOICE.CANCELLED',
  'INVOICING.INVOICE.REFUNDED',
  'INVOICING.INVOICE.UPDATED',
  'INVOICING.INVOICE.SCHEDULED',
  'INVOICING.INVOICE.CREATED',
] as const;
