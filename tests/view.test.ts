/**
 * The two pure view adapters: engine state -> Gantt rows/links (what Bryntum
 * draws) and LedgerIntent -> AG Grid filter/column state (what the plain-
 * language ledger applies).
 */
import { describe, expect, it } from 'vitest';
import type { LedgerIntent } from '../shared/contract.ts';
import { parseLedgerQuery } from '../shared/ledger.ts';
import { buildGanttModel, payId, workId } from '../web/gantt/model.ts';
import { intentToGrid } from '../web/ledger/intent.ts';
import { T0, activeProject, harness } from './helpers.ts';

describe('gantt model', () => {
  it('turns each milestone into a work bar and an invoice bar, gated by payment', async () => {
    const h = harness();
    const { projectId } = await activeProject(h);
    const s = h.ws.snapshot();
    const model = buildGanttModel(s.projects, s.invoices, T0);

    expect(model.rows).toHaveLength(1);
    const project = model.rows[0]!;
    expect(project).toMatchObject({ id: `p:${projectId}`, kind: 'project', status: 'On plan', draft: false });
    // m1 is a deposit (no work), m2 and m3 have work + invoice.
    expect(project.children!.map((r) => r.id)).toEqual([
      payId(projectId, 'm1'), workId(projectId, 'm2'), payId(projectId, 'm2'), workId(projectId, 'm3'), payId(projectId, 'm3'),
    ]);
    expect(project.children![0]).toMatchObject({ kind: 'pay', name: 'Deposit', status: 'To invoice', amountText: '$3,000' });
    expect(project.children![1]).toMatchObject({ kind: 'work', name: 'Design', status: 'Blocked', canDeliver: false });

    // "invoice paid" is a dependency: m1's invoice bar -> m2's work bar, not yet met.
    const gate = model.links.find((l) => l.from === payId(projectId, 'm1') && l.to === workId(projectId, 'm2'));
    expect(gate).toMatchObject({ gate: 'paid', met: false });
    // ...and each work bar leads to its own invoice.
    expect(model.links.find((l) => l.from === workId(projectId, 'm2') && l.to === payId(projectId, 'm2'))).toMatchObject({ gate: 'invoice', met: false });
    // Every link points at rows that exist.
    const ids = new Set(project.children!.map((r) => r.id));
    for (const l of model.links) expect(ids.has(l.from) && ids.has(l.to)).toBe(true);

    // The window contains today and every bar; ends are exclusive.
    expect(model.today).toBe(T0);
    for (const r of project.children!) {
      expect(r.start >= model.start && r.end <= model.end).toBe(true);
      expect(r.end > r.start).toBe(true);
    }
  });

  it('follows the engine after a payment: gate met, work scheduled, invoice row carries the PayPal number', async () => {
    const h = harness();
    const { projectId } = await activeProject(h);
    await h.approveNext('issue_invoice');
    const invoiceId = h.ws.data.projects[0]!.progress.m1!.invoiceId!;
    await h.pay(invoiceId);
    const s = h.ws.snapshot();
    const model = buildGanttModel(s.projects, s.invoices, T0, new Set([`${projectId}:m2`]));
    const rows = model.rows[0]!.children!;

    expect(rows[0]).toMatchObject({ status: 'Paid', tone: 'paid' });
    expect(rows[0]!.label).toMatch(/^\$3,000 paid /);
    const design = rows.find((r) => r.id === workId(projectId, 'm2'))!;
    expect(design.status).not.toBe('Blocked');
    expect(design.highlighted).toBe(true);
    expect(rows.filter((r) => r.highlighted)).toHaveLength(1);
    expect(model.links.find((l) => l.from === payId(projectId, 'm1'))).toMatchObject({ met: true });

    // Every date in the model is one the engine computed.
    const item = s.projects[0]!.schedule.items.find((i) => i.milestoneId === 'm2')!;
    expect(design.start).toBe(item.workStart);
    expect(design.baseline).toBeDefined();
  });

  it('marks drafts, shows slippage on the project row, and offers "deliver" only for work in progress', async () => {
    const h = harness();
    const run = await h.ws.startPlanRun('Project: X\nClient: Acme <a@acme.example>\nTotal fee: $4,000 with a 50% deposit. Net 7.\n- Build (1 week)');
    await run.done;
    let s = h.ws.snapshot();
    let model = buildGanttModel(s.projects, s.invoices, T0);
    expect(model.rows[0]).toMatchObject({ status: 'Draft plan', draft: true });
    expect(model.rows[0]!.children!.every((r) => r.draft && r.status === 'Draft')).toBe(true);

    const h2 = harness();
    const { projectId } = await activeProject(h2);
    await h2.approveNext('issue_invoice');
    await h2.pay(h2.ws.data.projects[0]!.progress.m1!.invoiceId!);
    await h2.ws.markDelivered(projectId, 'm2').catch(() => undefined);
    await h2.approveNext('issue_invoice').catch(() => undefined);
    h2.clock.now = new Date(h2.clock.now.getTime() + 40 * 86_400_000);
    await h2.ws.tick();
    s = h2.ws.snapshot();
    const today = h2.ws.today();
    model = buildGanttModel(s.projects, s.invoices, today);
    const p = model.rows[0]!;
    expect(s.projects[0]!.knockOnDays).toBeGreaterThan(0);
    expect(p.status).toBe(`+${s.projects[0]!.knockOnDays}d vs plan`);
    expect(p.tone).toBe('late');
    expect(p.children!.some((r) => r.status === 'Overdue')).toBe(true);
    for (const r of p.children!) {
      const state = s.projects[0]!.schedule.items.find((i) => i.milestoneId === r.milestoneId)!;
      expect(r.canDeliver).toBe(r.kind === 'work' && (state.workState === 'in_progress' || state.workState === 'late'));
    }
  });
});

