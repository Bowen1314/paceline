import { describe, expect, it } from 'vitest';
import { approvalBlockers, groundDraft, moneyMentions, planTotal, planWarnings, validatePlan, type PlanDraft } from '../shared/plan.ts';
import { scriptedDraft, ScriptedPlanner } from '../shared/planner/scripted.ts';
import { PlannerError } from '../shared/planner/types.ts';
import { SAMPLE_BRIEFS } from '../shared/sample.ts';
import { BRIEF, T0, plan3 } from './helpers.ts';

const draft = (over: Partial<PlanDraft> = {}): PlanDraft => ({
  title: 'Brand refresh',
  client: { name: 'Juniper & Rye', email: 'ops@juniperandrye.example' },
  currency: 'USD',
  statedTotal: '$12,000',
  startDate: null,
  milestones: [
    { id: 'm1', title: 'Deposit', deliverable: '', durationDays: 0, amount: '3000.00', netDays: 7, dependsOn: [] },
    { id: 'm2', title: 'Design', deliverable: '', durationDays: 5, amount: '4000', netDays: 7, dependsOn: [{ on: 'm1', gate: 'paid' }] },
    { id: 'm3', title: 'Build', deliverable: '', durationDays: 10, amount: '5000.00', netDays: 7, dependsOn: [{ on: 'm2', gate: 'paid' }] },
  ],
  ...over,
});

describe('validatePlan', () => {
  it('accepts a well-formed plan', () => expect(validatePlan(plan3())).toEqual([]));

  it.each([
    ['empty title', (p: ReturnType<typeof plan3>) => { p.title = ' '; }, /title/],
    ['bad email', (p) => { p.client.email = 'not-an-email'; }, /email/],
    ['unknown currency', (p) => { (p as { currency: string }).currency = 'BTC'; }, /currency/],
    ['bad start date', (p) => { p.startDate = '2026-02-30'; }, /startDate/],
    ['no milestones', (p) => { p.milestones = []; }, /at least one milestone/],
    ['duplicate ids', (p) => { p.milestones[1]!.id = 'm1'; }, /used twice/],
    ['zero amount', (p) => { p.milestones[0]!.amountMinor = 0; }, /amount/],
    ['negative amount', (p) => { p.milestones[0]!.amountMinor = -500; }, /amount/],
    ['fractional cents', (p) => { p.milestones[0]!.amountMinor = 10.5; }, /amount/],
    ['absurd amount', (p) => { p.milestones[0]!.amountMinor = 10 ** 12; }, /amount/],
    ['negative duration', (p) => { p.milestones[1]!.durationDays = -1; }, /durationDays/],
    ['fractional duration', (p) => { p.milestones[1]!.durationDays = 2.5; }, /durationDays/],
    ['net days out of range', (p) => { p.milestones[1]!.netDays = 400; }, /netDays/],
    ['dependency on a missing milestone', (p) => { p.milestones[1]!.dependsOn = [{ on: 'zz', gate: 'paid' }]; }, /unknown milestone/],
    ['self dependency', (p) => { p.milestones[1]!.dependsOn = [{ on: 'm2', gate: 'paid' }]; }, /itself/],
    ['bad gate', (p) => { (p.milestones[1]!.dependsOn[0] as { gate: string }).gate = 'vibes'; }, /gate/],
    ['cycle', (p) => { p.milestones[0]!.dependsOn = [{ on: 'm3', gate: 'paid' }]; }, /cycle/],
  ] as [string, (p: ReturnType<typeof plan3>) => void, RegExp][])('rejects %s', (_n, mutate, re) => {
    const p = plan3();
    mutate(p);
    expect(validatePlan(p).join('\n')).toMatch(re);
  });

  it('too many milestones', () => {
    const p = plan3();
    p.milestones = Array.from({ length: 13 }, (_, i) => ({ ...p.milestones[0]!, id: `x${i}`, dependsOn: [] }));
    expect(validatePlan(p).join('\n')).toMatch(/at most 12/);
  });

  it('approval needs a client email', () => {
    const p = plan3();
    p.client.email = '';
    expect(validatePlan(p)).toEqual([]);
    expect(approvalBlockers(p).join()).toMatch(/client email/);
  });
});

describe('moneyMentions', () => {
  it.each([
    ['Total fee: $12,000 with 25% deposit', [1_200_000]],
    ['budget is 8.5k, maybe $9k', [850_000, 900_000]],
    ['USD 3000 or 2,500.50 USD', [300_000, 250_050]],
    ['3 weeks, 25%, phase 2', []],
    ['€1,200 and £900', [120_000, 90_000]],
  ])('%s', (text, want) => expect(moneyMentions(text).sort()).toEqual([...want].sort()));
});

