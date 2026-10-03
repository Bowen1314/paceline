/**
 * A handful of REAL calls to the planning model, for prompt tuning.
 *
 *   NEBIUS_API_KEY=… npx tsx scripts/try-nebius.ts            # all checks
 *   NEBIUS_API_KEY=… npx tsx scripts/try-nebius.ts plan       # only the plans
 *
 * Costs a few cents (it prints the token usage and the estimated spend).
 * The key is read through server/config.ts like everywhere else and is never
 * printed. Not part of the test suite: tests never touch the network.
 */
import { checkProse, describeViolations } from '../shared/guard.ts';
import { PayPalSimulator, newSimulatorState } from '../shared/paypal/simulator.ts';
import { Workspace, newWorkspaceData } from '../shared/engine.ts';
import { explainPayment, factsFor, reminderTemplate } from '../shared/prose.ts';
import { SAMPLE_BRIEFS, loadSampleWorkspace } from '../shared/sample.ts';
import { ScriptedPlanner } from '../shared/planner/scripted.ts';
import { formatMoney } from '../shared/money.ts';
import { bootConfig } from '../server/config.ts';
import { NebiusPlanner } from '../server/planner/nebius.ts';

/** USD per million tokens (Nebius Token Factory list price for the model, 2026-10). */
const PRICE = { input: 0.3, output: 0.9 };

const config = bootConfig([]);
if (config.planner.kind !== 'nebius') {
  console.error('No NEBIUS_API_KEY in the environment; nothing to do.');
  process.exit(2);
}
const only = process.argv[2];
const today = '2026-10-02';

// Log what the model actually sent back on each round (tool arguments / text), never the request headers.
const rounds: string[] = [];
const planner = new NebiusPlanner({
  apiKey: config.planner.apiKey,
  model: config.planner.model,
  fetch: async (url, init) => {
    const res = await fetch(url, init);
    const copy = res.clone();
    try {
      const json = (await copy.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[] };
      const m = json.choices?.[0]?.message;
      const call = m?.tool_calls?.[0]?.function;
      rounds.push(call ? `tool ${call.name} ${String(call.arguments).slice(0, 1400)}` : `text ${String(m?.content).slice(0, 600)} [finish=${json.choices?.[0]?.finish_reason}]`);
    } catch {
      rounds.push(`HTTP ${res.status} (unparseable body)`);
    }
    return res;
  },
});

const section = (title: string): void => console.log(`\n=== ${title}`);

async function plans(): Promise<void> {
  const tricky = `Hey! We're Lumen Yoga (hello@lumenyoga.example). Need a booking site. Budget is 9k all in, half up front, rest on launch. Start 2026-10-12. Design ~1.5 weeks then build ~3 weeks. Net 15.`;
  for (const [label, brief] of [...SAMPLE_BRIEFS.map((s) => [s.label, s.text] as const), ['Messy brief', tricky] as const]) {
    section(`plan: ${label}`);
    rounds.length = 0;
    const started = Date.now();
    try {
      const { plan, warnings } = await planner.proposePlan(brief, today, (s) => console.log(`  step: ${s}`));
      console.log(`  OK in ${rounds.length} round(s), ${Date.now() - started} ms`);
      console.log(`  ${plan.title} · ${plan.client.name} <${plan.client.email ?? 'no email'}> · start ${plan.startDate}`);
      for (const m of plan.milestones) {
        console.log(`   ${m.id} ${m.title.padEnd(38)} ${String(m.durationDays).padStart(2)}d ${formatMoney(m.amountMinor, plan.currency).padStart(9)} net ${m.netDays} deps ${m.dependsOn.map((d) => `${d.on}:${d.gate}`).join(',') || '-'}`);
      }
      if (warnings.length) console.log(`  warnings: ${warnings.join(' | ')}`);
    } catch (e) {
      console.log(`  FAILED: ${(e as Error).message}`);
      const errors = (e as { details?: string[] }).details;
      if (errors?.length) console.log(`  last errors: ${errors.join(' | ')}`);
    }
    if (rounds.length > 1) rounds.forEach((r, i) => console.log(`  round ${i + 1}: ${r}`));
  }
}

