/**
 * The PayPal webhook handler. One code path for real deliveries (sandbox mode)
 * and for the simulator's deliveries.
 *
 *  1. Verify the signature over the raw body, before parsing anything.
 *  2. Drop duplicates by event id (PayPal retries; deliveries can also race).
 *  3. Take only the invoice id from the payload, find the workspace that owns
 *     it, and let the engine re-read the invoice from PayPal.
 *  4. Record the event id only after it was applied, so a failure is retried.
 */
import { invoiceIdFromEvent, type PayPalGateway, type PayPalWebhookEvent } from './paypal/gateway.ts';

export const WEBHOOK_MAX_BYTES = 256 * 1024;

export interface WebhookTarget {
  onInvoiceEvent(invoiceId: string, eventType: string): Promise<void>;
}

export interface WebhookDeps {
  /** The gateway whose `verifyWebhook` vouches for the delivery. */
  gateway: Pick<PayPalGateway, 'verifyWebhook'>;
  /** Processed event ids (persisted by the server). */
  seen: { has(id: string): boolean; add(id: string): void };
  /** The workspace that owns an invoice, if any. */
  route(invoiceId: string): WebhookTarget | undefined;
}

export type WebhookResult =
  | { status: 200; outcome: 'applied' | 'duplicate' | 'ignored'; reason?: string }
  | { status: 400 | 401 | 413 | 500; outcome: 'rejected' | 'failed'; reason: string };

const inFlight = new Set<string>();

export async function handleWebhook(deps: WebhookDeps, headers: Record<string, string | undefined>, rawBody: string): Promise<WebhookResult> {
  if (rawBody.length > WEBHOOK_MAX_BYTES) return { status: 413, outcome: 'rejected', reason: 'body_too_large' };

  let verified = false;
  try {
    verified = await deps.gateway.verifyWebhook(headers, rawBody);
  } catch {
    // Could not reach the verifier: ask PayPal to retry rather than trust or drop the event.
    return { status: 500, outcome: 'failed', reason: 'verification_unavailable' };
  }
  if (!verified) return { status: 401, outcome: 'rejected', reason: 'signature_invalid' };

  let event: PayPalWebhookEvent;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent;
  } catch {
    return { status: 400, outcome: 'rejected', reason: 'invalid_json' };
  }
  if (!event || typeof event.id !== 'string' || !/^[\w-]{6,80}$/.test(event.id) || typeof event.event_type !== 'string') {
    return { status: 400, outcome: 'rejected', reason: 'invalid_event' };
  }

  if (deps.seen.has(event.id) || inFlight.has(event.id)) return { status: 200, outcome: 'duplicate' };

  if (!event.event_type.startsWith('INVOICING.INVOICE.')) {
    deps.seen.add(event.id);
    return { status: 200, outcome: 'ignored', reason: 'event_type_not_handled' };
  }
  const invoiceId = invoiceIdFromEvent(event);
  const target = invoiceId ? deps.route(invoiceId) : undefined;
  if (!invoiceId || !target) {
    deps.seen.add(event.id);
    return { status: 200, outcome: 'ignored', reason: invoiceId ? 'unknown_invoice' : 'no_invoice_id' };
  }

  inFlight.add(event.id);
  try {
    await target.onInvoiceEvent(invoiceId, event.event_type);
    deps.seen.add(event.id);
    return { status: 200, outcome: 'applied' };
  } catch {
    return { status: 500, outcome: 'failed', reason: 'apply_failed' };
  } finally {
    inFlight.delete(event.id);
  }
}
