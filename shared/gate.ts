/**
 * The approval gate.
 *
 * Every PayPal write goes through `GatedPayPal`, and every method on it takes a
 * proposal id rather than free arguments. The gate looks the proposal up in the
 * approvals ledger and refuses unless a user approved it. The amounts, dates,
 * recipient and text that reach PayPal are read from the approved proposal, so
 * what executes is exactly what the user saw when they clicked Approve.
 *
 * Nothing else in the codebase may call a gateway write method (a test greps
 * for it).
 */
import type { IssueInvoicePayload, Proposal, ProposalKind } from './contract.ts';
import type { InvoiceRecord, PayPalGateway } from './paypal/gateway.ts';

export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalRequiredError';
  }
}

export interface ApprovalLedger {
  getProposal(id: string): Proposal | undefined;
}

export interface IssueExtras {
  number: string;
  reference: string;
  note?: string;
}

export class GatedPayPal {
  constructor(
    private readonly gateway: PayPalGateway,
    private readonly approvals: ApprovalLedger,
  ) {}

  /** The proposal, if and only if a user has approved it and it has not run yet. */
  private approved<K extends ProposalKind>(proposalId: string, kind: K): Proposal & { kind: K } {
    const p = this.approvals.getProposal(proposalId);
    if (!p) throw new ApprovalRequiredError(`No proposal ${proposalId}: PayPal writes need a recorded approval.`);
    if (p.kind !== kind) throw new ApprovalRequiredError(`Proposal ${proposalId} is a ${p.kind}, not a ${kind}.`);
    if (p.status !== 'executing' || p.decidedBy !== 'user' || !p.decidedAt) {
      throw new ApprovalRequiredError(`Proposal ${proposalId} has not been approved by the user (status: ${p.status}).`);
    }
    if (p.executedAt) throw new ApprovalRequiredError(`Proposal ${proposalId} was already executed.`);
    return p as Proposal & { kind: K };
  }

  /** create_invoice + send_invoice under one approval. */
  async issueInvoice(proposalId: string, extras: IssueExtras): Promise<InvoiceRecord> {
    const p = this.approved(proposalId, 'issue_invoice');
    const payload = p.payload as IssueInvoicePayload;
    const draft = await this.gateway.createInvoice({
      requestId: `${proposalId}-create`,
      number: extras.number,
      reference: extras.reference,
      currency: payload.currency,
      recipientName: payload.clientName,
      recipientEmail: payload.clientEmail,
      itemName: payload.itemName,
      itemDescription: payload.itemDescription,
      amountMinor: payload.amountMinor,
      invoiceDate: payload.invoiceDate,
      dueDate: payload.dueDate,
      note: extras.note,
    });
    return this.gateway.sendInvoice(draft.id, { requestId: `${proposalId}-send` });
  }

  /** send_invoice_reminder */
  async sendReminder(proposalId: string): Promise<void> {
    const p = this.approved(proposalId, 'send_reminder');
    if (p.payload.kind !== 'send_reminder') throw new ApprovalRequiredError('Proposal payload does not match its kind.');
    await this.gateway.sendReminder(p.payload.invoiceId, { subject: p.payload.subject, note: p.payload.note });
  }

  /** cancel_sent_invoice */
  async cancelInvoice(proposalId: string): Promise<void> {
    const p = this.approved(proposalId, 'cancel_invoice');
    if (p.payload.kind !== 'cancel_invoice') throw new ApprovalRequiredError('Proposal payload does not match its kind.');
    await this.gateway.cancelInvoice(p.payload.invoiceId, { subject: p.payload.subject, note: p.payload.note });
  }

  /** Reads need no approval. */
  getInvoice(invoiceId: string): Promise<InvoiceRecord> {
    return this.gateway.getInvoice(invoiceId);
  }
}
