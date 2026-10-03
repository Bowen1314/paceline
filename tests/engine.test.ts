import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Problem } from '../shared/engine.ts';
import { ApprovalRequiredError, GatedPayPal } from '../shared/gate.ts';
import type { Proposal } from '../shared/contract.ts';
import type { PayPalGateway } from '../shared/paypal/gateway.ts';
import { loadSampleWorkspace } from '../shared/sample.ts';
import { buildLedgerRows } from '../shared/ledger.ts';
import { checkProse } from '../shared/guard.ts';
import { factsFor } from '../shared/prose.ts';
import { BRIEF, activeProject, harness, plan3 } from './helpers.ts';

/** Wrap the simulator so every gateway call is recorded. */
function spied() {
  const calls: string[] = [];
  const h = harness({
    wrap: (sim) =>
      new Proxy(sim, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as unknown as PayPalGateway,
  });
  const writes = () => calls.filter((c) => ['createInvoice', 'sendInvoice', 'sendReminder', 'cancelInvoice'].includes(c));
  return { h, calls, writes };
}

describe('approval gate: no PayPal write without a recorded approval', () => {
  it('planning and approving a plan never touches PayPal', async () => {
    const { h, writes } = spied();
    const { done } = h.ws.startPlanRun(BRIEF);
    await done;
    const project = h.ws.data.projects[0]!;
    expect(project.status).toBe('draft');
    await h.ws.approvePlan(project.id);
    expect(writes()).toEqual([]);
    expect(h.ws.data.invoices).toEqual([]);
    expect(h.ws.data.proposals.map((p) => [p.kind, p.status])).toEqual([['issue_invoice', 'pending']]);
  });

  it('the invoice is created and sent only after the user approves, with the figures the user saw', async () => {
    const { h, writes } = spied();
    await activeProject(h);
    const proposal = h.ws.data.proposals[0]!;
    expect(proposal.payload).toMatchObject({ kind: 'issue_invoice', amountMinor: 300_000, clientEmail: 'ops@juniperandrye.example', invoiceDate: '2026-10-05', dueDate: '2026-10-12' });
    expect(writes()).toEqual([]);

    await h.ws.approveProposal(proposal.id);
    expect(writes()).toEqual(['createInvoice', 'sendInvoice']);
    const inv = h.ws.data.invoices[0]!;
    expect(inv).toMatchObject({ status: 'SENT', amountMinor: 300_000, invoiceDate: '2026-10-05', dueDate: '2026-10-12', source: 'simulator' });
    expect(inv.id).toMatch(/^INV2-SIM0-/);
    const done = h.ws.data.proposals[0]!;
    expect(done).toMatchObject({ status: 'executed', decidedBy: 'user' });
    expect(done.decidedAt).toBeTruthy();
  });

  it('the invoice reference (visible to the recipient) never carries the workspace id, which is the session cookie', async () => {
    const inputs: { reference?: string }[] = [];
    const h = harness({
      wrap: (sim) => new Proxy(sim, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (prop !== 'createInvoice' || typeof v !== 'function') return v;
          return (...args: unknown[]) => {
            inputs.push(args[args.length - 1] as { reference?: string });
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as unknown as PayPalGateway,
    });
    await activeProject(h);
    await h.approveNext();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.reference).toMatch(new RegExp(`^paceline:${h.ws.data.tag}:`));
    expect(inputs[0]!.reference).not.toContain(h.ws.data.id);
  });

  it('the action log shows who approved what, in order', async () => {
    const { h } = spied();
    await activeProject(h);
    await h.approveNext();
    const log = h.ws.data.log.map((e) => `${e.actor}:${e.action}`);
    expect(log).toEqual(['user:plan.approved', 'agent:proposal.created', 'user:proposal.approved', 'agent:invoice.created', 'agent:invoice.sent']);
    const approved = h.ws.data.log.find((e) => e.action === 'proposal.approved')!;
    expect(approved.proposalId).toBe(h.ws.data.proposals[0]!.id);
  });

  it('a declined proposal never reaches PayPal', async () => {
    const { h, writes } = spied();
    await activeProject(h);
    await h.ws.rejectProposal(h.ws.data.proposals[0]!.id);
    await h.ws.tick();
    expect(writes()).toEqual([]);
    expect(h.ws.data.proposals.map((p) => p.status)).toEqual(['rejected']);
    expect(h.ws.data.log.at(-1)).toMatchObject({ actor: 'user', action: 'proposal.rejected' });
  });

  it('an executed proposal cannot be replayed', async () => {
    const { h, writes } = spied();
    await activeProject(h);
    const id = await h.approveNext();
    await expect(h.ws.approveProposal(id)).rejects.toMatchObject({ code: 'proposal_closed' });
    expect(writes()).toEqual(['createInvoice', 'sendInvoice']);
  });

  it.each([
    ['unknown proposal', undefined],
    ['pending', { status: 'pending' }],
    ['rejected', { status: 'rejected', decidedBy: 'user', decidedAt: 'x' }],
    ['executing but not decided by a user', { status: 'executing' }],
    ['already executed', { status: 'executing', decidedBy: 'user', decidedAt: 'x', executedAt: 'y' }],
    ['wrong kind', { status: 'executing', decidedBy: 'user', decidedAt: 'x', kind: 'send_reminder' }],
  ])('the gate itself refuses: %s', async (_n, over) => {
    const gateway = { createInvoice: vi.fn(), sendInvoice: vi.fn(), sendReminder: vi.fn(), cancelInvoice: vi.fn(), getInvoice: vi.fn(), verifyWebhook: vi.fn(), mode: 'simulator' } as unknown as PayPalGateway;
    const proposal = over && ({ id: 'p1', kind: 'issue_invoice', payload: { kind: 'issue_invoice' }, ...over } as unknown as Proposal);
    const gate = new GatedPayPal(gateway, { getProposal: () => proposal });
    await expect(gate.issueInvoice('p1', { number: 'N', reference: 'R' })).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(gateway.createInvoice).not.toHaveBeenCalled();
    expect(gateway.sendInvoice).not.toHaveBeenCalled();
  });

  it('reminders and cancellations are gated the same way', async () => {
    const gateway = { sendReminder: vi.fn(), cancelInvoice: vi.fn() } as unknown as PayPalGateway;
    const gate = new GatedPayPal(gateway, { getProposal: () => ({ id: 'p', kind: 'send_reminder', status: 'pending', payload: { kind: 'send_reminder' } }) as unknown as Proposal });
    await expect(gate.sendReminder('p')).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(gate.cancelInvoice('p')).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(gateway.sendReminder).not.toHaveBeenCalled();
    expect(gateway.cancelInvoice).not.toHaveBeenCalled();
  });

  it('only the gate calls gateway write methods (source check)', () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    for (const f of [...files(join(root, 'shared')), ...files(join(root, 'server'))]) {
      if (/shared\/gate\.ts$/.test(f) || /paypal\/(simulator|sandbox|gateway)\.ts$/.test(f)) continue;
      const src = readFileSync(f, 'utf8');
      if (/\.(createInvoice|sendInvoice|sendReminder|cancelInvoice)\(/.test(src.replace(/this\.gate\.\w+\(/g, ''))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the flow: pay -> unlock, deliver -> invoice, overdue -> reschedule + reminder', () => {
  it('a payment webhook unlocks the next milestone and moves delivery', async () => {
    const { h, projectId } = await activeProject();
    await h.approveNext();
    const inv = h.ws.data.invoices[0]!;
    const before = h.ws.data.projects[0]!.schedule;
    expect(before.items[1]).toMatchObject({ workState: 'blocked', blockedBy: ['m1'], workStart: '2026-10-13' });

    h.events.length = 0;
    const result = await h.pay(inv.id);
    expect(result).toEqual({ status: 200, outcome: 'applied' });

    const project = h.ws.data.projects.find((p) => p.id === projectId)!;
    expect(h.ws.data.invoices[0]).toMatchObject({ status: 'PAID', paidOn: '2026-10-05', dueAmountMinor: 0 });
    expect(project.schedule.items[1]).toMatchObject({ workState: 'scheduled', blockedBy: [], workStart: '2026-10-06' });
    expect(project.knockOnDays).toBe(-7);
    const change = h.ws.data.lastChange!;
    expect(change).toMatchObject({ cause: 'payment', unlocked: ['m2'], invoiceId: inv.id, deliveryFrom: '2026-11-09', deliveryTo: '2026-11-02', deliveryDeltaDays: -7 });

    // The UI gets the state change before the explanation.
    const types = h.events.map((e) => e.type);
    expect(types.indexOf('change')).toBeGreaterThan(-1);
    expect(types.indexOf('invoice')).toBeLessThan(types.indexOf('change'));
    const run = h.ws.data.runs.find((r) => r.kind === 'payment')!;
    expect(run.status).toBe('done');
    expect(run.message).toContain(inv.number);
    expect(run.message).toContain('"Design"');
    expect(h.ws.data.log.map((e) => `${e.actor}:${e.action}`).slice(-2)).toEqual(['paypal:webhook.received', 'agent:plan.advanced']);
  });

  it('marking work delivered proposes its invoice; blocked work cannot be delivered', async () => {
    const { h, projectId } = await activeProject();
    await expect(h.ws.markDelivered(projectId, 'm2')).rejects.toMatchObject({ code: 'milestone_blocked' });
    await h.approveNext();
    await h.pay(h.ws.data.invoices[0]!.id);
    h.clock.now = new Date('2026-10-09T15:00:00Z');
    await h.ws.tick();
    await h.ws.markDelivered(projectId, 'm2');
    const p = h.ws.data.proposals.find((x) => x.status === 'pending')!;
    expect(p.payload).toMatchObject({ kind: 'issue_invoice', milestoneId: 'm2', amountMinor: 400_000, invoiceDate: '2026-10-09', dueDate: '2026-10-16' });
    await expect(h.ws.markDelivered(projectId, 'm2')).rejects.toMatchObject({ code: 'already_delivered' });
  });

  it('an overdue invoice reschedules downstream, reports the knock-on and drafts a reminder for approval', async () => {
    const { h, calls } = spied();
    const { projectId } = await activeProject(h);
    await h.approveNext();
    const inv = h.ws.data.invoices[0]!;

    h.clock.now = new Date('2026-10-12T15:00:00Z'); // due today
    await h.ws.tick();
    expect(h.ws.data.invoices[0]!.overdue).toBe(false);
    expect(h.ws.data.proposals.filter((p) => p.kind === 'send_reminder')).toEqual([]);

    h.clock.now = new Date('2026-10-15T15:00:00Z'); // 3 days late
    await h.ws.tick();
    const project = h.ws.data.projects.find((p) => p.id === projectId)!;
    expect(h.ws.data.invoices[0]).toMatchObject({ overdue: true, daysOverdue: 3, status: 'SENT' });
    expect(project.schedule.items[1]).toMatchObject({ workStart: '2026-10-16', workState: 'blocked' });
    expect(project.schedule.deliveryDate).toBe('2026-11-12');
    expect(project.knockOnDays).toBe(3);
    expect(h.ws.data.lastChange).toMatchObject({ cause: 'overdue', deliveryFrom: '2026-11-09', deliveryTo: '2026-11-12', deliveryDeltaDays: 3 });

    const reminder = h.ws.data.proposals.find((p) => p.kind === 'send_reminder')!;
    expect(reminder).toMatchObject({ status: 'pending', paypalCalls: ['send_invoice_reminder'] });
    expect(reminder.payload).toMatchObject({ invoiceId: inv.id, draftedBy: 'template' });
    expect(calls).not.toContain('sendReminder');
    const run = h.ws.data.runs.find((r) => r.kind === 'overdue')!;
    expect(run.message).toMatch(/3 days overdue/);
    expect(run.message).toMatch(/Nov 9 to Nov 12/);

    // A second tick the same day does not pile up reminders or runs.
    await h.ws.tick();
    expect(h.ws.data.proposals.filter((p) => p.kind === 'send_reminder')).toHaveLength(1);
    expect(h.ws.data.runs.filter((r) => r.kind === 'overdue')).toHaveLength(1);

    // A day later it is still unpaid and delivery slips again: the agent re-tells it with the new dates
    // (so the first explanation never goes stale) but does not draft a second reminder.
    h.clock.now = new Date('2026-10-16T15:00:00Z');
    await h.ws.tick();
    const again = h.ws.data.runs.filter((r) => r.kind === 'overdue');
    expect(again).toHaveLength(2);
    const retold = again.find((r) => r.title.startsWith('Still overdue'))!;
    expect(retold.message).toMatch(/4 days overdue/);
    expect(retold.message).toMatch(/Nov 12 to Nov 13/);
    expect(retold.message).toMatch(/still waiting for your decision/);
    expect(h.ws.data.proposals.find((p) => p.kind === 'send_reminder')!.rationale).toMatch(/4 days overdue/);
    expect(h.ws.data.lastChange).toMatchObject({ cause: 'overdue', deliveryFrom: '2026-11-12' });
    expect(h.ws.data.proposals.filter((p) => p.kind === 'send_reminder')).toHaveLength(1);
    await h.ws.tick();
    expect(h.ws.data.runs.filter((r) => r.kind === 'overdue')).toHaveLength(2);

    // The user edits the note and approves: exactly that text goes out.
    await h.ws.approveProposal(reminder.id, { note: 'Hi, please settle this one. Thanks!' });
    expect(calls.filter((c) => c === 'sendReminder')).toHaveLength(1);
    expect(h.ws.data.invoices[0]!.remindersSent).toBe(1);
    expect(h.sim.remindersSent(inv.id)).toBe(1);
    expect(h.ws.data.log.map((e) => `${e.actor}:${e.action}`).slice(-3)).toEqual(['user:proposal.edited', 'user:proposal.approved', 'agent:reminder.sent']);
  });

  it('after each approval the agent panel says what just happened, in figures the guard accepts', async () => {
    const { h, projectId } = await activeProject();
    const latest = () => h.ws.data.runs.at(-1)!;
    const facts = (kind: Parameters<typeof factsFor>[0] = 'delivery') => factsFor(kind, h.ws.data.projects[0]!, h.ws.data.invoices, h.ws.today());

    expect(latest()).toMatchObject({ kind: 'approval', status: 'done', messageBy: 'template', projectId });
    expect(latest().message).toMatch(/approved and frozen as the baseline/);
    expect(latest().message).toMatch(/\$3,000 for "Deposit"/);
    expect(checkProse(latest().message!, facts())).toEqual([]);

    await h.approveNext('issue_invoice');
    const invoice = h.ws.data.invoices[0]!;
    expect(latest()).toMatchObject({ kind: 'action', title: `Invoice sent · ${invoice.number}`, status: 'done' });
    expect(latest().message).toContain('ops@juniperandrye.example');
    expect(latest().message).toMatch(/"Design" stays locked until PayPal reports it paid/);
    expect(checkProse(latest().message!, facts())).toEqual([]);

    h.clock.now = new Date('2026-10-20T15:00:00Z');
    await h.ws.tick();
    await h.approveNext('send_reminder');
    expect(latest()).toMatchObject({ kind: 'action', title: `Reminder sent · ${invoice.number}` });
    expect(checkProse(latest().message!, facts('overdue'))).toEqual([]);

    await h.ws.requestCancel(invoice.id);
    await h.approveNext('cancel_invoice');
    expect(latest()).toMatchObject({ kind: 'action', title: `Invoice cancelled · ${invoice.number}` });
    expect(h.ws.data.proposals.some((p) => p.kind === 'issue_invoice' && p.status === 'pending')).toBe(true);
    expect(checkProse(latest().message!, facts('cancel'))).toEqual([]);
  });

  it('paying an overdue invoice retires its pending reminder', async () => {
    const { h } = await activeProject();
    await h.approveNext();
    h.clock.now = new Date('2026-10-15T15:00:00Z');
    await h.ws.tick();
    await h.pay(h.ws.data.invoices[0]!.id);
    expect(h.ws.data.proposals.find((p) => p.kind === 'send_reminder')!.status).toBe('superseded');
    expect(h.ws.data.projects[0]!.knockOnDays).toBe(3); // paid late: the slip stays
  });

  it('cancelling needs its own approval and re-opens the milestone for invoicing', async () => {
    const { h, writes } = spied();
    await activeProject(h);
    await h.approveNext();
    const inv = h.ws.data.invoices[0]!;
    const cancel = await h.ws.requestCancel(inv.id);
    expect(cancel).toMatchObject({ kind: 'cancel_invoice', status: 'pending', proposedBy: 'user' });
    expect(writes()).not.toContain('cancelInvoice');
    await h.ws.approveProposal(cancel.id);
    expect(writes()).toContain('cancelInvoice');
    expect(h.ws.data.invoices[0]!.status).toBe('CANCELLED');
    const reissue = h.ws.data.proposals.find((p) => p.kind === 'issue_invoice' && p.status === 'pending')!;
    expect(reissue.rationale).toMatch(/was cancelled/);
    await expect(h.ws.requestCancel(inv.id)).rejects.toBeInstanceOf(Problem);
  });

  it('a pending invoice proposal follows the clock, and a stale approval is refused', async () => {
    const { h } = await activeProject();
    const p = h.ws.data.proposals[0]!;
    h.clock.now = new Date('2026-10-07T15:00:00Z');
    await expect(h.ws.approveProposal(p.id)).rejects.toMatchObject({ code: 'proposal_stale' });
    expect(h.ws.data.proposals[0]!.payload).toMatchObject({ invoiceDate: '2026-10-07', dueDate: '2026-10-14' });
    expect(h.ws.data.invoices).toEqual([]);
    await h.ws.approveProposal(p.id);
    expect(h.ws.data.invoices[0]).toMatchObject({ invoiceDate: '2026-10-07', dueDate: '2026-10-14' });
  });

  it('a PayPal failure marks the proposal failed and a retry does not duplicate the invoice', async () => {
    let failSend = true;
    const h = harness({
      wrap: (sim) =>
        new Proxy(sim, {
          get(target, prop, receiver) {
            if (prop === 'sendInvoice' && failSend) return async () => { throw new Error('socket hang up'); };
            return Reflect.get(target, prop, receiver);
          },
        }) as unknown as PayPalGateway,
    });
    await activeProject(h);
    const id = h.ws.data.proposals[0]!.id;
    const failed = await h.ws.approveProposal(id);
    expect(failed).toMatchObject({ status: 'failed', error: 'socket hang up' });
    expect(h.ws.data.invoices).toEqual([]);
    failSend = false;
    const ok = await h.ws.approveProposal(id);
    expect(ok.status).toBe('executed');
    expect(Object.keys(h.sim.state.invoices)).toHaveLength(1);
    expect(h.ws.data.invoices[0]!.number).toBe(failed.assignedNumber);
  });

  it('finishing every invoice completes the project', async () => {
    const { h, projectId } = await activeProject();
    for (const m of ['m2', 'm3', null]) {
      await h.approveNext('issue_invoice');
      await h.pay(h.ws.data.invoices.at(-1)!.id);
      if (m) await h.ws.markDelivered(projectId, m);
    }
    expect(h.ws.data.projects[0]!.status).toBe('completed');
    expect(h.ws.data.invoices.map((i) => i.status)).toEqual(['PAID', 'PAID', 'PAID']);
    expect(h.ws.data.proposals.every((p) => p.status === 'executed')).toBe(true);
  });
});

describe('plan editing and limits', () => {
  it('a draft can be edited and is re-validated; an approved plan is locked', async () => {
    const h = harness();
    const { done } = h.ws.startPlanRun(BRIEF);
    await done;
    const project = h.ws.data.projects[0]!;
    const edited = structuredClone(project.plan);
    const endBefore = project.schedule.items[1]!.workEnd;
    edited.milestones[1]!.durationDays = 8;
    const out = await h.ws.updatePlan(project.id, edited);
    expect(out.schedule.items[1]!.workEnd).not.toBe(endBefore);
    edited.milestones[1]!.amountMinor = -1;
    await expect(h.ws.updatePlan(project.id, edited)).rejects.toMatchObject({ code: 'invalid_plan' });
    await h.ws.approvePlan(project.id);
    await expect(h.ws.updatePlan(project.id, out.plan)).rejects.toMatchObject({ code: 'plan_locked' });
  });

  it('a plan without a client email cannot be approved', async () => {
    const h = harness();
    await h.ws.startPlanRun('Client: Quiet Co\nTotal: $900\n- Audit (3 days)\n- Report (2 days)').done;
    const project = h.ws.data.projects[0]!;
    expect(project.warnings.map((w) => w.code)).toContain('email_missing');
    await expect(h.ws.approvePlan(project.id)).rejects.toMatchObject({ code: 'plan_not_approvable' });
  });

  it('a failed plan run ends in an error and creates nothing', async () => {
    const h = harness();
    await h.ws.startPlanRun('We would like a website, something modern and clean please.').done;
    expect(h.ws.data.projects).toEqual([]);
    expect(h.ws.data.runs[0]).toMatchObject({ status: 'error' });
    expect(h.ws.data.runs[0]!.error).toMatch(/could not find a fee/);
  });

  it('rejects briefs that are too short or too long', () => {
    const h = harness();
    expect(() => h.ws.startPlanRun('hi')).toThrow(Problem);
    expect(() => h.ws.startPlanRun('x'.repeat(7000))).toThrow(Problem);
  });

  it('simulator-only controls validate their input', async () => {
    const h = harness();
    await expect(h.ws.advanceClock(0)).rejects.toMatchObject({ code: 'invalid_days' });
    await expect(h.ws.advanceClock(61)).rejects.toMatchObject({ code: 'invalid_days' });
    await h.ws.advanceClock(3);
    expect(h.ws.today()).toBe('2026-10-08');
  });
});

describe('sample workspace', () => {
  it('is built by replaying real actions and ends in a consistent state', async () => {
    const h = harness();
    h.events.length = 0;
    await loadSampleWorkspace(h.ws, { gateway: h.gateway, seen: h.seen });
    expect(h.events.map((e) => e.type)).toEqual(['snapshot']);
    expect(h.ws.data.clockOffsetDays).toBe(0);
    const [nw, hc] = h.ws.data.projects;
    expect(nw!.plan.client.name).toBe('Northwind Outfitters');
    expect(nw!.schedule.items.map((i) => i.payState)).toEqual(['paid', 'paid', 'planned', 'planned']);
    expect(hc!.schedule.items[0]!.payState).toBe('overdue');
    expect(h.ws.data.proposals.filter((p) => p.status === 'pending').map((p) => p.kind)).toEqual(['send_reminder']);
    expect(h.ws.data.log.every((e) => e.actor === 'system' && e.summary.startsWith('[sample data]'))).toBe(true);
    const rows = buildLedgerRows(h.ws.data.projects, h.ws.data.invoices, h.ws.today());
    expect(rows.filter((r) => r.status === 'paid')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'overdue')).toHaveLength(1);
    expect(rows.filter((r) => r.status === 'planned')).toHaveLength(4);
  });
});

describe('time zone and PayPal date rules', () => {
  it('"today" is the merchant-side date: 00:30 UTC on Oct 3 is still Oct 2 in Los Angeles', async () => {
    const now = new Date('2026-10-03T00:30:00Z');
    expect(harness({ now }).ws.today()).toBe('2026-10-03');
    const h = harness({ now, timeZone: 'America/Los_Angeles' });
    expect(h.ws.today()).toBe('2026-10-02');
    const draft = await h.ws.addDraft(plan3({ startDate: '2026-10-02' }), BRIEF, 'agent', 'scripted');
    await h.ws.approvePlan(draft.id);
    const p = h.ws.data.proposals.find((x) => x.kind === 'issue_invoice' && x.payload.projectId === draft.id)!;
    expect(p.payload).toMatchObject({ invoiceDate: '2026-10-02' });
  });

  it('refuses to propose cancelling a SCHEDULED invoice (PayPal answers 422 CANNOT_CANCEL_SCHEDULED_INVOICE)', async () => {
    const { h } = await activeProject();
    await h.approveNext();
    const inv = h.ws.data.invoices[0]!;
    inv.status = 'SCHEDULED';
    await expect(h.ws.requestCancel(inv.id)).rejects.toMatchObject({ status: 409, code: 'not_cancellable' });
  });
});