describe('groundDraft: nothing in a proposed plan may be invented', () => {
  it('accepts a draft whose figures come from the brief', () => {
    const g = groundDraft(draft(), BRIEF, T0);
    expect(g.errors).toEqual([]);
    expect(planTotal(g.plan!)).toBe(1_200_000);
    expect(g.plan!.startDate).toBe(T0);
    expect(g.warnings).toEqual([]);
  });

  it('rejects a stated total that is not in the brief', () => {
    const g = groundDraft(draft({ statedTotal: '$15,000' }), BRIEF, T0);
    expect(g.plan).toBeUndefined();
    expect(g.errors.join()).toMatch(/does not appear in the brief/);
  });

  it('rejects amounts that do not add up to the stated total', () => {
    const d = draft();
    d.milestones[2]!.amount = '6000.00';
    const g = groundDraft(d, BRIEF, T0);
    expect(g.errors.join()).toMatch(/add up to \$13,000\.00 but statedTotal is \$12,000\.00/);
  });

  it('rejects an email the brief does not contain', () => {
    const g = groundDraft(draft({ client: { name: 'Juniper & Rye', email: 'billing@invented.example' } }), BRIEF, T0);
    expect(g.errors.join()).toMatch(/does not appear in the brief/);
  });

  it('a null email is fine but warns, and blocks approval', () => {
    const g = groundDraft(draft({ client: { name: 'Juniper & Rye', email: null } }), BRIEF, T0);
    expect(g.errors).toEqual([]);
    expect(g.warnings.map((w) => w.code)).toContain('email_missing');
    expect(approvalBlockers(g.plan!).length).toBeGreaterThan(0);
  });

  it('warns when the total is the planner\'s own figure', () => {
    const d = draft({ statedTotal: null });
    d.milestones[2]!.amount = '7000';
    const g = groundDraft(d, BRIEF, T0);
    expect(g.errors).toEqual([]);
    expect(g.warnings.map((w) => w.code)).toContain('total_not_in_brief');
  });

  it('warns about a client name the brief does not contain', () => {
    const g = groundDraft(draft({ client: { name: 'Acme Corp', email: 'ops@juniperandrye.example' } }), BRIEF, T0);
    expect(g.warnings.map((w) => w.code)).toContain('client_not_in_brief');
  });

  it('rejects malformed amounts instead of rounding them', () => {
    const d = draft({ statedTotal: null });
    d.milestones[0]!.amount = '3000.005';
    expect(groundDraft(d, BRIEF, T0).errors.join()).toMatch(/not a decimal amount/);
  });

  it('a past start date is moved to today with a warning', () => {
    const g = groundDraft(draft({ startDate: '2026-09-01' }), BRIEF, T0);
    expect(g.plan!.startDate).toBe(T0);
    expect(g.warnings.map((w) => w.code)).toContain('start_in_past');
  });

  it('structural problems come back as errors the planner can act on', () => {
    const d = draft();
    d.milestones[1]!.dependsOn = [{ on: 'nope', gate: 'paid' }];
    expect(groundDraft(d, BRIEF, T0).errors.join()).toMatch(/unknown milestone/);
  });

  it('planWarnings is recomputed for user edits', () => {
    const p = plan3();
    expect(planWarnings(p, BRIEF)).toEqual([]);
    p.milestones[0]!.amountMinor = 123_400;
    expect(planWarnings(p, BRIEF).map((w) => w.code)).toEqual(['total_not_in_brief']);
  });
});

describe('scripted planner', () => {
  it('reads total, deposit, terms, durations and client from the brief', () => {
    const d = scriptedDraft(BRIEF, T0);
    expect(d.statedTotal).toBe('$12,000');
    expect(d.client).toEqual({ name: 'Juniper & Rye', email: 'ops@juniperandrye.example' });
    expect(d.milestones.map((m) => [m.title, m.amount, m.durationDays, m.netDays])).toEqual([
      ['Deposit', '3000.00', 0, 7],
      ['Design', '4500.00', 5, 7],
      ['Build', '4500.00', 10, 7],
    ]);
    expect(d.milestones.map((m) => m.dependsOn)).toEqual([[], [{ on: 'm1', gate: 'paid' }], [{ on: 'm2', gate: 'paid' }]]);
  });

  it.each(SAMPLE_BRIEFS.map((b) => [b.label, b.text]))('sample brief "%s" produces a grounded plan with no figure warnings', async (_label, text) => {
    const { plan, warnings } = await new ScriptedPlanner().proposePlan(text, T0);
    expect(validatePlan(plan)).toEqual([]);
    expect(approvalBlockers(plan)).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(['scripted_planner']);
    const briefAmounts = moneyMentions(text);
    expect(briefAmounts.includes(planTotal(plan)) || plan.milestones.every((m) => briefAmounts.includes(m.amountMinor))).toBe(true);
  });

  it('itemised briefs keep each line amount exactly', () => {
    const d = scriptedDraft(SAMPLE_BRIEFS[1]!.text, T0);
    expect(d.milestones.map((m) => m.amount)).toEqual(['2400.00', '3200.00', '2800.00']);
    expect(d.milestones.map((m) => m.durationDays)).toEqual([6, 8, 7]);
    expect(d.milestones.every((m) => m.netDays === 14)).toBe(true);
  });

  it('splits remainders so the amounts always add up', () => {
    const d = scriptedDraft('Client: Odd Co <a@odd.example>\nTotal: $1,000.01, 33% deposit\n- One\n- Two\n- Three', T0);
    const cents = d.milestones.map((m) => Math.round(Number(m.amount) * 100));
    expect(cents.reduce((a, b) => a + b, 0)).toBe(100_001);
  });

  it('refuses to make up a fee', async () => {
    await expect(new ScriptedPlanner().proposePlan('Please build us a nice website with a blog and a shop.', T0)).rejects.toThrow(PlannerError);
  });

  it('reads a stated start date', () => {
    expect(scriptedDraft(`${BRIEF}\nWe start on Nov 3.`, T0).startDate).toBe('2026-11-03');
    expect(scriptedDraft(`${BRIEF}\nKickoff: 2026-10-19`, T0).startDate).toBe('2026-10-19');
    expect(scriptedDraft(BRIEF, T0).startDate).toBeNull();
  });
});
