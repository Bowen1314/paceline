import { describe, expect, it } from 'vitest';
import { NEBIUS_BASE_URL } from '../server/config.ts';
import { NebiusPlanner } from '../server/planner/nebius.ts';
import { normalizeNulls, validateToolCall, type ToolDef } from '../server/toolcall.ts';
import { PROPOSE_PLAN_SCHEMA } from '../shared/plan.ts';
import { ModelUnavailable, PlannerError } from '../shared/planner/types.ts';
import { emptyFacts } from '../shared/guard.ts';
import { BRIEF, T0 } from './helpers.ts';

const TOOL: ToolDef = { name: 'propose_plan', description: 'x', parameters: PROPOSE_PLAN_SCHEMA as Record<string, unknown> };

const goodArgs = (): Record<string, unknown> => ({
  title: 'Juniper & Rye website',
  client: { name: 'Juniper & Rye', email: 'ops@juniperandrye.example' },
  currency: 'USD',
  statedTotal: '12000',
  startDate: null,
  milestones: [
    { id: 'm1', title: 'Deposit', deliverable: 'Kickoff deposit', durationDays: 0, amount: '3000', netDays: 7, dependsOn: [] },
    { id: 'm2', title: 'Design', deliverable: 'Design system and page designs', durationDays: 10, amount: '4500', netDays: 7, dependsOn: [{ on: 'm1', gate: 'paid' }] },
    { id: 'm3', title: 'Build', deliverable: 'Build and launch', durationDays: 15, amount: '4500', netDays: 7, dependsOn: [{ on: 'm2', gate: 'paid' }] },
  ],
});

const call = (args: unknown, name = 'propose_plan'): { id: string; type: 'function'; function: { name: string; arguments: string } } => ({
  id: 'call_1', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

describe('tool-call validation', () => {
  it('accepts a call that matches the schema', () => {
    expect(validateToolCall(call(goodArgs()), [TOOL]).ok).toBe(true);
  });

  it('rejects an argument that is not in the schema (the model once passed "limit") and names it', () => {
    const r = validateToolCall(call({ ...goodArgs(), limit: 5 }), [TOOL]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown argument "limit"/);
  });

  it('rejects invented nested arguments, wrong types, missing fields, unknown tools and bad JSON', () => {
    const nested = goodArgs();
    (nested.milestones as Record<string, unknown>[])[0]!.priority = 'high';
    const cases: [unknown, string?][] = [[nested], [{ ...goodArgs(), currency: 'JPY' }], [{ ...goodArgs(), milestones: [] }], [{ title: 'x' }], ['{not json'], ['[1,2]']];
    for (const [args] of cases) expect(validateToolCall(call(args), [TOOL]).ok).toBe(false);
    const unknown = validateToolCall(call(goodArgs(), 'delete_everything'), [TOOL]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/delete_everything/);
    expect(validateToolCall(undefined, [TOOL]).ok).toBe(false);
  });
});

describe('Python-style "None" in tool arguments (seen in real calls)', () => {
  it('reads "None" / "null" / "" as null only where the schema allows null', () => {
    const args = { ...goodArgs(), statedTotal: 'None', startDate: 'None', client: { name: 'Juniper & Rye', email: 'null' } };
    const r = validateToolCall<{ statedTotal: unknown; startDate: unknown; client: { email: unknown } }>(call(args), [TOOL]);
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.args.statedTotal, r.args.startDate, r.args.client.email]).toEqual([null, null, null]);
  });

  it('leaves real values and non-nullable fields alone', () => {
    const schema = PROPOSE_PLAN_SCHEMA;
    const args = goodArgs();
    (args.milestones as Record<string, unknown>[])[1]!.title = 'None';
    const out = normalizeNulls(schema, { ...args, statedTotal: '$12,000', startDate: '2026-10-12' }) as Record<string, any>;
    expect(out.statedTotal).toBe('$12,000');
    expect(out.startDate).toBe('2026-10-12');
    expect(out.milestones[1].title).toBe('None'); // a title cannot be null, so it is not touched
    expect(out.milestones[0].dependsOn).toEqual([]);
    // "None" in a field that may not be null is still a validation error the model hears about.
    const bad = validateToolCall(call({ ...goodArgs(), currency: 'None' }), [TOOL]);
    expect(bad.ok).toBe(false);
  });

  it('a plan whose nulls arrive as "None" is accepted on the first attempt', async () => {
    const m = model([toolReply({ ...goodArgs(), statedTotal: '$12,000', startDate: 'None' })]);
    const res = await planner(m).proposePlan(BRIEF, T0);
    expect(m.sent).toHaveLength(1);
    expect(res.plan.startDate).toBe(T0);
    expect(res.plan.milestones.map((x) => x.amountMinor)).toEqual([300_000, 450_000, 450_000]);
  });
});

