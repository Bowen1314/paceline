/**
 * Sample briefs for the composer, and the sample workspace for simulator mode.
 *
 * The sample workspace is not a fixture: it is produced by replaying real
 * engine actions (approve plan, approve invoice, simulated buyer payment, mark
 * delivered) at earlier clock offsets, so every row obeys the same rules as
 * live data. All of it is simulated and labelled as sample data in the log.
 */
import type { Workspace } from './engine.ts';
import { groundDraft } from './plan.ts';
import { scriptedDraft } from './planner/scripted.ts';
import type { WebhookDeps } from './webhook.ts';
import { handleWebhook } from './webhook.ts';

export interface SampleBrief {
  label: string;
  text: string;
}

export const SAMPLE_BRIEFS: SampleBrief[] = [
  {
    label: 'Brand refresh · $12,000',
    text: `Project: Brand refresh and marketing site
Client: Juniper & Rye Bakery <ops@juniperandrye.example>

Juniper & Rye is opening a second location and wants a refreshed identity and a new marketing site before the launch. Total fee: $12,000, with a 25% deposit to reserve the start date. Net 7 on every invoice.

Deliverables:
- Discovery and brand direction (1 week)
- Identity system: logo, palette, type (2 weeks)
- Marketing site design and build (3 weeks)
- Launch support and handover (1 week)`,
  },
  {
    label: 'Mobile prototype · itemised',
    text: `Project: Loyalty app prototype
Client: Harbor Coffee Roasters <maya@harborcoffee.example>

Clickable prototype for a loyalty app, itemised and billed per milestone, net 14.

- UX flows and wireframes: $2,400 (6 days)
- Visual design: $3,200 (8 days)
- Interactive prototype and user test: $2,800 (7 days)`,
  },
  {
    label: 'Data dashboard · $8,500',
    text: `Project: Operations dashboard
Client: Tidewater Logistics <finance@tidewater.example>

Fixed price of $8,500 for an internal operations dashboard. 30% upfront, net 10.

1. Data audit and metric definitions (4 days)
2. Dashboard build (2 weeks)
3. Training and documentation (3 days)`,
  },
];

const NORTHWIND = `Project: Storefront redesign
Client: Northwind Outfitters <ap@northwind-outfitters.example>

Redesign of the online storefront. Total fee: $18,000 with a 25% deposit. Net 7.

- Discovery and UX audit (2 weeks)
- Visual design system (2 weeks)
- Storefront build (3 weeks)`;

const HARBOR = SAMPLE_BRIEFS[1]!.text;

/**
 * Build the sample workspace: one project mid-flight with paid history and one
 * whose first invoice is overdue. `deliver` routes a simulated webhook through
 * the host's real handler.
 */
export async function loadSampleWorkspace(ws: Workspace, webhook: Pick<WebhookDeps, 'seen' | 'gateway'>): Promise<void> {
  const deliver = async (invoiceId: string): Promise<void> => {
    const signed = await ws.simulatePayment(invoiceId);
    await handleWebhook({ gateway: webhook.gateway, seen: webhook.seen, route: (id) => (ws.ownsInvoice(id) ? ws : undefined) }, signed.headers, signed.rawBody);
  };
  const approveIssue = async (projectId: string): Promise<string> => {
    const p = ws.data.proposals.find((x) => x.kind === 'issue_invoice' && x.status === 'pending' && x.payload.projectId === projectId);
    if (!p) throw new Error('sample: no pending invoice proposal');
    await ws.approveProposal(p.id);
    const id = ws.data.projects.find((x) => x.id === projectId)!.progress[p.payload.milestoneId]!.invoiceId!;
    return id;
  };
  const draft = async (brief: string): Promise<string> => {
    const g = groundDraft(scriptedDraft(brief, ws.today()), brief, ws.today());
    if (!g.plan) throw new Error(`sample: ${g.errors.join('; ')}`);
    return (await ws.addDraft(g.plan, brief, 'sample', 'scripted')).id;
  };

  await ws.replay(async (at) => {
    // Northwind: approved 31 days ago, deposit and first phase paid, second phase in progress.
    at(-31);
    const nw = await draft(NORTHWIND);
    await ws.approvePlan(nw);
    const dep = await approveIssue(nw);
    at(-29);
    await deliver(dep);
    at(-14);
    await ws.markDelivered(nw, 'm2');
    const inv2 = await approveIssue(nw);
    at(-10);
    await deliver(inv2);

    // Harbor Coffee: approved 26 days ago, first milestone delivered, its invoice is now past due.
    at(-26);
    const hc = await draft(HARBOR);
    await ws.approvePlan(hc);
    at(-18);
    await ws.markDelivered(hc, 'm1');
    await approveIssue(hc);

    at(0);
    await ws.tick();
  });
}
