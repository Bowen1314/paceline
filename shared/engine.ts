/**
 * The workspace engine: one visitor's projects, invoices, approvals and log,
 * and every rule about how they change.
 *
 * It is isomorphic. The Node server hosts one `Workspace` per visitor session
 * (HTTP + SSE + JSON persistence around it); `?mock=1` hosts one in the browser
 * with the simulator and the scripted planner. Same code, so the mock cannot
 * drift from the real thing.
 *
 * Invariants
 *  - PayPal writes only happen in `execute()`, through the approval gate.
 *  - Schedules are only ever produced by `computeSchedule` from the approved
 *    plan + PayPal facts + the clock. No model output changes a schedule.
 *  - Model prose is attached to a run only after the no-invention guard passes.
 */
import type {
  AgentRun, AppInfo, ChangeSet, ISODate, Invoice, LogEntry, Actor, Milestone, PayPalMode, Plan, PlannerKind, Project, Proposal,
  ProposalPayload, RunKind, ServerEvent, StepStatus, WorkspaceState, ApproveProposalRequest, LedgerQueryRequest, LedgerQueryResponse,
} from './contract.ts';
import { LIMITS } from './contract.ts';
import { addDays, dateInZone, dateOf, diffDays, formatDate } from './dates.ts';
import { GatedPayPal } from './gate.ts';
import { checkProse, describeViolations, type Facts } from './guard.ts';
import { parseLedgerQuery } from './ledger.ts';
import { formatMoney } from './money.ts';
import { PAYPAL_SANDBOX_HOST, PayPalError, type InvoiceRecord, type PayPalGateway } from './paypal/gateway.ts';
import { PayPalSimulator, randomToken, type SignedWebhook, type SimulatorState } from './paypal/simulator.ts';
import { approvalBlockers, planTotal, planWarnings, validatePlan } from './plan.ts';
import type { Planner, WriteTask } from './planner/types.ts';
import {
  cancelTemplate, explainApproval, explainCancelled, explainDelivery, explainInvoiceSent, explainOverdue, explainPayment, explainPlan, explainReminderSent, factsFor, issueRationale, reminderRationale, reminderTemplate,
  type ProseKind,
} from './prose.ts';
import {
  computeBaseline, computeSchedule, diffSchedules, isAwaitingPayment, isDead, isOverdue, isSettled, knockOnDays, newlyUnlocked,
  type ScheduleFacts,
} from './schedule.ts';

export const VERSION = '0.1.0';
const DAY_MS = 86_400_000;

/** An error the HTTP layer turns into a 4xx with a stable code. */
export class Problem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'Problem';
  }
}

export interface WorkspaceData {
  v: 1;
  id: string;
  /** Short tag used in invoice numbers so shared-sandbox visitors never collide. */
  tag: string;
  createdAt: string;
  clockOffsetDays: number;
  seq: number;
  invoiceSeq: number;
  projects: Project[];
  invoices: Invoice[];
  proposals: Proposal[];
  log: LogEntry[];
  runs: AgentRun[];
  lastChange?: ChangeSet;
  /** invoice id -> day the overdue flow last ran for it */
  overdueHandled: Record<string, ISODate>;
  sim?: SimulatorState;
  /**
   * Server, operator mode: 'sandbox' marks a workspace the operator unlocked
   * for the live PayPal sandbox; `operatorKey` is a fingerprint of the token
   * that unlocked it. Absent = simulator (unless every visitor is live).
   */
  paypal?: 'sandbox';
  operatorKey?: string;
}

export function newWorkspaceData(id: string, now: Date): WorkspaceData {
  return {
    v: 1, id, tag: randomToken(4), createdAt: now.toISOString(), clockOffsetDays: 0, seq: 0, invoiceSeq: 0,
    projects: [], invoices: [], proposals: [], log: [], runs: [], overdueHandled: {},
  };
}

export interface EngineEnv {
  gateway: PayPalGateway;
  planner: Planner;
  now: () => Date;
  emit: (e: ServerEvent) => void;
  /** Called after every state change (the server persists here). */
  changed?: () => void;
  /** Tell the host which workspace owns a PayPal invoice (webhook routing). */
  registerInvoice?: (invoiceId: string) => void;
  /** Run a model call under the host's concurrency cap. */
  withModelSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  mock: boolean;
  agGridLicensed: boolean;
  /** Shared-sandbox mode: invoices are addressed to this buyer instead of the brief's email. */
  sandboxBuyerEmail?: string;
  /**
   * IANA time zone that defines "today" (invoice dates, due dates, overdue).
   * Should be the PayPal merchant's zone or one west of it: PayPal schedules,
   * rather than sends, an invoice whose date is after the merchant's today.
   * Unset = UTC.
   */
  timeZone?: string;
}

interface ProseJob {
  run: AgentRun;
  kind: ProseKind;
  template: string;
  facts: Facts;
  /** Overdue runs: the reminder proposal the model may redraft (guarded) after the explanation. */
  reminder?: { proposalId: string; projectId: string; invoiceId: string };
}

/** "+3 days vs the approved plan" / "on the approved plan" / "2 days ahead of the approved plan". */
function versusPlan(knockOnDays: number): string {
  if (knockOnDays === 0) return 'on the approved plan';
  const n = Math.abs(knockOnDays);
  return knockOnDays > 0 ? `+${n} day${n === 1 ? '' : 's'} vs the approved plan` : `${n} day${n === 1 ? '' : 's'} ahead of the approved plan`;
}

export class Workspace {
  private readonly gate: GatedPayPal;
  private chain: Promise<unknown> = Promise.resolve();
  /** Sample replay: no events, no model calls, log entries marked as sample data. */
  private replaying = false;

  constructor(
    public data: WorkspaceData,
    private readonly env: EngineEnv,
  ) {
    this.gate = new GatedPayPal(env.gateway, { getProposal: (id) => this.data.proposals.find((p) => p.id === id) });
  }

  /* ───────────── clock, ids, plumbing ───────────── */