interface Sent { url: string; auth: string; body: Record<string, any> }

function model(replies: unknown[]): { sent: Sent[]; fetch: (url: string, init?: RequestInit) => Promise<Response> } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init = {}) => {
      sent.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(init.body as string) as Record<string, any> });
      const next = replies[Math.min(sent.length - 1, replies.length - 1)] as { status?: number; message?: unknown; error?: unknown };
      if (next.status && next.status !== 200) return new Response(JSON.stringify({ error: next.error ?? { message: 'boom' } }), { status: next.status });
      return new Response(JSON.stringify({ choices: [{ message: next.message }], usage: { prompt_tokens: 900, completion_tokens: 300 } }), { status: 200 });
    },
  };
}

const planner = (m: ReturnType<typeof model>): NebiusPlanner => new NebiusPlanner({ apiKey: 'test-key', model: 'nvidia/nemotron-3-super-120b-a12b', fetch: m.fetch });
const toolReply = (args: unknown): { message: unknown } => ({ message: { role: 'assistant', content: null, tool_calls: [call(args)] } });

describe('NebiusPlanner (fake model)', () => {
  it('calls the Nebius endpoint with the configured model and a forced tool choice', async () => {
    const m = model([toolReply(goodArgs())]);
    const p = planner(m);
    const out = await p.proposePlan(BRIEF, T0);
    expect(m.sent[0]!.url).toBe(`${NEBIUS_BASE_URL}chat/completions`);
    expect(m.sent[0]!.auth).toBe('Bearer test-key');
    expect(m.sent[0]!.body.model).toBe('nvidia/nemotron-3-super-120b-a12b');
    expect(m.sent[0]!.body.tool_choice).toEqual({ type: 'function', function: { name: 'propose_plan' } });
    expect(out.plan.milestones.map((x) => x.amountMinor)).toEqual([300000, 450000, 450000]);
    expect(p.usage).toEqual({ calls: 1, promptTokens: 900, completionTokens: 300 });
  });

  it('feeds a schema error back and accepts the corrected call', async () => {
    const m = model([toolReply({ ...goodArgs(), limit: 10 }), toolReply(goodArgs())]);
    const steps: string[] = [];
    const out = await planner(m).proposePlan(BRIEF, T0, (s) => steps.push(s));
    expect(out.plan.milestones).toHaveLength(3);
    expect(m.sent).toHaveLength(2);
    const fedBack = m.sent[1]!.body.messages.at(-1);
    expect(fedBack.role).toBe('tool');
    expect(fedBack.content).toMatch(/unknown argument \\"limit\\"/);
    expect(steps.some((s) => /correct/i.test(s))).toBe(true);
  });

  it('feeds a grounding error back: amounts that do not add up to the total in the brief', async () => {
    const wrong = goodArgs();
    (wrong.milestones as Record<string, unknown>[])[2]!.amount = '5000';
    const m = model([toolReply(wrong), toolReply(goodArgs())]);
    const out = await planner(m).proposePlan(BRIEF, T0);
    expect(out.plan.milestones.reduce((s, x) => s + x.amountMinor, 0)).toBe(1200000);
    expect(m.sent[1]!.body.messages.at(-1).content).toMatch(/rejected/);
  });

  it('never returns an invented total: gives up after three invalid attempts', async () => {
    const invented: Record<string, unknown> = { ...goodArgs(), statedTotal: '15000' };
    (invented.milestones as Record<string, unknown>[])[2]!.amount = '7500';
    const m = model([toolReply(invented)]);
    await expect(planner(m).proposePlan(BRIEF, T0)).rejects.toBeInstanceOf(PlannerError);
    expect(m.sent).toHaveLength(3);
  });

  it('a reply without a tool call is corrected, an HTTP error is a PlannerError', async () => {
    const m = model([{ message: { role: 'assistant', content: 'Here is a plan: ...' } }, toolReply(goodArgs())]);
    expect((await planner(m).proposePlan(BRIEF, T0)).plan.title).toBe('Juniper & Rye website');
    expect(m.sent[1]!.body.messages.at(-1).role).toBe('user');
    await expect(planner(model([{ status: 429, error: { message: 'rate limited' } }])).proposePlan(BRIEF, T0)).rejects.toThrow(/HTTP 429/);
  });

  it('an HTTP error or an unreachable provider is ModelUnavailable (402 when the credit is gone), a bad plan is not', async () => {
    const paid = planner(model([{ status: 402 }]));
    const err = await paid.proposePlan(BRIEF, T0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelUnavailable);
    expect((err as Error).message).toMatch(/HTTP 402/);
    const down = new NebiusPlanner({ apiKey: 'k', model: 'nvidia/nemotron-3-super-120b-a12b', fetch: async () => { throw new TypeError('fetch failed'); } });
    const err2 = await down.proposePlan(BRIEF, T0).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ModelUnavailable);
    expect((err2 as Error).message).toMatch(/could not be reached/);
    const bad = await planner(model([{ message: { role: 'assistant', content: 'no tool' } }])).proposePlan(BRIEF, T0).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(PlannerError);
    expect(bad).not.toBeInstanceOf(ModelUnavailable);
  });

  it('write() returns prose; draftReminder() only accepts the exact JSON shape', async () => {
    const facts = emptyFacts();
    const w = planner(model([{ message: { role: 'assistant', content: '  All set.  ' } }]));
    expect(await w.write({ kind: 'plan', situation: 's', template: 't', facts })).toBe('All set.');
    const ok = planner(model([{ message: { role: 'assistant', content: '```json\n{"subject":"Reminder: invoice PL-AB12-001","note":"Hi Maya, a quick nudge that this invoice is still open."}\n```' } }]));
    expect(await ok.draftReminder({ kind: 'reminder', situation: 's', template: 't', facts })).toEqual({ subject: 'Reminder: invoice PL-AB12-001', note: 'Hi Maya, a quick nudge that this invoice is still open.' });
    const extra = planner(model([{ message: { role: 'assistant', content: '{"subject":"Reminder now","note":"Hi Maya, a quick nudge that this is open.","lateFee":"50"}' } }]));
    expect(await extra.draftReminder({ kind: 'reminder', situation: 's', template: 't', facts })).toBeNull();
    const prose = planner(model([{ message: { role: 'assistant', content: 'Sure! Here is a reminder.' } }]));
    expect(await prose.draftReminder({ kind: 'reminder', situation: 's', template: 't', facts })).toBeNull();
  });

  it('ledgerIntent validates the tool call, feeds errors back, and returns null when not understood', async () => {
    const ctx = { today: T0, clients: ['Juniper & Rye'], projects: ['Website'] };
    const good = { understood: true, reset: true, summary: 'Overdue invoices above the amount', groupBy: [], sort: [{ column: 'balanceMinor', dir: 'desc' }], filters: [{ column: 'status', op: 'in', values: ['overdue'] }, { column: 'balanceMinor', op: 'gt', value: 50000 }] };
    const lc = (args: unknown): { message: unknown } => ({ message: { role: 'assistant', content: null, tool_calls: [call(args, 'set_ledger_view')] } });
    const m = model([lc({ ...good, limit: 10 }), lc(good)]);
    const out = await planner(m).ledgerIntent('overdue over $500', ctx);
    expect(out?.intent.filters).toEqual(good.filters);
    expect(m.sent).toHaveLength(2);
    expect(await planner(model([lc({ ...good, understood: false })])).ledgerIntent('what is the weather', ctx)).toBeNull();
    expect(await planner(model([lc({ ...good, filters: [{ column: 'status', op: 'in', values: ['late'] }] })])).ledgerIntent('late ones', ctx)).toBeNull();
  });
});
