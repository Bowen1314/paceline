/**
 * `?mock=1`: the whole product in the browser, no backend. It hosts the same
 * workflow engine the server runs, with the PayPal simulator and the scripted
 * planner, so every screen and transition can be exercised offline.
 */
import type {
  ApproveProposalRequest, Backend, LedgerQueryRequest, LedgerQueryResponse, Plan, Project, Proposal, ServerEvent, StartPlanRunResponse,
  WorkspaceState,
} from '../../shared/contract.ts';
import { Problem, Workspace, newWorkspaceData, type WorkspaceData } from '../../shared/engine.ts';
import { PayPalSimulator, newSimulatorState } from '../../shared/paypal/simulator.ts';
import { ScriptedPlanner } from '../../shared/planner/scripted.ts';
import { loadSampleWorkspace } from '../../shared/sample.ts';
import { handleWebhook, type WebhookDeps } from '../../shared/webhook.ts';
import { ApiProblem } from './http.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MockBackend implements Backend {
  private ws!: Workspace;
  private sim!: PayPalSimulator;
  private readonly subs = new Set<(e: ServerEvent) => void>();
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  /** `latencyMs` makes agent steps visible, as they are with a real model. */
  constructor(private readonly latencyMs = 450) {
    this.build(newWorkspaceData('0'.repeat(32), new Date()));
  }

  private build(data: WorkspaceData): void {
    data.sim ??= newSimulatorState();
    this.sim = new PayPalSimulator(data.sim, () => this.ws.nowDate());
    const planner = new ScriptedPlanner();
    const latency = this.latencyMs;
    this.ws = new Workspace(data, {
      gateway: this.sim,
      planner: {
        kind: planner.kind,
        proposePlan: async (brief, today, onStep) => {
          onStep?.('Reading the brief');
          await sleep(latency);
          const out = await planner.proposePlan(brief, today, onStep);
          await sleep(latency);
          return out;
        },
        write: (t) => planner.write(t),
        draftReminder: (t) => planner.draftReminder(t),
      },
      now: () => new Date(),
      // Engine objects are live and mutable; the UI must only ever see copies.
      emit: (e) => { const copy = structuredClone(e); for (const fn of this.subs) fn(copy); },
      mock: true,
      agGridLicensed: false,
    });
  }

  private deps(): WebhookDeps {
    return { gateway: this.sim, seen: this.seen, route: (id) => (this.ws.ownsInvoice(id) ? this.ws : undefined) };
  }

  private async guard<T>(fn: () => Promise<T> | T): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Problem) throw new ApiProblem(e.status, e.code, e.message, e.details);
      throw e;
    }
  }

  getState(): Promise<WorkspaceState> {
    return Promise.resolve(this.ws.snapshot());
  }

  subscribe(onEvent: (e: ServerEvent) => void, onStatus?: (s: 'open' | 'reconnecting') => void): () => void {
    this.subs.add(onEvent);
    queueMicrotask(() => {
      onStatus?.('open');
      onEvent({ type: 'snapshot', state: this.ws.snapshot() });
    });
    this.timer ??= setInterval(() => void this.ws.tick(), 60_000);
    return () => {
      this.subs.delete(onEvent);
      if (this.subs.size === 0) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  startPlanRun(brief: string): Promise<StartPlanRunResponse> {
    return this.guard(() => {
      const { runId, done } = this.ws.startPlanRun(brief);
      done.catch(() => undefined);
      return { runId };
    });
  }
  updatePlan(projectId: string, plan: Plan): Promise<Project> {
    return this.guard(() => this.ws.updatePlan(projectId, plan));
  }
  approvePlan(projectId: string): Promise<Project> {
    return this.guard(() => this.ws.approvePlan(projectId));
  }
  discardProject(projectId: string): Promise<void> {
    return this.guard(() => this.ws.discardProject(projectId));
  }
  markDelivered(projectId: string, milestoneId: string): Promise<Project> {
    return this.guard(() => this.ws.markDelivered(projectId, milestoneId));
  }
  approveProposal(proposalId: string, edits: ApproveProposalRequest = {}): Promise<Proposal> {
    return this.guard(() => this.ws.approveProposal(proposalId, edits));
  }
  rejectProposal(proposalId: string): Promise<Proposal> {
    return this.guard(() => this.ws.rejectProposal(proposalId));
  }
  requestCancel(invoiceId: string): Promise<Proposal> {
    return this.guard(() => this.ws.requestCancel(invoiceId));
  }
  ledgerQuery(req: LedgerQueryRequest): Promise<LedgerQueryResponse> {
    return this.guard(() => this.ws.ledgerQuery(req));
  }
  simPay(invoiceId: string): Promise<void> {
    return this.guard(async () => {
      const signed = await this.ws.simulatePayment(invoiceId);
      await sleep(this.latencyMs); // the webhook takes a moment to arrive, as it does in the sandbox
      const result = await handleWebhook(this.deps(), signed.headers, signed.rawBody);
      if (result.status !== 200) throw new ApiProblem(502, 'webhook_failed', 'The simulated webhook was not accepted.');
    });
  }
  simAdvanceClock(days: number): Promise<void> {
    return this.guard(() => this.ws.advanceClock(days));
  }
  simLoadSample(): Promise<void> {
    return this.guard(async () => {
      if (this.ws.data.projects.length > 0) throw new Problem(409, 'not_empty', 'Reset the workspace before loading the sample.');
      await loadSampleWorkspace(this.ws, this.deps());
    });
  }
  reset(): Promise<void> {
    this.build(newWorkspaceData('0'.repeat(32), new Date()));
    this.seen.clear();
    const snapshot: ServerEvent = { type: 'snapshot', state: this.ws.snapshot() };
    for (const fn of this.subs) fn(snapshot);
    return Promise.resolve();
  }
}
