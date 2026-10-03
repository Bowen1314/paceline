/**
 * One workspace per visitor session.
 *
 * Isolation model
 *  - Simulator workspaces: each has its own simulator (its own invoices, its
 *    own webhook signing secret, its own clock). Visitors cannot see or affect
 *    each other.
 *  - Live sandbox workspaces: all of them share ONE sandbox merchant account,
 *    so isolation is enforced here rather than by PayPal: a workspace only ever
 *    reads invoices it created (by id, never by listing the account), invoice
 *    numbers carry a per-workspace tag, webhooks are routed by the
 *    invoice -> workspace index, and invoices are addressed to the configured
 *    sandbox buyer instead of whatever email the brief contains.
 *
 * Which workspaces are live (config.paypal.access)
 *  - `everyone`: every workspace, when the server runs in sandbox mode (local use).
 *  - `operator`: only a workspace started by unlocking /operator with the
 *    operator token. It records a fingerprint of that token; if the token is
 *    changed, such workspaces fall back to a fresh simulator workspace. All
 *    other visitors get the simulator, so the public cannot make the shared
 *    sandbox merchant send invoices or emails.
 */
import type { PayPalMode, ServerEvent } from '../shared/contract.ts';
import { Workspace, newWorkspaceData, type WorkspaceData } from '../shared/engine.ts';
import type { PayPalGateway } from '../shared/paypal/gateway.ts';
import { invoiceIdFromEvent } from '../shared/paypal/gateway.ts';
import { PayPalSimulator, newSimulatorState } from '../shared/paypal/simulator.ts';
import { ScriptedPlanner } from '../shared/planner/scripted.ts';
import type { Planner } from '../shared/planner/types.ts';
import type { WebhookDeps } from '../shared/webhook.ts';
import { BudgetedPlanner, type ModelBudget } from './budget.ts';
import type { Config } from './config.ts';
import type { Semaphore } from './rateLimit.ts';
import { Store } from './store.ts';

interface Live {
  ws: Workspace;
  subs: Set<(e: ServerEvent) => void>;
  touched: number;
  /** Address of the visitor's latest request (model limits are per IP). */
  ip: string;
}

export interface ManagerOptions {
  /** Model spend guard: each workspace's model planner is wrapped in a BudgetedPlanner. */
  budget?: ModelBudget;
  now?: () => Date;
}

const WEEK_MS = 7 * 86_400_000;