  today(): ISODate {
    const now = this.env.now();
    return addDays(this.env.timeZone ? dateInZone(now, this.env.timeZone) : dateOf(now), this.data.clockOffsetDays);
  }

  /** The workspace's shifted "now" (simulator clock). */
  nowDate(): Date {
    return new Date(this.env.now().getTime() + this.data.clockOffsetDays * DAY_MS);
  }

  private nowISO(): string {
    return this.nowDate().toISOString();
  }

  private newId(prefix: string): string {
    return `${prefix}_${(++this.data.seq).toString(36)}${randomToken(4).toLowerCase()}`;
  }

  private emit(e: ServerEvent): void {
    if (!this.replaying) this.env.emit(e);
    this.env.changed?.();
  }

  /** Serialise state changes; model calls happen outside this lock. */
  private exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  info(): AppInfo {
    return {
      mode: this.env.gateway.mode,
      paypalHost: PAYPAL_SANDBOX_HOST,
      planner: this.env.planner.kind as PlannerKind,
      plannerModel: this.env.planner.model,
      mock: this.env.mock,
      today: this.today(),
      clockOffsetDays: this.data.clockOffsetDays,
      agGridLicensed: this.env.agGridLicensed,
      version: VERSION,
      sandboxBuyerEmail: this.env.sandboxBuyerEmail,
    };
  }

  snapshot(): WorkspaceState {
    const d = this.data;
    return structuredClone({
      info: this.info(), projects: d.projects, invoices: d.invoices, proposals: d.proposals, log: d.log, runs: d.runs, lastChange: d.lastChange,
    });
  }

  private log(actor: Actor, action: string, summary: string, refs: Partial<Pick<LogEntry, 'projectId' | 'proposalId' | 'invoiceId'>> = {}): void {
    const entry: LogEntry = {
      id: this.newId('log'), at: this.nowISO(), actor: this.replaying ? 'system' : actor, action,
      summary: this.replaying ? `[sample data] ${summary}` : summary, ...refs,
    };
    this.data.log.push(entry);
    if (this.data.log.length > 300) this.data.log.splice(0, this.data.log.length - 300);
    this.emit({ type: 'log', entry });
  }

