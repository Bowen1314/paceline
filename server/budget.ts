/**
 * Spend guard for the planning model on a public deployment.
 *
 *  - A global daily budget in estimated US dollars and in model calls, kept in
 *    a small JSON file so a restart does not reset it. Every chat completion
 *    is metered from the `usage` block of its response.
 *  - A per-IP hourly allowance of model *runs* (one plan, one explanation, one
 *    reminder draft or one ledger question; a run makes 1–3 calls).
 *
 * Over a limit nothing breaks: plans come from the rule-based planner, prose
 * from the templates and ledger questions from the rule parser, and the UI says
 * which one answered.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ISODate } from '../shared/contract.ts';
import { ModelUnavailable, PlannerError, type PlanProposal, type Planner, type ReminderDraft, type WriteTask } from '../shared/planner/types.ts';
import type { FetchLike } from './paypal/sandbox.ts';

/** Nebius Token Factory list price for nvidia/nemotron-3-super-120b-a12b, USD per million tokens (checked 2026-10). */
export const MODEL_PRICE = { input: 0.3, output: 0.9 };

export interface BudgetLimits { dailyUsd: number; dailyCalls: number; perIpPerHour: number }

interface BudgetState {
  day: string;
  usd: number;
  calls: number;
  /** Since the file was created: what the deployment has spent in total. */
  total: { usd: number; calls: number; promptTokens: number; completionTokens: number; since: string };
}

export class BudgetExceeded extends PlannerError {
  constructor(why: string) {
    super(`Model budget: ${why}`);
    this.name = 'BudgetExceeded';
  }
}

const HOUR_MS = 3_600_000;

export class ModelBudget {
  private state: BudgetState;
  private ips = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limits: BudgetLimits,
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.state = this.load();
  }

  private load(): BudgetState {
    const fresh: BudgetState = { day: this.day(), usd: 0, calls: 0, total: { usd: 0, calls: 0, promptTokens: 0, completionTokens: 0, since: this.now().toISOString() } };
    if (!this.file) return fresh;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as BudgetState;
      if (typeof s.usd === 'number' && typeof s.calls === 'number' && s.total) return s;
    } catch { /* first run */ }
    return fresh;
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  private day(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private roll(): void {
    const d = this.day();
    if (this.state.day !== d) Object.assign(this.state, { day: d, usd: 0, calls: 0 });
  }

  /** Why the global budget is closed, or undefined if a call may go out. */
  exhausted(): string | undefined {
    this.roll();
    if (this.state.calls >= this.limits.dailyCalls) return `today's ${this.limits.dailyCalls} model calls are used up`;
    if (this.state.usd >= this.limits.dailyUsd) return `today's $${this.limits.dailyUsd.toFixed(2)} model budget is used up`;
    return undefined;
  }

  /** Take one run from this IP's hourly allowance. */
  takeRun(ip: string): boolean {
    const cap = this.limits.perIpPerHour;
    if (cap <= 0) return false;
    const t = this.now().getTime();
    const b = this.ips.get(ip) ?? { tokens: cap, at: t };
    b.tokens = Math.min(cap, b.tokens + ((t - b.at) / HOUR_MS) * cap);
    b.at = t;
    if (this.ips.size > 20_000) this.ips.clear();
    this.ips.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  record(promptTokens: number, completionTokens: number): void {
    this.roll();
    const usd = (promptTokens * MODEL_PRICE.input + completionTokens * MODEL_PRICE.output) / 1_000_000;
    this.state.calls += 1;
    this.state.usd += usd;
    this.state.total.calls += 1;
    this.state.total.usd += usd;
    this.state.total.promptTokens += promptTokens;
    this.state.total.completionTokens += completionTokens;
    this.save();
  }

  report(): { today: { usd: number; calls: number }; total: BudgetState['total']; limits: BudgetLimits } {
    this.roll();
    return { today: { usd: round(this.state.usd), calls: this.state.calls }, total: { ...this.state.total, usd: round(this.state.total.usd) }, limits: this.limits };
  }
}

const round = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * Wrap the model client's fetch: refuse once the global budget is closed, and
 * meter every completed call from the response's `usage` block.
 */
export function meteredFetch(budget: ModelBudget, inner: FetchLike = (url, init) => fetch(url, init)): FetchLike {
  return async (url, init) => {
    const why = budget.exhausted();
    if (why) throw new BudgetExceeded(why);
    const res = await inner(url, init);
    try {
      const usage = ((await res.clone().json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      budget.record(usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0);
    } catch {
      budget.record(0, 0);
    }
    return res;
  };
}

/**
 * One per workspace: the model planner while this visitor's IP has runs left
 * and the global budget is open, the rule-based planner and templates
 * otherwise. `ip()` is the address of the visitor's latest request.
 */
export class BudgetedPlanner implements Planner {
  readonly kind: Planner['kind'];
  readonly model?: string;

  constructor(
    private readonly model_: Planner & { ledgerIntent?: unknown },
    private readonly fallback: Planner,
    private readonly budget: ModelBudget,
    private readonly ip: () => string,
  ) {
    this.kind = model_.kind;
    this.model = model_.model;
  }

  /** May this visitor start a model run now? Takes one run from the IP's allowance if so. */
  admit(): boolean {
    return !this.budget.exhausted() && this.budget.takeRun(this.ip());
  }

  get inner(): Planner {
    return this.model_;
  }

  async proposePlan(brief: string, today: ISODate, onStep?: (label: string) => void): Promise<PlanProposal> {
    const fallback = async (why: string): Promise<PlanProposal> => {
      onStep?.(`${why}; drafting with the rule-based planner instead`);
      const p = await this.fallback.proposePlan(brief, today, onStep);
      const message = `Drafted by the built-in rule-based planner (${why.charAt(0).toLowerCase()}${why.slice(1)}). Durations it could not find default to 5 working days.`;
      return { ...p, by: this.fallback.kind, warnings: p.warnings.map((w) => (w.code === 'scripted_planner' ? { ...w, message } : w)) };
    };
    if (this.budget.exhausted()) return fallback('The model budget for today is used up');
    if (!this.budget.takeRun(this.ip())) return fallback('Model limit for your address this hour reached');
    try {
      return await this.model_.proposePlan(brief, today, onStep);
    } catch (e) {
      if (e instanceof BudgetExceeded) return fallback('The model budget for today ran out mid-plan');
      // The provider refused or could not be reached (402 when its credit is gone, 5xx, timeout): plan with the rules, and say so.
      if (e instanceof ModelUnavailable) return fallback(e.message.replace(/\.$/, ''));
      throw e;
    }
  }

  async write(task: WriteTask): Promise<string | null> {
    return task.rejected !== undefined || this.admit() ? this.model_.write(task) : null;
  }

  async draftReminder(task: WriteTask): Promise<ReminderDraft | null> {
    return task.rejected !== undefined || this.admit() ? this.model_.draftReminder(task) : null;
  }
}
