/**
 * The single server <-> client contract for Paceline.
 *
 * Everything the browser sends or receives is typed here. The same types are
 * used by the Node server, by the in-browser mock backend (`?mock=1`) and by
 * the React UI, so a designer can restyle the UI against the mock without a
 * backend and nothing drifts.
 *
 * Conventions
 *  - Money is always an integer number of minor units (cents). Never floats.
 *  - Calendar dates are `YYYY-MM-DD` strings (no time zone). Instants are ISO 8601.
 *  - Figures (amounts, dates, ids, statuses) originate from the user's plan or
 *    from PayPal responses. Model output is prose and proposals only.
 */

export type ISODate = string;
export type ISODateTime = string;
export type Minor = number;

export type PayPalMode = 'simulator' | 'sandbox';
export type PlannerKind = 'nebius' | 'scripted';
export type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'CAD' | 'AUD';
export const CURRENCIES: readonly CurrencyCode[] = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];

/* ───────────────────────────── Plan ───────────────────────────── */

/** What has to happen to the upstream milestone before this one may start. */
export type GateKind = 'paid' | 'delivered';

export interface MilestoneDep {
  /** id of the upstream milestone */
  on: string;
  /** `paid`: its invoice is paid. `delivered`: its work is delivered. */
  gate: GateKind;
}

export interface Milestone {
  id: string;
  title: string;
  deliverable: string;
  /** Working days of effort. 0 = billing-only milestone (e.g. a deposit). */
  durationDays: number;
  amountMinor: Minor;
  /** Payment term: calendar days between invoice date and due date. */
  netDays: number;
  dependsOn: MilestoneDep[];
}

export interface ClientParty {
  name: string;
  email: string;
}

export interface Plan {
  title: string;
  client: ClientParty;
  currency: CurrencyCode;
  startDate: ISODate;
  milestones: Milestone[];
}

export type WarningCode =
  | 'total_not_in_brief'
  | 'email_missing'
  | 'email_not_in_brief'
  | 'client_not_in_brief'
  | 'start_in_past'
  | 'amount_not_in_brief'
  | 'scripted_planner';

export interface PlanWarning {
  code: WarningCode;
  message: string;
  milestoneId?: string;
}

/* ─────────────────────────── Schedule ─────────────────────────── */

export type WorkState = 'blocked' | 'scheduled' | 'in_progress' | 'late' | 'delivered';
export type PayState = 'planned' | 'ready_to_invoice' | 'awaiting' | 'overdue' | 'paid';

export interface ScheduledMilestone {
  milestoneId: string;
  /** First working day of the work (for 0-day milestones: the day it falls on). */
  workStart: ISODate;
  /** Last working day, inclusive. */
  workEnd: ISODate;
  workState: WorkState;
  /** Day the invoice is (or is planned to be) issued. */
  invoiceOn: ISODate;
  dueOn: ISODate;
  /** Actual paid date when `paidActual`, otherwise the projection the schedule uses. */
  paidOn: ISODate;
  paidActual: boolean;
  payState: PayState;
  /** Upstream milestone ids whose gate is not yet satisfied. */
  blockedBy: string[];
}

export interface Schedule {
  asOf: ISODate;
  items: ScheduledMilestone[];
  /** Last working day of the last milestone. */
  deliveryDate: ISODate;
  /** Day the last invoice is (projected to be) paid. */
  finalPaymentDate: ISODate;
}

export interface ScheduleShift {
  milestoneId: string;
  field: 'workStart' | 'workEnd' | 'paidOn';
  from: ISODate;
  to: ISODate;
  /** Calendar days; positive = later. */
  deltaDays: number;
}

/* ─────────────────────────── Projects ─────────────────────────── */

export type ProjectStatus = 'draft' | 'active' | 'completed';

export interface MilestoneProgress {
  deliveredOn?: ISODate;
  invoiceId?: string;
}