  private project(id: string): Project {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) throw new Problem(404, 'project_not_found', 'That project does not exist in this workspace.');
    return p;
  }

  private invoice(id: string): Invoice {
    const i = this.data.invoices.find((x) => x.id === id);
    if (!i) throw new Problem(404, 'invoice_not_found', 'That invoice does not exist in this workspace.');
    return i;
  }

  /** Which PayPal this workspace talks to. */
  get paypalMode(): PayPalMode {
    return this.env.gateway.mode;
  }

  /** The planner this workspace uses (the host may wrap the model planner, e.g. in a spend guard). */
  get planner(): Planner {
    return this.env.planner;
  }

  ownsInvoice(id: string): boolean {
    return this.data.invoices.some((i) => i.id === id);
  }

  /* ───────────── runs ───────────── */

  private startRun(kind: RunKind, title: string, projectId?: string): AgentRun {
    const run: AgentRun = { id: this.newId('run'), kind, title, status: 'running', steps: [], projectId, startedAt: this.nowISO() };
    this.data.runs.push(run);
    if (this.data.runs.length > 20) this.data.runs.splice(0, this.data.runs.length - 20);
    this.emit({ type: 'run', run });
    return run;
  }

  /** A finished, deterministic note in the agent panel (no model call): what just happened and what happens next. */
  private note(kind: RunKind, title: string, projectId: string, message: string): void {
    if (this.replaying) return;
    const run = this.startRun(kind, title, projectId);
    run.message = message;
    run.messageBy = 'template';
    this.endRun(run);
  }

  private step(run: AgentRun, id: string, label: string, status: StepStatus = 'done', detail?: string): void {
    for (const s of run.steps) if (s.status === 'active' && s.id !== id) s.status = 'done';
    const existing = run.steps.find((s) => s.id === id);
    if (existing) Object.assign(existing, { label, status, detail });
    else run.steps.push({ id, label, status, detail });
    this.emit({ type: 'run', run });
  }

  private endRun(run: AgentRun, error?: string): void {
    for (const s of run.steps) if (s.status === 'active') s.status = error ? 'error' : 'done';
    run.status = error ? 'error' : 'done';
    run.error = error;
    run.endedAt = this.nowISO();
    this.emit({ type: 'run', run });
  }

  /**
   * Attach the agent's explanation to a run. The model's text is used only if
   * every figure in it is a known fact; one retry, then the template.
   */
  private async explain(job: ProseJob): Promise<void> {
    const { run, kind, template, facts } = job;
    let text = template;
    let by: 'model' | 'template' = 'template';
    const planner = this.env.planner;
    if (planner.kind !== 'scripted' && !this.replaying) {
      this.step(run, 'write', 'Writing the explanation', 'active');
      const call = async (task: WriteTask): Promise<string | null> =>
        this.env.withModelSlot ? this.env.withModelSlot(() => planner.write(task)) : planner.write(task);
      try {
        const task: WriteTask = { kind, situation: template, template, facts };
        let out = await call(task);
        let bad = out ? checkProse(out, facts) : [];
        if (out && bad.length > 0) {
          out = await call({ ...task, rejected: describeViolations(bad) });
          bad = out ? checkProse(out, facts) : [];
        }
        if (out && bad.length === 0) {
          text = out.trim();
          by = 'model';
          this.step(run, 'write', 'Explanation checked: every figure matches a known fact');
        } else {
          this.step(run, 'write', out ? `Model text rejected by the no-invention guard (${describeViolations(bad)}); using the template` : 'Using the template explanation');
        }
      } catch {
        this.step(run, 'write', 'Model unavailable; using the template explanation');
      }
    }
    await this.exclusive(() => {
      run.message = text;
      run.messageBy = by;
      this.endRun(run);
    });
    if (job.reminder) await this.redraftReminder(job.reminder);
  }

  /**
   * Let the model reword a template reminder. The draft replaces the template
   * only if it passes the guard and the user has not touched the proposal.
   */
  private async redraftReminder(ref: NonNullable<ProseJob['reminder']>): Promise<void> {
    const planner = this.env.planner;
    if (planner.kind === 'scripted' || this.replaying) return;
    const project = this.data.projects.find((p) => p.id === ref.projectId);
    const invoice = this.data.invoices.find((i) => i.id === ref.invoiceId);
    if (!project || !invoice) return;
    const template = reminderTemplate(project, invoice);
    const facts = factsFor('reminder', project, this.data.invoices, this.today());
    const task: WriteTask = { kind: 'reminder', situation: `${template.subject}\n${template.note}`, template: template.note, facts };
    const call = async (t: WriteTask): ReturnType<Planner['draftReminder']> =>
      this.env.withModelSlot ? this.env.withModelSlot(() => planner.draftReminder(t)) : planner.draftReminder(t);
    try {
      let draft = await call(task);
      let bad = draft ? checkProse(`${draft.subject}\n${draft.note}`, facts) : [];
      if (draft && bad.length > 0) {
        draft = await call({ ...task, rejected: describeViolations(bad) });
        bad = draft ? checkProse(`${draft.subject}\n${draft.note}`, facts) : [];
      }
      if (!draft || bad.length > 0) return;
      const accepted = draft;
      await this.exclusive(() => {
        const p = this.data.proposals.find((x) => x.id === ref.proposalId);
        if (!p || p.status !== 'pending' || p.payload.kind !== 'send_reminder') return;
        if (p.payload.subject !== template.subject || p.payload.note !== template.note) return; // the user already edited it
        p.payload.subject = accepted.subject.trim();
        p.payload.note = accepted.note.trim();
        p.payload.draftedBy = 'model';
        this.emit({ type: 'proposal', proposal: p });
      });
    } catch {
      /* keep the template */
    }
  }

  /* ───────────── schedule ───────────── */

  private factsOf(project: Project): ScheduleFacts {
    const facts: ScheduleFacts = { delivered: {}, invoices: {} };
    for (const [mid, prog] of Object.entries(project.progress)) {
      if (prog.deliveredOn) facts.delivered[mid] = prog.deliveredOn;
      const inv = prog.invoiceId ? this.data.invoices.find((i) => i.id === prog.invoiceId) : undefined;
      if (inv) facts.invoices[mid] = { status: inv.status, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate, paidOn: inv.paidOn };
    }
    return facts;
  }

  /** Recompute a project's schedule. Returns the change if anything moved. */
  private recompute(project: Project, cause: ChangeSet['cause'], invoiceId?: string): ChangeSet | undefined {
    const before = project.schedule;
    const after = computeSchedule(project.plan, project.status === 'draft' ? { delivered: {}, invoices: {} } : this.factsOf(project), this.today());
    project.schedule = after;
    project.knockOnDays = knockOnDays(project.baseline, after);
    if (project.status === 'active' && after.items.length > 0 && after.items.every((i) => i.paidActual)) project.status = 'completed';
    const shifts = diffSchedules(before, after);
    const unlocked = newlyUnlocked(before, after);
    const stateChanged = before.items.some((b, i) => b.workState !== after.items[i]?.workState || b.payState !== after.items[i]?.payState);
    if (shifts.length === 0 && unlocked.length === 0 && !stateChanged && before.asOf === after.asOf) return undefined;
    this.emit({ type: 'project', project });
    if (shifts.length === 0 && unlocked.length === 0) return undefined;
    const change: ChangeSet = {
      id: this.newId('chg'), projectId: project.id, cause, at: this.nowISO(), invoiceId, unlocked, shifts,
      deliveryFrom: before.deliveryDate, deliveryTo: after.deliveryDate, deliveryDeltaDays: diffDays(before.deliveryDate, after.deliveryDate),
    };
    this.data.lastChange = change;
    this.emit({ type: 'change', change });
    return change;
  }

  private emptyChange(project: Project, cause: ChangeSet['cause'], invoiceId?: string): ChangeSet {
    const d = project.schedule.deliveryDate;
    return { id: this.newId('chg'), projectId: project.id, cause, at: this.nowISO(), invoiceId, unlocked: [], shifts: [], deliveryFrom: d, deliveryTo: d, deliveryDeltaDays: 0 };
  }

  private syncInvoiceClock(): Invoice[] {
    const today = this.today();
    const becameOverdue: Invoice[] = [];
    for (const inv of this.data.invoices) {
      const overdue = isOverdue(inv.status, inv.dueDate, today);
      const days = overdue ? diffDays(inv.dueDate, today) : 0;
      if (overdue !== inv.overdue || days !== inv.daysOverdue) {
        if (overdue && !inv.overdue) becameOverdue.push(inv);
        inv.overdue = overdue;
        inv.daysOverdue = days;
        this.emit({ type: 'invoice', invoice: inv });
      }
    }
    return becameOverdue;
  }

  /* ───────────── proposals ───────────── */

  private propose(kind: Proposal['kind'], title: string, rationale: string, payload: ProposalPayload, paypalCalls: string[], by: 'agent' | 'user' = 'agent'): Proposal {
    const proposal: Proposal = { id: this.newId('prop'), kind, status: 'pending', title, rationale, payload, paypalCalls, proposedBy: by, createdAt: this.nowISO() };
    this.data.proposals.push(proposal);
    this.emit({ type: 'proposal', proposal });
    this.log(by, 'proposal.created', `Proposed: ${title}`, { proposalId: proposal.id, projectId: payload.projectId });
    return proposal;
  }

  /** Keep proposals in step with reality: propose invoices that are ready, refresh dates, retire stale ones. */
  private reconcile(): void {
    const today = this.today();
    for (const p of this.data.proposals) {
      if (p.status !== 'pending' && p.status !== 'failed' && p.status !== 'rejected') continue;
      const project = this.data.projects.find((x) => x.id === p.payload.projectId);
      const item = project?.schedule.items.find((i) => i.milestoneId === p.payload.milestoneId);
      let stale = !project || !item;
      if (!stale && p.payload.kind === 'issue_invoice') stale = item!.payState !== 'ready_to_invoice';
      if (!stale && p.payload.kind !== 'issue_invoice') {
        const inv = this.data.invoices.find((i) => i.id === (p.payload as { invoiceId: string }).invoiceId);
        stale = !inv || !isAwaitingPayment(inv.status);
      }
      if (stale) {
        p.status = 'superseded';
        this.emit({ type: 'proposal', proposal: p });
        continue;
      }
      if (p.payload.kind === 'issue_invoice' && p.status === 'pending' && p.payload.invoiceDate !== today) {
        const m = project!.plan.milestones.find((x) => x.id === p.payload.milestoneId)!;
        p.payload.invoiceDate = today;
        p.payload.dueDate = addDays(today, m.netDays);
        p.rationale = issueRationale(project!, m, p.payload.dueDate, this.wasIssuedBefore(project!.id, m.id));
        this.emit({ type: 'proposal', proposal: p });
      }
    }
    for (const project of this.data.projects) {
      if (project.status !== 'active') continue;
      for (const item of project.schedule.items) {
        if (item.payState !== 'ready_to_invoice') continue;
        const open = this.data.proposals.some((p) => p.kind === 'issue_invoice' && p.payload.projectId === project.id && p.payload.milestoneId === item.milestoneId && ['pending', 'executing', 'failed', 'rejected'].includes(p.status));
        if (open) continue;
        const m = project.plan.milestones.find((x) => x.id === item.milestoneId)!;
        const dueDate = addDays(today, m.netDays);
        const email = this.env.sandboxBuyerEmail ?? project.plan.client.email;
        this.propose(
          'issue_invoice',
          `Invoice ${project.plan.client.name} ${formatMoney(m.amountMinor, project.plan.currency)} for "${m.title}"`,
          issueRationale(project, m, dueDate, this.wasIssuedBefore(project.id, m.id)),
          {
            kind: 'issue_invoice', projectId: project.id, milestoneId: m.id, clientName: project.plan.client.name, clientEmail: email,
            currency: project.plan.currency, amountMinor: m.amountMinor, invoiceDate: today, dueDate,
            itemName: `${project.plan.title}: ${m.title}`.slice(0, 200), itemDescription: m.deliverable,
          },
          ['create_invoice', 'send_invoice'],
        );
      }
    }
  }

  private wasIssuedBefore(projectId: string, milestoneId: string): boolean {
    return this.data.proposals.some((p) => p.kind === 'issue_invoice' && p.status === 'executed' && p.payload.projectId === projectId && p.payload.milestoneId === milestoneId);
  }

  /* ───────────── planning ───────────── */

  /** Start drafting a plan from a brief. Returns at once; progress arrives as events. */
  startPlanRun(brief: string): { runId: string; done: Promise<void> } {
    const text = (brief ?? '').trim();
    if (text.length < 20) throw new Problem(400, 'brief_too_short', 'Paste a brief of at least a sentence or two.');
    if (text.length > LIMITS.briefMaxChars) throw new Problem(400, 'brief_too_long', `The brief is longer than ${LIMITS.briefMaxChars} characters.`);
    if (this.data.projects.length >= LIMITS.maxProjects) throw new Problem(409, 'too_many_projects', `This workspace already has ${LIMITS.maxProjects} projects. Discard a draft or reset the workspace.`);
    if (this.data.runs.some((r) => r.kind === 'plan' && r.status === 'running')) throw new Problem(409, 'run_in_progress', 'A plan is already being drafted.');
    const run = this.startRun('plan', 'Drafting a milestone plan');
    return { runId: run.id, done: this.planRun(run, text) };
  }

  private async planRun(run: AgentRun, brief: string): Promise<void> {
    const planner = this.env.planner;
    try {
      this.step(run, 'read', 'Reading the brief', 'active');
      let n = 0;
      const call = (): ReturnType<Planner['proposePlan']> => planner.proposePlan(brief, this.today(), (label) => this.step(run, `p${++n}`, label, 'active'));
      const proposal = await (this.env.withModelSlot ? this.env.withModelSlot(call) : call());
      const job = await this.exclusive((): ProseJob => {
        const project: Project = {
          id: this.newId('proj'), status: 'draft', plan: proposal.plan, brief, origin: 'agent', plannedBy: proposal.by ?? planner.kind, warnings: proposal.warnings,
          progress: {}, schedule: computeSchedule(proposal.plan, { delivered: {}, invoices: {} }, this.today()), knockOnDays: 0, createdAt: this.nowISO(),
        };
        this.data.projects.push(project);
        run.projectId = project.id;
        this.step(run, 'validate', 'Plan validated: schema, dependencies, and amounts checked against the brief');
        this.step(run, 'schedule', `Scheduled ${project.plan.milestones.length} milestones with payment gates`);
        this.emit({ type: 'project', project });
        this.log('agent', 'plan.proposed', `Drafted a ${project.plan.milestones.length}-milestone plan for ${project.plan.client.name} (${formatMoney(planTotal(project.plan), project.plan.currency)}). Not approved yet.`, { projectId: project.id });
        return { run, kind: 'plan', template: explainPlan(project), facts: factsFor('plan', project, this.data.invoices, this.today()) };
      });
      await this.explain(job);
    } catch (e) {
      const details = (e as { details?: string[] }).details;
      const msg = e instanceof Error ? e.message : 'Planning failed.';
      await this.exclusive(() => this.endRun(run, details?.length ? `${msg} ${details.slice(0, 3).join(' ')}` : msg));
    }
  }

  updatePlan(projectId: string, plan: Plan): Promise<Project> {
    return this.exclusive(() => {
      const project = this.project(projectId);
      if (project.status !== 'draft') throw new Problem(409, 'plan_locked', 'An approved plan cannot be edited.');
      const errors = validatePlan(plan);
      if (errors.length) throw new Problem(400, 'invalid_plan', 'The plan is not valid.', errors);
      project.plan = structuredClone(plan);
      project.warnings = [...planWarnings(project.plan, project.brief), ...project.warnings.filter((w) => w.code === 'scripted_planner')];
      project.schedule = computeSchedule(project.plan, { delivered: {}, invoices: {} }, this.today());
      this.emit({ type: 'project', project });
      return structuredClone(project);
    });
  }

  discardProject(projectId: string): Promise<void> {
    return this.exclusive(() => {
      const project = this.project(projectId);
      if (project.status !== 'draft') throw new Problem(409, 'plan_locked', 'Only a draft can be discarded.');
      this.data.projects = this.data.projects.filter((p) => p.id !== projectId);
      this.emit({ type: 'project.removed', projectId });
      this.log('user', 'plan.discarded', `Discarded the draft plan "${project.plan.title}".`);
    });
  }

  approvePlan(projectId: string): Promise<Project> {
    return this.exclusive(() => {
      const project = this.project(projectId);
      if (project.status !== 'draft') throw new Problem(409, 'already_approved', 'This plan is already approved.');
      const blockers = approvalBlockers(project.plan);
      if (blockers.length) throw new Problem(400, 'plan_not_approvable', 'The plan cannot be approved yet.', blockers);
      const today = this.today();
      if (project.plan.startDate < today) project.plan.startDate = today;
      project.status = 'active';
      project.approvedAt = this.nowISO();
      project.baseline = computeBaseline(project.plan, today);
      project.schedule = computeSchedule(project.plan, this.factsOf(project), today);
      project.knockOnDays = 0;
      this.emit({ type: 'project', project });
      this.log('user', 'plan.approved', `Approved the plan "${project.plan.title}": ${project.plan.milestones.length} milestones, ${formatMoney(planTotal(project.plan), project.plan.currency)}, delivery ${formatDate(project.baseline.deliveryDate)}.`, { projectId });
      this.reconcile();
      const first = project.schedule.items.find((i) => i.payState === 'ready_to_invoice');
      this.note('approval', `Plan approved · ${project.plan.title}`, project.id, explainApproval(project, first && project.plan.milestones.find((m) => m.id === first.milestoneId)));
      return structuredClone(project);
    });
  }

  /* ───────────── delivery ───────────── */

  async markDelivered(projectId: string, milestoneId: string): Promise<Project> {
    const job = await this.exclusive((): ProseJob => {
      const project = this.project(projectId);
      if (project.status !== 'active') throw new Problem(409, 'not_active', 'Approve the plan first.');
      const m = project.plan.milestones.find((x) => x.id === milestoneId);
      const item = project.schedule.items.find((i) => i.milestoneId === milestoneId);
      if (!m || !item) throw new Problem(404, 'milestone_not_found', 'No such milestone.');
      if (item.workState === 'delivered') throw new Problem(409, 'already_delivered', 'This milestone is already delivered.');
      if (item.blockedBy.length > 0) throw new Problem(409, 'milestone_blocked', 'This milestone is still locked by an unpaid invoice or undelivered work upstream.');
      project.progress[milestoneId] = { ...project.progress[milestoneId], deliveredOn: this.today() };
      this.log('user', 'milestone.delivered', `Marked "${m.title}" as delivered.`, { projectId });
      const run = this.startRun('delivery', `Delivered · ${m.title}`, projectId);
      this.recompute(project, 'delivery');
      this.step(run, 'schedule', 'Schedule updated with the actual delivery date');
      this.reconcile();
      this.step(run, 'invoice', 'Invoice proposal prepared for your approval');
      const due = project.schedule.items.find((i) => i.milestoneId === milestoneId)!.dueOn;
      return { run, kind: 'delivery', template: explainDelivery(project, m, due), facts: factsFor('delivery', project, this.data.invoices, this.today()) };
    });
    await this.explain(job);
    return structuredClone(this.project(projectId));
  }

  /* ───────────── approvals ───────────── */

  async approveProposal(proposalId: string, edits: ApproveProposalRequest = {}): Promise<Proposal> {
    const proposal = await this.exclusive(async () => {
      const p = this.data.proposals.find((x) => x.id === proposalId);
      if (!p) throw new Problem(404, 'proposal_not_found', 'No such proposal.');
      if (!['pending', 'failed', 'rejected'].includes(p.status)) throw new Problem(409, 'proposal_closed', `This proposal is already ${p.status}.`);
      if (p.payload.kind === 'issue_invoice' && p.payload.invoiceDate !== this.today()) {
        this.reconcile();
        throw new Problem(409, 'proposal_stale', 'The date changed since this was proposed. Review the refreshed proposal and approve again.');
      }
      if (p.payload.kind !== 'issue_invoice') {
        for (const key of ['subject', 'note'] as const) {
          const v = edits[key];
          if (v === undefined) continue;
          const max = key === 'subject' ? 200 : 1500;
          if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) throw new Problem(400, 'invalid_edit', `The ${key} must be 1–${max} characters.`);
          if (v !== p.payload[key]) {
            p.payload[key] = v;
            if (p.payload.kind === 'send_reminder') p.payload.draftedBy = 'template';
            this.log('user', 'proposal.edited', `Edited the ${key} of "${p.title}".`, { proposalId });
          }
        }
      }
      p.status = 'executing';
      p.decidedAt = this.nowISO();
      p.decidedBy = 'user';
      p.error = undefined;
      this.emit({ type: 'proposal', proposal: p });
      this.log('user', 'proposal.approved', `Approved: ${p.title}`, { proposalId, projectId: p.payload.projectId });
      try {
        await this.execute(p);
        p.status = 'executed';
        p.executedAt = this.nowISO();
      } catch (e) {
        p.status = 'failed';
        p.error = e instanceof PayPalError
          ? `PayPal rejected the request (${e.status}${e.paypalName ? ` ${e.paypalName}` : ''}${e.issues.length ? `: ${e.issues.join(', ')}` : ''}). ${e.message}`
          : e instanceof Error ? e.message : 'Execution failed.';
        this.log('system', 'paypal.error', `"${p.title}" failed: ${p.error}`, { proposalId });
      }
      this.emit({ type: 'proposal', proposal: p });
      this.reconcile();
      return structuredClone(p);
    });
    return proposal;
  }

  /** The only place PayPal writes happen. Always through the gate, always after a recorded approval. */
  private async execute(p: Proposal): Promise<void> {
    const project = this.project(p.payload.projectId);
    if (p.payload.kind === 'issue_invoice') {
      p.assignedNumber ??= `PL-${this.data.tag}-${String(++this.data.invoiceSeq).padStart(3, '0')}`;
      const record = await this.gate.issueInvoice(p.id, {
        number: p.assignedNumber,
        // The invoice recipient can read this field, so it carries the public workspace tag, never the
        // workspace id (which is the visitor's session cookie). Webhooks are routed by invoice id.
        reference: `paceline:${this.data.tag}:${project.id}:${p.payload.milestoneId}`.slice(0, 120),
        note: `Milestone invoice for ${project.plan.title}.`,
      });
      const invoice = this.upsertInvoice(record, project.id, p.payload.milestoneId);
      project.progress[p.payload.milestoneId] = { ...project.progress[p.payload.milestoneId], invoiceId: record.id };
      this.env.registerInvoice?.(record.id);
      this.log('agent', 'invoice.created', `Created invoice ${invoice.number} for ${formatMoney(invoice.amountMinor, invoice.currency)} in PayPal (create_invoice).`, { proposalId: p.id, invoiceId: invoice.id, projectId: project.id });
      this.log('agent', 'invoice.sent', `Sent ${invoice.number} to ${p.payload.clientEmail}, due ${formatDate(invoice.dueDate)} (send_invoice).`, { proposalId: p.id, invoiceId: invoice.id, projectId: project.id });
      this.recompute(project, 'approval', invoice.id);
      this.note('action', `Invoice sent · ${invoice.number}`, project.id, explainInvoiceSent(project, invoice, p.payload.clientEmail));
    } else if (p.payload.kind === 'send_reminder') {
      await this.gate.sendReminder(p.id);
      const invoice = this.invoice(p.payload.invoiceId);
      invoice.remindersSent += 1;
      this.emit({ type: 'invoice', invoice });
      this.log('agent', 'reminder.sent', `Sent a payment reminder for ${invoice.number} to ${p.payload.clientEmail} (send_invoice_reminder).`, { proposalId: p.id, invoiceId: invoice.id, projectId: project.id });
      this.note('action', `Reminder sent · ${invoice.number}`, project.id, explainReminderSent(invoice, p.payload.clientEmail));
    } else {
      await this.gate.cancelInvoice(p.id);
      const record = await this.gate.getInvoice(p.payload.invoiceId);
      const invoice = this.upsertInvoice(record, project.id, p.payload.milestoneId);
      this.log('agent', 'invoice.cancelled', `Cancelled ${invoice.number} in PayPal (cancel_sent_invoice).`, { proposalId: p.id, invoiceId: invoice.id, projectId: project.id });
      this.detachDead(project, invoice);
      this.recompute(project, 'cancel', invoice.id);
      this.note('action', `Invoice cancelled · ${invoice.number}`, project.id, explainCancelled(project, invoice));
    }
  }

  rejectProposal(proposalId: string): Promise<Proposal> {
    return this.exclusive(() => {
      const p = this.data.proposals.find((x) => x.id === proposalId);
      if (!p) throw new Problem(404, 'proposal_not_found', 'No such proposal.');
      if (!['pending', 'failed'].includes(p.status)) throw new Problem(409, 'proposal_closed', `This proposal is already ${p.status}.`);
      p.status = 'rejected';
      p.decidedAt = this.nowISO();
      p.decidedBy = 'user';
      this.emit({ type: 'proposal', proposal: p });
      this.log('user', 'proposal.rejected', `Declined: ${p.title}`, { proposalId, projectId: p.payload.projectId });
      return structuredClone(p);
    });
  }

  /** The user asks to cancel a sent invoice. Still needs an explicit approval before PayPal is called. */
  requestCancel(invoiceId: string): Promise<Proposal> {
    return this.exclusive(() => {
      const invoice = this.invoice(invoiceId);
      if (!isAwaitingPayment(invoice.status)) throw new Problem(409, 'not_cancellable', `Only a sent, unpaid invoice can be cancelled; ${invoice.number} is ${invoice.status}.`);
      // PayPal refuses this (422 CANNOT_CANCEL_SCHEDULED_INVOICE): a scheduled invoice has not been sent yet.
      if (invoice.status === 'SCHEDULED') throw new Problem(409, 'not_cancellable', `${invoice.number} is scheduled and has not been sent yet; PayPal cannot cancel a scheduled invoice.`);
      const existing = this.data.proposals.find((p) => p.kind === 'cancel_invoice' && p.status === 'pending' && p.payload.kind === 'cancel_invoice' && p.payload.invoiceId === invoiceId);
      if (existing) return structuredClone(existing);
      const project = this.project(invoice.projectId);
      const t = cancelTemplate(project, invoice);
      const p = this.propose(
        'cancel_invoice', `Cancel invoice ${invoice.number} (${formatMoney(invoice.amountMinor, invoice.currency)})`,
        `You asked to cancel ${invoice.number}. PayPal notifies the client, and the milestone goes back to having no open invoice.`,
        { kind: 'cancel_invoice', projectId: project.id, milestoneId: invoice.milestoneId, invoiceId, invoiceNumber: invoice.number, clientEmail: this.env.sandboxBuyerEmail ?? project.plan.client.email, subject: t.subject, note: t.note },
        ['cancel_sent_invoice'], 'user',
      );
      return structuredClone(p);
    });
  }

  /* ───────────── PayPal facts in ───────────── */

  private upsertInvoice(record: InvoiceRecord, projectId: string, milestoneId: string): Invoice {
    const today = this.today();
    const overdue = isOverdue(record.status, record.dueDate, today);
    const existing = this.data.invoices.find((i) => i.id === record.id);
    const invoice: Invoice = {
      id: record.id, number: record.number, projectId, milestoneId, status: record.status, currency: record.currency,
      amountMinor: record.amountMinor, dueAmountMinor: record.dueAmountMinor, invoiceDate: record.invoiceDate, dueDate: record.dueDate,
      overdue, daysOverdue: overdue ? diffDays(record.dueDate, today) : 0, paidOn: record.paidOn, payments: record.payments,
      payerViewUrl: record.payerViewUrl, remindersSent: existing?.remindersSent ?? 0, source: this.env.gateway.mode, syncedAt: this.nowISO(),
    };
    if (existing) Object.assign(existing, invoice);
    else this.data.invoices.push(invoice);
    const out = existing ?? invoice;
    this.emit({ type: 'invoice', invoice: out });
    return out;
  }

  private detachDead(project: Project, invoice: Invoice): void {
    const prog = project.progress[invoice.milestoneId];
    if (prog?.invoiceId === invoice.id && isDead(invoice.status)) project.progress[invoice.milestoneId] = { ...prog, invoiceId: undefined };
  }

  /**
   * A verified webhook says something happened to one of our invoices. The
   * payload is not trusted for figures: the invoice is re-read from PayPal.
   */
  async onInvoiceEvent(invoiceId: string, eventType: string): Promise<void> {
    const job = await this.exclusive(async (): Promise<ProseJob | undefined> => {
      const known = this.invoice(invoiceId);
      const wasSettled = isSettled(known.status);
      const record = await this.env.gateway.getInvoice(invoiceId);
      const project = this.project(known.projectId);
      this.log('paypal', 'webhook.received', `${eventType} for ${known.number}. Re-read the invoice from PayPal: status ${record.status}.`, { invoiceId, projectId: project.id });
      const invoice = this.upsertInvoice(record, known.projectId, known.milestoneId);
      this.detachDead(project, invoice);

      if (!wasSettled && isSettled(invoice.status)) {
        const run = this.startRun('payment', `Payment received · ${invoice.number}`, project.id);
        this.step(run, 'webhook', `Webhook ${eventType} verified`);
        this.step(run, 'reread', `Invoice re-read from PayPal: ${invoice.status}, ${formatMoney(invoice.amountMinor, invoice.currency)}`);
        const change = this.recompute(project, 'payment', invoice.id) ?? this.emptyChange(project, 'payment', invoice.id);
        const moved = new Set(change.shifts.map((s) => s.milestoneId)).size;
        this.step(run, 'schedule', change.unlocked.length ? `Unlocked ${change.unlocked.length} milestone${change.unlocked.length === 1 ? '' : 's'}; ${moved} rescheduled` : 'Schedule recomputed');
        this.log('agent', 'plan.advanced', `${invoice.number} paid: ${change.unlocked.length ? `unlocked ${change.unlocked.map((id) => `"${project.plan.milestones.find((m) => m.id === id)?.title}"`).join(', ')}` : 'no further work was waiting on it'}. Delivery ${formatDate(change.deliveryTo)}.`, { invoiceId, projectId: project.id });
        this.reconcile();
        return { run, kind: 'payment', template: explainPayment(project, invoice, change), facts: factsFor('payment', project, this.data.invoices, this.today(), change) };
      }
      this.recompute(project, isDead(invoice.status) ? 'cancel' : 'clock', invoice.id);
      this.reconcile();
      return undefined;
    });
    if (job) await this.explain(job);
  }

  /* ───────────── time ───────────── */

  /** Re-evaluate everything against the clock: overdue invoices, slipping schedules, reminders. */
  async tick(): Promise<void> {
    const jobs = await this.exclusive((): ProseJob[] => {
      const out: ProseJob[] = [];
      const today = this.today();
      const newlyOverdue = this.syncInvoiceClock();
      const changes = new Map<string, ChangeSet | undefined>();
      for (const project of this.data.projects) {
        if (project.status === 'completed') continue;
        // A slip while an invoice is overdue is caused by that invoice, on the first day and on every later one.
        const late = newlyOverdue.some((i) => i.projectId === project.id)
          || this.data.invoices.some((i) => i.overdue && i.projectId === project.id && project.progress[i.milestoneId]?.invoiceId === i.id);
        changes.set(project.id, this.recompute(project, late ? 'overdue' : 'clock'));
      }
      const retold = new Set<string>();
      for (const invoice of this.data.invoices) {
        if (!invoice.overdue) continue;
        const project = this.data.projects.find((p) => p.id === invoice.projectId);
        if (!project || project.progress[invoice.milestoneId]?.invoiceId !== invoice.id) continue;
        const handled = this.data.overdueHandled[invoice.id];
        const openReminder = this.data.proposals.some((p) => p.payload.kind === 'send_reminder' && p.payload.invoiceId === invoice.id && ['pending', 'executing', 'failed', 'rejected'].includes(p.status));
        // Keep the "N days overdue" in a reminder that is still waiting for approval current.
        for (const p of this.data.proposals) {
          if (p.payload.kind !== 'send_reminder' || p.payload.invoiceId !== invoice.id || p.status !== 'pending') continue;
          const rationale = reminderRationale(project, invoice);
          if (p.rationale === rationale) continue;
          p.rationale = rationale;
          this.emit({ type: 'proposal', proposal: p });
        }
        // Still unpaid and the delivery date moved again: say so, instead of leaving the first explanation to go stale.
        const moved = changes.get(project.id);
        if (handled && moved && moved.deliveryDeltaDays !== 0 && !retold.has(project.id)) {
          retold.add(project.id);
          const run = this.startRun('overdue', `Still overdue · ${invoice.number}`, project.id);
          this.step(run, 'detect', `${invoice.number} is ${invoice.daysOverdue} day${invoice.daysOverdue === 1 ? '' : 's'} past due (PayPal status ${invoice.status})`);
          this.step(run, 'schedule', `Rescheduled downstream work; delivery ${formatDate(moved.deliveryTo)}`);
          this.log('agent', 'plan.rescheduled', `${invoice.number} is still unpaid. Downstream milestones moved; delivery now ${formatDate(project.schedule.deliveryDate)} (${versusPlan(project.knockOnDays)}).`, { invoiceId: invoice.id, projectId: project.id });
          out.push({ run, kind: 'overdue', template: explainOverdue(project, invoice, moved, this.data.proposals.some((p) => p.payload.kind === 'send_reminder' && p.payload.invoiceId === invoice.id && p.status === 'pending') ? 'waiting' : 'none'), facts: factsFor('overdue', project, this.data.invoices, today, moved) });
        }
        if (handled && (openReminder || diffDays(handled, today) < 7)) continue;
        this.data.overdueHandled[invoice.id] = today;
        const t = reminderTemplate(project, invoice);
        const reminder = this.propose(
          'send_reminder', `Remind ${project.plan.client.name} about ${invoice.number}`, reminderRationale(project, invoice),
          { kind: 'send_reminder', projectId: project.id, milestoneId: invoice.milestoneId, invoiceId: invoice.id, invoiceNumber: invoice.number, clientEmail: this.env.sandboxBuyerEmail ?? project.plan.client.email, subject: t.subject, note: t.note, draftedBy: 'template' },
          ['send_invoice_reminder'],
        );
        if (handled) continue; // a follow-up reminder; the overdue run already explained the slip
        const change = changes.get(project.id) ?? this.emptyChange(project, 'overdue', invoice.id);
        const run = this.startRun('overdue', `Overdue · ${invoice.number}`, project.id);
        this.step(run, 'detect', `${invoice.number} is ${invoice.daysOverdue} day${invoice.daysOverdue === 1 ? '' : 's'} past due (PayPal status ${invoice.status})`);
        this.step(run, 'schedule', `Rescheduled downstream work; delivery ${formatDate(change.deliveryTo)}`);
        this.step(run, 'draft', 'Reminder drafted for your approval');
        this.log('agent', 'plan.rescheduled', `${invoice.number} is overdue. Downstream milestones moved; delivery now ${formatDate(project.schedule.deliveryDate)} (${versusPlan(project.knockOnDays)}).`, { invoiceId: invoice.id, projectId: project.id });
        out.push({
          run, kind: 'overdue', template: explainOverdue(project, invoice, change), facts: factsFor('overdue', project, this.data.invoices, today, change),
          reminder: { proposalId: reminder.id, projectId: project.id, invoiceId: invoice.id },
        });
      }
      this.reconcile();
      return out;
    });
    for (const job of jobs) await this.explain(job);
  }

  /* ───────────── simulator-only controls ───────────── */

  private simulator(): PayPalSimulator {
    if (!(this.env.gateway instanceof PayPalSimulator)) throw new Problem(409, 'not_simulator', 'This control only exists in simulator mode.');
    return this.env.gateway;
  }

  /** Play the buyer. Returns the signed webhook; the host delivers it through the real webhook handler. */
  simulatePayment(invoiceId: string): Promise<SignedWebhook> {
    return this.exclusive(async () => {
      const sim = this.simulator();
      this.invoice(invoiceId);
      return sim.pay(invoiceId, this.today());
    });
  }

  /** Simulator mode: check a delivery against this workspace's signing secret. */
  verifySimulatedWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    return this.env.gateway instanceof PayPalSimulator ? this.env.gateway.verifyWebhook(headers, rawBody) : Promise.resolve(false);
  }

  async advanceClock(days: number): Promise<void> {
    this.simulator();
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new Problem(400, 'invalid_days', 'Move the clock by 1–60 days at a time.');
    await this.exclusive(() => {
      if (this.data.clockOffsetDays + days > 365) throw new Problem(409, 'clock_limit', 'The simulator clock cannot move more than a year ahead.');
      this.data.clockOffsetDays += days;
      this.emit({ type: 'info', info: this.info() });
      this.log('system', 'clock.advanced', `Simulator clock moved ${days} day${days === 1 ? '' : 's'} forward to ${formatDate(this.today(), true)}.`);
    });
    await this.tick();
  }

  /** Run `fn` as a silent replay at a clock offset (used to build the sample workspace). */
  async replay(fn: (setOffset: (days: number) => void) => Promise<void>): Promise<void> {
    this.simulator();
    this.replaying = true;
    const original = this.data.clockOffsetDays;
    try {
      await fn((days) => { this.data.clockOffsetDays = original + days; });
    } finally {
      this.data.clockOffsetDays = original;
      this.replaying = false;
    }
    this.env.emit({ type: 'snapshot', state: this.snapshot() });
    this.env.changed?.();
  }

  /** Add an already-validated plan as a draft project (sample data). */
  addDraft(plan: Plan, brief: string, origin: Project['origin'], plannedBy: PlannerKind): Promise<Project> {
    return this.exclusive(() => {
      const project: Project = {
        id: this.newId('proj'), status: 'draft', plan, brief, origin, plannedBy, warnings: planWarnings(plan, brief), progress: {},
        schedule: computeSchedule(plan, { delivered: {}, invoices: {} }, this.today()), knockOnDays: 0, createdAt: this.nowISO(),
      };
      this.data.projects.push(project);
      this.emit({ type: 'project', project });
      return structuredClone(project);
    });
  }

  /* ───────────── ledger ───────────── */

  /** Rule-based ledger query. The server may try a model first and fall back to this. */
  ledgerQuery(req: LedgerQueryRequest): LedgerQueryResponse {
    const query = String(req.query ?? '').trim();
    if (!query) throw new Problem(400, 'empty_query', 'Type what you want to see.');
    if (query.length > LIMITS.ledgerQueryMaxChars) throw new Problem(400, 'query_too_long', `Keep the request under ${LIMITS.ledgerQueryMaxChars} characters.`);
    const parsed = parseLedgerQuery(query, {
      today: this.today(),
      clients: [...new Set(this.data.projects.map((p) => p.plan.client.name))],
      projects: [...new Set(this.data.projects.map((p) => p.plan.title))],
    });
    return { intent: parsed.intent, explanation: parsed.explanation, by: 'rules', understood: parsed.understood };
  }

  milestone(projectId: string, milestoneId: string): Milestone | undefined {
    return this.data.projects.find((p) => p.id === projectId)?.plan.milestones.find((m) => m.id === milestoneId);
  }
}