describe('ledger intent -> AG Grid state', () => {
  const base: LedgerIntent = { filters: [], groupBy: [], sort: [], reset: true };
  const CTX = { today: T0, clients: ['Harbor Coffee Roasters'], projects: [] };

  it('maps each filter kind onto the matching AG Grid filter model', () => {
    const g = intentToGrid({
      ...base,
      filters: [
        { column: 'status', op: 'in', values: ['overdue'] },
        { column: 'amountMinor', op: 'gt', value: 50_000 },
        { column: 'daysPastDue', op: 'gte', value: 3 },
        { column: 'client', op: 'contains', value: 'Harbor' },
        { column: 'dueOn', op: 'between', from: '2026-10-01', to: '2026-10-31' },
        { column: 'paidOn', op: 'after', from: '2026-09-30' },
        { column: 'issuedOn', op: 'before', to: '2026-10-01' },
      ],
    });
    expect(g.filterModel).toEqual({
      status: { filterType: 'set', values: ['overdue'] },
      amountMinor: { filterType: 'number', type: 'greaterThan', filter: 500 }, // minor units -> the dollars the grid shows
      daysPastDue: { filterType: 'number', type: 'greaterThanOrEqual', filter: 3 },
      client: { filterType: 'text', type: 'contains', filter: 'Harbor' },
      dueOn: { filterType: 'date', type: 'inRange', dateFrom: '2026-10-01', dateTo: '2026-10-31' },
      paidOn: { filterType: 'date', type: 'greaterThan', dateFrom: '2026-09-30', dateTo: null },
      issuedOn: { filterType: 'date', type: 'lessThan', dateFrom: '2026-10-01', dateTo: null },
    });
    expect(g.columnState).toEqual([]);
  });

  it('maps grouping and sorting onto column state, merging when a column does both', () => {
    const g = intentToGrid({ ...base, groupBy: ['client', 'status'], sort: [{ column: 'client', dir: 'asc' }, { column: 'amountMinor', dir: 'desc' }] });
    expect(g.filterModel).toEqual({});
    expect(g.columnState).toEqual([
      { colId: 'client', rowGroup: true, rowGroupIndex: 0, sort: 'asc', sortIndex: 0 },
      { colId: 'status', rowGroup: true, rowGroupIndex: 1 },
      { colId: 'amountMinor', sort: 'desc', sortIndex: 1 },
    ]);
  });

  it('the brief\'s own examples go from words to grid state through the rule parser', () => {
    const overdue = intentToGrid(parseLedgerQuery('overdue over $500', CTX).intent);
    expect(overdue.filterModel).toEqual({
      status: { filterType: 'set', values: ['overdue'] },
      amountMinor: { filterType: 'number', type: 'greaterThan', filter: 500 },
    });
    const grouped = intentToGrid(parseLedgerQuery('group by client', CTX).intent);
    expect(grouped.columnState).toEqual([{ colId: 'client', rowGroup: true, rowGroupIndex: 0 }]);
  });
});