export interface Project {
  id: string;
  status: ProjectStatus;
  plan: Plan;
  /** The brief the plan was drafted from (kept for the grounding check). */
  brief: string;
  origin: 'agent' | 'sample';
  plannedBy: PlannerKind;
  warnings: PlanWarning[];
  progress: Record<string, MilestoneProgress>;
  /** Live schedule, recomputed from the plan + PayPal facts + the clock. */
  schedule: Schedule;
  /** Schedule frozen when the user approved the plan. */
  baseline?: Schedule;
  /** Calendar days the delivery date has moved against the baseline (+ = later). */
  knockOnDays: number;
  createdAt: ISODateTime;
  approvedAt?: ISODateTime;
}

/* ─────────────────────────── Invoices ─────────────────────────── */

/** Invoicing v2 `invoice_status` enum, verbatim from PayPal's OpenAPI spec. */
export type PayPalInvoiceStatus =
  | 'DRAFT' | 'SENT' | 'SCHEDULED' | 'PAID' | 'MARKED_AS_PAID' | 'CANCELLED'
  | 'REFUNDED' | 'PARTIALLY_PAID' | 'PARTIALLY_REFUNDED' | 'MARKED_AS_REFUNDED'
  | 'UNPAID' | 'PAYMENT_PENDING' | 'AUTO_CANCELLED' | 'PAID_EXTERNAL'
  | 'REFUNDED_EXTERNAL' | 'SHARED';

export interface InvoicePayment {
  id: string;
  date: ISODate;
  method: string;
  amountMinor: Minor;
}

/** An invoice that exists in PayPal (or in the simulator). */
export interface Invoice {
  id: string;
  number: string;
  projectId: string;
  milestoneId: string;
  status: PayPalInvoiceStatus;
  currency: CurrencyCode;
  amountMinor: Minor;
  dueAmountMinor: Minor;
  invoiceDate: ISODate;
  dueDate: ISODate;
  /** Derived by Paceline (PayPal has no OVERDUE status): awaiting payment and past due. */
  overdue: boolean;
  /** Calendar days past due (0 when not overdue). */
  daysOverdue: number;
  paidOn?: ISODate;
  payments: InvoicePayment[];
  /** PayPal's payer-facing page (sandbox mode). Absent in the simulator. */
  payerViewUrl?: string;
  remindersSent: number;
  source: PayPalMode;
  syncedAt: ISODateTime;
}

/** Row model for the ledger grid: real invoices plus not-yet-issued plan lines. */
export type LedgerStatus = 'planned' | 'draft' | 'awaiting' | 'overdue' | 'paid' | 'cancelled' | 'refunded';

export interface LedgerRow {
  rowId: string;
  kind: 'invoice' | 'planned';
  invoiceId?: string;
  number: string;
  client: string;
  project: string;
  projectId: string;
  milestone: string;
  milestoneId: string;
  status: LedgerStatus;
  paypalStatus?: PayPalInvoiceStatus;
  currency: CurrencyCode;
  amountMinor: Minor;
  paidMinor: Minor;
  balanceMinor: Minor;
  issuedOn?: ISODate;
  dueOn: ISODate;
  paidOn?: ISODate;
  /** Negative = days until due, positive = days overdue; undefined once settled. */
  daysPastDue?: number;
  paymentId?: string;
  paymentMethod?: string;
  remindersSent: number;
  /** Sandbox mode, open invoices only: PayPal's payer page on sandbox.paypal.com. */
  payerViewUrl?: string;
}

/* ───────────────────── Approvals & action log ───────────────────── */

export type ProposalKind = 'issue_invoice' | 'send_reminder' | 'cancel_invoice';
export type ProposalStatus = 'pending' | 'executing' | 'executed' | 'rejected' | 'failed' | 'superseded';

export interface IssueInvoicePayload {
  kind: 'issue_invoice';
  projectId: string;
  milestoneId: string;
  clientName: string;
  clientEmail: string;
  currency: CurrencyCode;
  amountMinor: Minor;
  invoiceDate: ISODate;
  dueDate: ISODate;
  itemName: string;
  itemDescription: string;
}