async function prose(): Promise<void> {
  // A realistic situation from the sample workspace: one paid invoice, one overdue.
  const clock = { now: new Date(`${today}T15:00:00Z`) };
  const data = newWorkspaceData('b'.repeat(32), clock.now);
  data.sim = newSimulatorState();
  // eslint-disable-next-line prefer-const
  let ws: Workspace;
  const sim = new PayPalSimulator(data.sim, () => ws.nowDate());
  ws = new Workspace(data, { gateway: sim, planner: new ScriptedPlanner(), now: () => clock.now, emit: () => undefined, mock: false, agGridLicensed: false });
  await loadSampleWorkspace(ws, { seen: new Set<string>(), gateway: sim });

  const overdue = ws.data.invoices.find((i) => i.overdue)!;
  const project = ws.data.projects.find((p) => p.id === overdue.projectId)!;
  const run = ws.data.runs.find((r) => r.kind === 'overdue')!;

  section('write: overdue explanation');
  const facts = factsFor('overdue', project, ws.data.invoices, ws.today(), ws.data.lastChange);
  let text = await planner.write({ kind: 'overdue', situation: run.message!, template: run.message!, facts });
  let bad = text ? checkProse(text, facts) : [];
  console.log(`  template: ${run.message}`);
  console.log(`  model:    ${text}`);
  console.log(`  guard:    ${bad.length ? `REJECTED (${describeViolations(bad)})` : 'accepted'}`);
  if (text && bad.length) {
    text = await planner.write({ kind: 'overdue', situation: run.message!, template: run.message!, facts, rejected: describeViolations(bad) });
    bad = text ? checkProse(text, facts) : [];
    console.log(`  retry:    ${text}`);
    console.log(`  guard:    ${bad.length ? `REJECTED (${describeViolations(bad)})` : 'accepted'}`);
  }

  section('write: payment explanation');
  const paid = ws.data.invoices.find((i) => i.paidOn)!;
  const paidProject = ws.data.projects.find((p) => p.id === paid.projectId)!;
  const change = { id: 'chg_x', projectId: paidProject.id, cause: 'payment' as const, at: new Date().toISOString(), invoiceId: paid.id, unlocked: [], shifts: [], deliveryFrom: paidProject.schedule.deliveryDate, deliveryTo: paidProject.schedule.deliveryDate, deliveryDeltaDays: 0 };
  const payFacts = factsFor('payment', paidProject, ws.data.invoices, ws.today(), change);
  const payTemplate = explainPayment(paidProject, paid, change);
  const payText = await planner.write({ kind: 'payment', situation: payTemplate, template: payTemplate, facts: payFacts });
  const payBad = payText ? checkProse(payText, payFacts) : [];
  console.log(`  template: ${payTemplate}`);
  console.log(`  model:    ${payText}`);
  console.log(`  guard:    ${payBad.length ? `REJECTED (${describeViolations(payBad)})` : 'accepted'}`);

  section('reminder draft');
  const rFacts = factsFor('reminder', project, ws.data.invoices, ws.today());
  const t = reminderTemplate(project, overdue);
  const draft = await planner.draftReminder({ kind: 'reminder', situation: `${t.subject}\n${t.note}`, template: t.note, facts: rFacts });
  const rBad = draft ? checkProse(`${draft.subject}\n${draft.note}`, rFacts) : [];
  console.log(`  subject: ${draft?.subject}`);
  console.log(`  note:    ${draft?.note}`);
  console.log(`  guard:   ${!draft ? 'no usable draft' : rBad.length ? `REJECTED (${describeViolations(rBad)})` : 'accepted'}`);
}

async function ledger(): Promise<void> {
  const ctx = { today, clients: ['Northwind Outfitters', 'Harbor Coffee Roasters'], projects: ['Storefront redesign', 'Loyalty app prototype'] };
  for (const q of ['overdue over $500', 'group by client', 'what did Harbor pay us in September, newest first', 'show me the 3 biggest unpaid ones', 'tell me a joke']) {
    section(`ledger: ${q}`);
    rounds.length = 0;
    const r = await planner.ledgerIntent(q, ctx);
    console.log(`  ${r ? JSON.stringify(r) : 'null (fall back to the rule parser)'}`);
    if (rounds.length > 1 || !r) rounds.forEach((x, i) => console.log(`  round ${i + 1}: ${x}`));
  }
}

/** The whole workflow in-process with the real model: brief -> plan -> approve -> invoice -> pay -> explanation. */
async function e2e(): Promise<void> {
  section('e2e: engine + simulator + real model');
  const clock = { now: new Date(`${today}T15:00:00Z`) };
  const data = newWorkspaceData('c'.repeat(32), clock.now);
  data.sim = newSimulatorState();
  // eslint-disable-next-line prefer-const
  let ws: Workspace;
  const sim = new PayPalSimulator(data.sim, () => ws.nowDate());
  ws = new Workspace(data, { gateway: sim, planner, now: () => clock.now, emit: () => undefined, mock: false, agGridLicensed: false });
  const seen = new Set<string>();
  const { handleWebhook } = await import('../shared/webhook.ts');

  const run = await ws.startPlanRun(SAMPLE_BRIEFS[2]!.text);
  await run.done;
  const planRun = ws.data.runs.at(-1)!;
  console.log(`  plan run: ${planRun.status} · by ${ws.data.projects[0]?.plannedBy ?? '?'} · steps: ${planRun.steps.map((s) => s.label).join(' → ')}`);
  console.log(`  explanation (${planRun.messageBy}): ${planRun.message}`);
  const project = ws.data.projects[0]!;
  await ws.approvePlan(project.id);
  const proposal = ws.data.proposals.find((p) => p.status === 'pending')!;
  await ws.approveProposal(proposal.id, {});
  const invoice = ws.data.invoices[0]!;
  const hook = await ws.simulatePayment(invoice.id);
  const res = await handleWebhook({ seen, gateway: sim, route: () => ws }, hook.headers, hook.rawBody);
  await new Promise((r) => setTimeout(r, 15_000));
  const payRun = ws.data.runs.filter((r) => r.kind === 'payment').at(-1);
  console.log(`  webhook: ${JSON.stringify(res)}`);
  console.log(`  payment run: ${payRun?.status} · steps: ${payRun?.steps.map((s) => s.label).join(' → ')}`);
  console.log(`  explanation (${payRun?.messageBy}): ${payRun?.message}`);
}

if (!only || only === 'plan') await plans();
if (!only || only === 'prose') await prose();
if (!only || only === 'ledger') await ledger();
if (only === 'e2e') await e2e();

const u = planner.usage;
const cost = (u.promptTokens * PRICE.input + u.completionTokens * PRICE.output) / 1e6;
console.log(`\n=== usage: ${u.calls} calls, ${u.promptTokens} prompt + ${u.completionTokens} completion tokens ≈ $${cost.toFixed(4)}`);
