/**
 * The model spend guard: daily budget (persisted), per-IP run allowance,
 * metered calls, and the fallback to the rule-based planner and templates.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetExceeded, BudgetedPlanner, MODEL_PRICE, ModelBudget, meteredFetch } from '../server/budget.ts';
import { ModelUnavailable, PlannerError, type PlanProposal, type Planner, type WriteTask } from '../shared/planner/types.ts';
import { ScriptedPlanner } from '../shared/planner/scripted.ts';
import { BRIEF, T0 } from './helpers.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const LIMITS = { dailyUsd: 0.01, dailyCalls: 5, perIpPerHour: 3 };
const chat = (prompt: number, completion: number) => async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: prompt, completion_tokens: completion } }), { status: 200 });

describe('ModelBudget', () => {
  it('meters calls from the usage block and closes at the daily call cap', async () => {
    const budget = new ModelBudget(LIMITS);
    const f = meteredFetch(budget, chat(1000, 100));
    for (let i = 0; i < 5; i++) await f('https://api.tokenfactory.nebius.com/v1/chat/completions');
    expect(budget.report().today.calls).toBe(5);
    expect(budget.report().today.usd).toBeCloseTo((5 * (1000 * MODEL_PRICE.input + 100 * MODEL_PRICE.output)) / 1e6, 3);
    expect(budget.exhausted()).toMatch(/model calls/);
    await expect(f('https://api.tokenfactory.nebius.com/v1/chat/completions')).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it('closes at the daily dollar cap, reopens the next UTC day, and keeps the running total', async () => {
    let now = new Date('2026-10-02T23:00:00Z');
    const budget = new ModelBudget({ ...LIMITS, dailyCalls: 1000 }, undefined, () => now);
    const f = meteredFetch(budget, chat(20_000, 5_000)); // $0.0105 per call
    await f('u');
    expect(budget.exhausted()).toMatch(/\$0\.01/);
    now = new Date('2026-10-03T00:00:01Z');
    expect(budget.exhausted()).toBeUndefined();
    expect(budget.report().total.calls).toBe(1);
  });

  it('survives a restart: the day\'s spend is kept on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paceline-budget-'));
    dirs.push(dir);
    const file = join(dir, 'model-budget.json');
    const a = new ModelBudget(LIMITS, file);
    const f = meteredFetch(a, chat(10, 10));
    for (let i = 0; i < 5; i++) await f('u');
    const b = new ModelBudget(LIMITS, file);
    expect(b.exhausted()).toMatch(/model calls/);
    expect(b.report().total.calls).toBe(5);
  });

  it('gives each address a few runs an hour, refilled over the hour', () => {
    let now = new Date('2026-10-02T10:00:00Z');
    const budget = new ModelBudget(LIMITS, undefined, () => now);
    expect([1, 2, 3, 4].map(() => budget.takeRun('203.0.113.7'))).toEqual([true, true, true, false]);
    expect(budget.takeRun('198.51.100.9')).toBe(true);
    now = new Date('2026-10-02T10:20:00Z'); // a third of an hour: one run back
    expect(budget.takeRun('203.0.113.7')).toBe(true);
    expect(budget.takeRun('203.0.113.7')).toBe(false);
  });
});

describe('BudgetedPlanner', () => {
  const fakeModel = (): Planner & { plans: number; writes: number } => {
    const scripted = new ScriptedPlanner();
    const m = {
      kind: 'nebius' as const, model: 'nvidia/nemotron-3-super-120b-a12b', plans: 0, writes: 0,
      async proposePlan(brief: string, today: string): Promise<PlanProposal> {
        m.plans++;
        const p = await scripted.proposePlan(brief, today);
        return { plan: p.plan, warnings: p.warnings.filter((w) => w.code !== 'scripted_planner') };
      },
      async write(): Promise<string | null> { m.writes++; return 'model text'; },
      async draftReminder() { return null; },
    };
    return m;
  };
  const task: WriteTask = { kind: 'plan', situation: 's', template: 't', facts: { names: new Set(), amountsMinor: new Set(), dates: new Set(), ids: new Set(), numbers: new Set(), statuses: new Set() } as never };

  it('uses the model while the address has runs left, then the rule-based planner, and says so', async () => {
    const model = fakeModel();
    const budget = new ModelBudget({ dailyUsd: 1, dailyCalls: 100, perIpPerHour: 1 });
    const p = new BudgetedPlanner(model, new ScriptedPlanner(), budget, () => '203.0.113.7');
    expect(p.kind).toBe('nebius');
    const first = await p.proposePlan(BRIEF, T0);
    expect(first.by).toBeUndefined();
    expect(model.plans).toBe(1);
    const steps: string[] = [];
    const second = await p.proposePlan(BRIEF, T0, (s) => steps.push(s));
    expect(model.plans).toBe(1);
    expect(second.by).toBe('scripted');
    expect(second.warnings.find((w) => w.code === 'scripted_planner')!.message).toMatch(/model limit for your address/i);
    expect(steps[0]).toMatch(/rule-based planner/);
    // Prose falls back to the template (null), but a guard retry inside an admitted run is not charged again.
    expect(await p.write(task)).toBeNull();
    expect(await p.write({ ...task, rejected: 'x' })).toBe('model text');
  });

  it('falls back when the daily budget runs out in the middle of a plan', async () => {
    const budget = new ModelBudget({ dailyUsd: 1, dailyCalls: 100, perIpPerHour: 10 });
    const failing: Planner = { kind: 'nebius', proposePlan: async () => { throw new BudgetExceeded('used up'); }, write: async () => null, draftReminder: async () => null };
    const out = await new BudgetedPlanner(failing, new ScriptedPlanner(), budget, () => 'ip').proposePlan(BRIEF, T0);
    expect(out.by).toBe('scripted');
    expect(out.plan.milestones.length).toBeGreaterThan(0);
  });

  it('falls back to the rule-based planner, and says why, when the provider answers 402 or is unreachable', async () => {
    const budget = new ModelBudget({ dailyUsd: 1, dailyCalls: 100, perIpPerHour: 10 });
    for (const message of ['The planning model returned HTTP 402.', 'The planning model could not be reached (TimeoutError).']) {
      const down: Planner = { kind: 'nebius', proposePlan: async () => { throw new ModelUnavailable(message); }, write: async () => null, draftReminder: async () => null };
      const steps: string[] = [];
      const out = await new BudgetedPlanner(down, new ScriptedPlanner(), budget, () => 'ip').proposePlan(BRIEF, T0, (s) => steps.push(s));
      expect(out.by).toBe('scripted');
      expect(out.plan.milestones.length).toBeGreaterThan(0);
      const note = out.warnings.find((w) => w.code === 'scripted_planner')!.message;
      expect(note).toContain(`(${message.charAt(0).toLowerCase()}${message.slice(1, -1)})`);
      expect(steps[0]).toBe(`${message.slice(0, -1)}; drafting with the rule-based planner instead`);
    }
  });

  it('a plan the model could not produce is still an error, not a silent fallback', async () => {
    const budget = new ModelBudget({ dailyUsd: 1, dailyCalls: 100, perIpPerHour: 10 });
    const odd: Planner = { kind: 'nebius', proposePlan: async () => { throw new PlannerError('The model could not produce a valid plan in 3 attempts.'); }, write: async () => null, draftReminder: async () => null };
    await expect(new BudgetedPlanner(odd, new ScriptedPlanner(), budget, () => 'ip').proposePlan(BRIEF, T0)).rejects.toThrow(/valid plan/);
  });

  it('a closed daily budget means no model call at all', async () => {
    const model = fakeModel();
    const budget = new ModelBudget({ dailyUsd: 0, dailyCalls: 100, perIpPerHour: 10 });
    const p = new BudgetedPlanner(model, new ScriptedPlanner(), budget, () => 'ip');
    expect((await p.proposePlan(BRIEF, T0)).by).toBe('scripted');
    expect(await p.write(task)).toBeNull();
    expect(p.admit()).toBe(false);
    expect(model.plans + model.writes).toBe(0);
  });
});
