import type { Plan, ServerEvent } from '../shared/contract.ts';
import { Workspace, newWorkspaceData, type EngineEnv } from '../shared/engine.ts';
import type { PayPalGateway } from '../shared/paypal/gateway.ts';
import { PayPalSimulator, newSimulatorState } from '../shared/paypal/simulator.ts';
import { ScriptedPlanner } from '../shared/planner/scripted.ts';
import type { Planner } from '../shared/planner/types.ts';
import { handleWebhook, type WebhookResult } from '../shared/webhook.ts';

/** Monday. */
export const T0 = '2026-10-05';

export function plan3(overrides: Partial<Plan> = {}): Plan {
  return {
    title: 'Brand refresh',
    client: { name: 'Juniper & Rye', email: 'ops@juniperandrye.example' },
    currency: 'USD',
    startDate: T0,
    milestones: [
      { id: 'm1', title: 'Deposit', deliverable: 'Deposit', durationDays: 0, amountMinor: 300_000, netDays: 7, dependsOn: [] },
      { id: 'm2', title: 'Design', deliverable: 'Design system', durationDays: 5, amountMinor: 400_000, netDays: 7, dependsOn: [{ on: 'm1', gate: 'paid' }] },
      { id: 'm3', title: 'Build', deliverable: 'Site build', durationDays: 10, amountMinor: 500_000, netDays: 7, dependsOn: [{ on: 'm2', gate: 'paid' }] },
    ],
    ...overrides,
  };
}

export const BRIEF = `Project: Brand refresh
Client: Juniper & Rye <ops@juniperandrye.example>
Total fee: $12,000 with a 25% deposit. Net 7.
- Design (1 week)
- Build (2 weeks)`;

export interface Harness {
  ws: Workspace;
  events: ServerEvent[];
  sim: PayPalSimulator;
  seen: Set<string>;
  clock: { now: Date };
  /** Simulated buyer pays; the webhook goes through the real handler. */
  pay(invoiceId: string): Promise<WebhookResult>;
  /** Approve the first pending proposal of a kind and return it. */
  approveNext(kind?: string): Promise<string>;
  gateway: PayPalGateway;
}

export function harness(opts: { planner?: Planner; wrap?: (g: PayPalSimulator) => PayPalGateway; timeZone?: string; now?: Date } = {}): Harness {
  const clock = { now: opts.now ?? new Date(`${T0}T15:00:00Z`) };
  const events: ServerEvent[] = [];
  const data = newWorkspaceData('a'.repeat(32), clock.now);
  data.sim = newSimulatorState();
  // eslint-disable-next-line prefer-const
  let ws: Workspace;
  const sim = new PayPalSimulator(data.sim, () => ws.nowDate());
  const gateway = opts.wrap ? opts.wrap(sim) : sim;
  const env: EngineEnv = {
    gateway, planner: opts.planner ?? new ScriptedPlanner(), now: () => clock.now, emit: (e) => events.push(structuredClone(e)),
    mock: false, agGridLicensed: false, timeZone: opts.timeZone,
  };
  ws = new Workspace(data, env);
  const seen = new Set<string>();
  return {
    ws, events, sim, seen, clock, gateway,
    async pay(invoiceId) {
      const signed = await sim.pay(invoiceId, ws.today());
      return handleWebhook({ gateway, seen, route: (id) => (ws.ownsInvoice(id) ? ws : undefined) }, signed.headers, signed.rawBody);
    },
    async approveNext(kind) {
      const p = ws.data.proposals.find((x) => x.status === 'pending' && (!kind || x.kind === kind));
      if (!p) throw new Error(`no pending proposal${kind ? ` of kind ${kind}` : ''}`);
      await ws.approveProposal(p.id);
      return p.id;
    },
  };
}

/** A harness with an approved 3-milestone project. */
export async function activeProject(h: Harness = harness()): Promise<{ h: Harness; projectId: string }> {
  const project = await h.ws.addDraft(plan3(), BRIEF, 'agent', 'scripted');
  await h.ws.approvePlan(project.id);
  return { h, projectId: project.id };
}