export interface SendReminderPayload {
  kind: 'send_reminder';
  projectId: string;
  milestoneId: string;
  invoiceId: string;
  invoiceNumber: string;
  clientEmail: string;
  /** Drafted by the agent; the user may edit both before approving. */
  subject: string;
  note: string;
  draftedBy: 'model' | 'template';
}

export interface CancelInvoicePayload {
  kind: 'cancel_invoice';
  projectId: string;
  milestoneId: string;
  invoiceId: string;
  invoiceNumber: string;
  clientEmail: string;
  subject: string;
  note: string;
}

export type ProposalPayload = IssueInvoicePayload | SendReminderPayload | CancelInvoicePayload;

/**
 * Something the agent wants to do that touches money or a client. Nothing in
 * `ProposalKind` reaches PayPal until a user approves it.
 */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  title: string;
  /** Why the agent is proposing this (figures are checked against facts). */
  rationale: string;
  payload: ProposalPayload;
  /** PayPal operations that approval will trigger, in order (agent-toolkit tool names). */
  paypalCalls: string[];
  proposedBy: 'agent' | 'user';
  createdAt: ISODateTime;
  decidedAt?: ISODateTime;
  decidedBy?: 'user';
  executedAt?: ISODateTime;
  error?: string;
  /** Invoice number reserved for this proposal on its first execution (kept across retries). */
  assignedNumber?: string;
}

export type Actor = 'user' | 'agent' | 'paypal' | 'system';

export interface LogEntry {
  id: string;
  at: ISODateTime;
  actor: Actor;
  /** Short machine-ish verb, e.g. `plan.approved`, `invoice.sent`, `webhook.received`. */
  action: string;
  summary: string;
  projectId?: string;
  proposalId?: string;
  invoiceId?: string;
}

/* ─────────────────────────── Agent runs ─────────────────────────── */

/** `approval` and `action` are short deterministic notes after the user approves a plan or a PayPal action. */
export type RunKind = 'plan' | 'payment' | 'overdue' | 'delivery' | 'ledger' | 'approval' | 'action';
export type StepStatus = 'active' | 'done' | 'error';

export interface RunStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface AgentRun {
  id: string;
  kind: RunKind;
  title: string;
  status: 'running' | 'done' | 'error';
  steps: RunStep[];
  /** The agent's explanation. Verified by the no-invention guard before it is emitted. */
  message?: string;
  /** `model` = written by the LLM and verified; `template` = deterministic text. */
  messageBy?: 'model' | 'template';
  error?: string;
  projectId?: string;
  startedAt: ISODateTime;
  endedAt?: ISODateTime;
}

/** A change the engine made to a schedule, with what caused it. Drives the unlock animation. */
export interface ChangeSet {
  id: string;
  projectId: string;
  cause: 'payment' | 'overdue' | 'delivery' | 'approval' | 'clock' | 'cancel';
  at: ISODateTime;
  invoiceId?: string;
  /** Milestones whose work became unblocked by this change. */
  unlocked: string[];
  shifts: ScheduleShift[];
  deliveryFrom: ISODate;
  deliveryTo: ISODate;
  deliveryDeltaDays: number;
}

/* ─────────────────────────── App state ─────────────────────────── */

export interface AppInfo {
  mode: PayPalMode;
  /** Always the sandbox host; shown in the footer. */
  paypalHost: string;
  planner: PlannerKind;
  plannerModel?: string;
  /** Running in the browser without a backend. */
  mock: boolean;
  /** The workspace's "today" (simulator mode lets the visitor move it). */
  today: ISODate;
  clockOffsetDays: number;
  agGridLicensed: boolean;
  version: string;
  /** In shared-sandbox mode invoices are addressed to this buyer, not the brief's email. */
  sandboxBuyerEmail?: string;
}

export interface WorkspaceState {
  info: AppInfo;
  projects: Project[];
  invoices: Invoice[];
  proposals: Proposal[];
  log: LogEntry[];
  runs: AgentRun[];
  /** Most recent change, so a page reload can still show what last happened. */
  lastChange?: ChangeSet;
}