export class WorkspaceManager {
  private live = new Map<string, Live>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;
  private readonly budget?: ModelBudget;
  private readonly fallbackPlanner = new ScriptedPlanner();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly planner: Planner,
    private readonly models: Semaphore,
    /** Sandbox mode: the one shared gateway. Simulator mode: undefined. */
    private readonly sandbox?: PayPalGateway,
    opts: ManagerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.budget = opts.budget;
  }

  /** Who may have a live sandbox workspace on this server. */
  get sandboxAccess(): 'none' | 'everyone' | 'operator' {
    if (!this.sandbox || this.config.paypal.mode !== 'sandbox') return 'none';
    return this.config.paypal.access;
  }

  /** Short fingerprint of the operator token's hash, stored in live workspaces. */
  private get operatorKey(): string | undefined {
    return this.config.paypal.mode === 'sandbox' ? this.config.paypal.operatorTokenSha256?.slice(0, 16) : undefined;
  }

  private isLive(data: WorkspaceData): boolean {
    const access = this.sandboxAccess;
    if (access === 'everyone') return true;
    return access === 'operator' && data.paypal === 'sandbox' && data.operatorKey !== undefined && data.operatorKey === this.operatorKey;
  }

  private build(input: WorkspaceData, ip = 'unknown'): Live {
    let data = input;
    if (data.paypal === 'sandbox' && !this.isLive(data)) {
      // The operator token changed, or the server no longer runs the sandbox: start over in the simulator.
      data = newWorkspaceData(data.id, this.now());
    }
    const live = this.isLive(data);
    const subs = new Set<(e: ServerEvent) => void>();
    const entry = { subs, touched: Date.now(), ip } as Live;
    // eslint-disable-next-line prefer-const
    let ws: Workspace;
    let gateway: PayPalGateway;
    if (live) gateway = this.sandbox!;
    else {
      data.sim ??= newSimulatorState();
      gateway = new PayPalSimulator(data.sim, () => ws.nowDate());
    }
    const planner = this.budget && this.planner.kind !== 'scripted'
      ? new BudgetedPlanner(this.planner, this.fallbackPlanner, this.budget, () => entry.ip)
      : this.planner;
    ws = new Workspace(data, {
      gateway,
      planner,
      now: this.now,
      emit: (e) => { for (const fn of subs) fn(e); },
      changed: () => this.store.saveWorkspace(data.id, () => ws.data),
      registerInvoice: (invoiceId) => this.store.registerInvoice(invoiceId, data.id),
      withModelSlot: (fn) => this.models.run(fn),
      mock: false,
      agGridLicensed: this.config.agGridLicensed,
      sandboxBuyerEmail: live && this.config.paypal.mode === 'sandbox' ? this.config.paypal.buyerEmail : undefined,
      timeZone: this.config.timeZone,
    });
    entry.ws = ws;
    return entry;
  }

  get(id: string, ip?: string): Workspace {
    if (!Store.validId(id)) throw new Error('invalid workspace id');
    let entry = this.live.get(id);
    if (!entry) {
      entry = this.build(this.store.loadWorkspace(id) ?? newWorkspaceData(id, this.now()), ip);
      this.live.set(id, entry);
      this.evict();
    }
    entry.touched = Date.now();
    if (ip) entry.ip = ip;
    return entry.ws;
  }

  /** The PayPal mode of a session's workspace. */
  modeOf(id: string): PayPalMode {
    return this.get(id).paypalMode;
  }

  /** Keep at most `maxWorkspaces` in memory; the rest stay on disk and reload on demand. */
  private evict(): void {
    const max = this.config.limits.maxWorkspaces;
    if (this.live.size <= max) return;
    const idle = [...this.live.entries()].filter(([, e]) => e.subs.size === 0).sort((a, b) => a[1].touched - b[1].touched);
    for (const [id] of idle.slice(0, this.live.size - max)) this.live.delete(id);
  }

  subscribe(id: string, fn: (e: ServerEvent) => void): () => void {
    this.get(id);
    const entry = this.live.get(id)!;
    entry.subs.add(fn);
    return () => entry.subs.delete(fn);
  }

  subscribers(id: string): number {
    return this.live.get(id)?.subs.size ?? 0;
  }

  byInvoice(invoiceId: string): Workspace | undefined {
    const id = this.store.workspaceOfInvoice(invoiceId);
    if (!id) return undefined;
    const ws = this.get(id);
    return ws.ownsInvoice(invoiceId) ? ws : undefined;
  }

  /** Replace a session's workspace with `data`. Open event streams get the fresh state. */
  private replace(id: string, data: WorkspaceData): Workspace {
    const old = this.live.get(id);
    this.store.deleteWorkspace(id);
    const entry = this.build(data, old?.ip);
    if (old) for (const fn of old.subs) entry.subs.add(fn);
    this.live.set(id, entry);
    this.store.saveWorkspace(id, () => entry.ws.data);
    for (const fn of entry.subs) fn({ type: 'snapshot', state: entry.ws.snapshot() });
    return entry.ws;
  }

  private fresh(id: string, live: boolean): WorkspaceData {
    const data = newWorkspaceData(id, this.now());
    if (live && this.sandboxAccess === 'operator') Object.assign(data, { paypal: 'sandbox', operatorKey: this.operatorKey });
    return data;
  }

  /** Wipe a visitor's workspace, keeping its mode (a live operator workspace stays live). */
  reset(id: string): Workspace {
    const wasLive = this.live.get(id)?.ws.paypalMode === 'sandbox' || this.store.loadWorkspace(id)?.paypal === 'sandbox';
    return this.replace(id, this.fresh(id, wasLive));
  }

  /**
   * Operator mode: start a fresh live sandbox workspace for this session
   * (`live`), or go back to a fresh simulator workspace. The caller has
   * checked the operator token.
   */
  switchMode(id: string, live: boolean): Workspace {
    if (live && this.sandboxAccess !== 'operator') throw new Error('operator mode is not enabled');
    return this.replace(id, this.fresh(id, live));
  }

  /** Dependencies for the webhook handler. */
  webhookDeps(): WebhookDeps {
    const route = (invoiceId: string): Workspace | undefined => this.byInvoice(invoiceId);
    const sandbox = this.sandbox;
    const gateway: WebhookDeps['gateway'] = {
      // Find the invoice's owner first: a live workspace's invoices are vouched for by PayPal,
      // a simulator workspace's by its own signing secret.
      verifyWebhook: async (headers, rawBody) => {
        let invoiceId: string | undefined;
        try {
          invoiceId = invoiceIdFromEvent(JSON.parse(rawBody));
        } catch {
          return false;
        }
        const ws = invoiceId ? route(invoiceId) : undefined;
        if (ws) return ws.paypalMode === 'sandbox' && sandbox ? sandbox.verifyWebhook(headers, rawBody) : ws.verifySimulatedWebhook(headers, rawBody);
        // Not one of ours: only PayPal can vouch for it (then it is acknowledged and ignored, so PayPal stops retrying).
        return sandbox ? sandbox.verifyWebhook(headers, rawBody) : false;
      },
    };
    return { gateway, seen: this.store.seenWebhooks, route };
  }

  /** Clock-driven work: overdue detection, schedule slip. Also prunes week-old workspaces. */
  start(intervalMs = 60_000): void {
    let n = 0;
    this.timer = setInterval(() => {
      for (const { ws } of this.live.values()) void ws.tick().catch((e) => console.error(`[tick] ${(e as Error).message}`));
      if (++n % 60 === 0) {
        for (const id of this.store.staleWorkspaces(WEEK_MS)) {
          if (!this.live.get(id)?.subs.size) {
            this.live.delete(id);
            this.store.deleteWorkspace(id);
          }
        }
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.store.flush(new Map([...this.live.entries()].map(([id, e]) => [id, () => e.ws.data])));
  }

  get liveCount(): number {
    return this.live.size;
  }
}