/* ───────────────────────── Server events (SSE) ───────────────────────── */

export type ServerEvent =
  | { type: 'snapshot'; state: WorkspaceState }
  | { type: 'info'; info: AppInfo }
  | { type: 'run'; run: AgentRun }
  | { type: 'project'; project: Project }
  | { type: 'project.removed'; projectId: string }
  | { type: 'invoice'; invoice: Invoice }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'log'; entry: LogEntry }
  | { type: 'change'; change: ChangeSet };

/* ───────────────────────────── HTTP API ───────────────────────────── */

export interface ApiError {
  error: { code: string; message: string; details?: string[] };
}

export interface StartPlanRunRequest { brief: string }
export interface StartPlanRunResponse { runId: string }

export interface UpdatePlanRequest { plan: Plan }
export interface ApproveProposalRequest { subject?: string; note?: string }
export interface SimPayRequest { invoiceId: string }
export interface SimClockRequest { days: number }
export interface CancelRequest { invoiceId: string }

/** Natural-language ledger control. */
export interface LedgerQueryRequest {
  query: string;
}

export interface LedgerIntent {
  /** Column filters, AND-ed. */
  filters: LedgerFilter[];
  groupBy: LedgerColumn[];
  sort: { column: LedgerColumn; dir: 'asc' | 'desc' }[];
  /** true = start from a clean grid before applying. */
  reset: boolean;
}

export type LedgerColumn =
  | 'number' | 'client' | 'project' | 'milestone' | 'status'
  | 'amountMinor' | 'balanceMinor' | 'paidMinor' | 'issuedOn' | 'dueOn' | 'paidOn' | 'daysPastDue';

export type LedgerFilter =
  | { column: 'status'; op: 'in'; values: LedgerStatus[] }
  | { column: 'client' | 'project' | 'milestone' | 'number'; op: 'contains'; value: string }
  | { column: 'amountMinor' | 'balanceMinor' | 'paidMinor' | 'daysPastDue'; op: 'gt' | 'lt' | 'gte' | 'lte' | 'eq'; value: number }
  | { column: 'issuedOn' | 'dueOn' | 'paidOn'; op: 'before' | 'after' | 'between'; from?: ISODate; to?: ISODate };

export interface LedgerQueryResponse {
  /** The request as a compact, typed intent. The client applies it through AG Grid's filter, grouping and sort APIs. */
  intent: LedgerIntent;
  explanation: string;
  by: 'model' | 'rules';
  understood: boolean;
}

/** The API surface the UI talks to. Implemented by `HttpBackend` and `MockBackend`. */
export interface Backend {
  getState(): Promise<WorkspaceState>;
  subscribe(onEvent: (e: ServerEvent) => void, onStatus?: (s: 'open' | 'reconnecting') => void): () => void;
  startPlanRun(brief: string): Promise<StartPlanRunResponse>;
  updatePlan(projectId: string, plan: Plan): Promise<Project>;
  approvePlan(projectId: string): Promise<Project>;
  discardProject(projectId: string): Promise<void>;
  markDelivered(projectId: string, milestoneId: string): Promise<Project>;
  approveProposal(proposalId: string, edits?: ApproveProposalRequest): Promise<Proposal>;
  rejectProposal(proposalId: string): Promise<Proposal>;
  requestCancel(invoiceId: string): Promise<Proposal>;
  ledgerQuery(req: LedgerQueryRequest): Promise<LedgerQueryResponse>;
  /** Simulator-only controls. They reject in sandbox mode. */
  simPay(invoiceId: string): Promise<void>;
  simAdvanceClock(days: number): Promise<void>;
  simLoadSample(): Promise<void>;
  reset(): Promise<void>;
}

export const LIMITS = {
  briefMaxChars: 6000,
  maxMilestones: 12,
  maxProjects: 8,
  maxAmountMinor: 100_000_000, // 1,000,000.00
  maxDurationDays: 120,
  maxNetDays: 90,
  ledgerQueryMaxChars: 200,
} as const;
