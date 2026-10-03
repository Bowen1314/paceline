import { describe, expect, it } from 'vitest';
import type { ServerEvent, WorkspaceState } from '../shared/contract.ts';
import { createSseParser } from '../web/backend/http.ts';
import { MockBackend } from '../web/backend/mock.ts';
import { applyEvent, createStore } from '../web/state.ts';
import { BRIEF, activeProject, harness } from './helpers.ts';

async function settled(get: () => WorkspaceState | null, pred: (s: WorkspaceState) => boolean): Promise<WorkspaceState> {
  for (let i = 0; i < 400; i++) {
    const s = get();
    if (s && pred(s)) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out');
}

describe('client reducer', () => {
  it('drops events that arrive before the first snapshot', () => {
    expect(applyEvent(null, { type: 'project.removed', projectId: 'x' })).toBeNull();
  });

  it('replaying the engine\'s event stream reproduces the engine\'s snapshot', async () => {
    const h = harness();
    let state = applyEvent(null, { type: 'snapshot', state: h.ws.snapshot() });
    let cursor = 0;
    const drain = (): void => {
      for (; cursor < h.events.length; cursor++) state = applyEvent(state, h.events[cursor]!);
    };
    const { projectId } = await activeProject(h);
    drain();
    await h.approveNext('issue_invoice');
    const invoiceId = h.ws.data.projects[0]!.progress.m1!.invoiceId!;
    await h.pay(invoiceId);
    await h.ws.markDelivered(projectId, 'm2');
    await h.approveNext('issue_invoice');
    h.clock.now = new Date(h.clock.now.getTime() + 30 * 86_400_000);
    await h.ws.tick();
    await new Promise((r) => setTimeout(r, 20));
    drain();
    const truth = h.ws.snapshot();
    expect(state!.projects).toEqual(truth.projects);
    expect(state!.invoices).toEqual(truth.invoices);
    expect(state!.proposals).toEqual(truth.proposals);
    expect(state!.runs).toEqual(truth.runs);
    expect(state!.log).toEqual(truth.log);
    expect(state!.lastChange).toEqual(truth.lastChange);
    expect(state!.invoices.some((i) => i.overdue)).toBe(true);
  });

  it('is pure: the previous state object is never mutated', async () => {
    const h = harness();
    const { projectId } = await activeProject(h);
    const before = applyEvent(null, { type: 'snapshot', state: h.ws.snapshot() })!;
    const frozen = structuredClone(before);
    const project = structuredClone(before.projects[0]!);
    project.status = 'completed';
    const events: ServerEvent[] = [
      { type: 'project', project },
      { type: 'project.removed', projectId },
      { type: 'log', entry: { id: 'log_x', at: '2026-10-05T00:00:00Z', actor: 'user', action: 'x', summary: 'x' } },
      { type: 'info', info: { ...before.info, clockOffsetDays: 3 } },
    ];
    let s: WorkspaceState | null = before;
    for (const e of events) s = applyEvent(s, e);
    expect(before).toEqual(frozen);
    expect(s!.projects).toEqual([]);
    expect(s!.info.clockOffsetDays).toBe(3);
  });

  it('upserts by id, de-duplicates log entries and bounds the lists', () => {
    let s = applyEvent(null, { type: 'snapshot', state: harness().ws.snapshot() })!;
    for (let i = 0; i < 350; i++) s = applyEvent(s, { type: 'log', entry: { id: `log_${i}`, at: '2026-10-05T00:00:00Z', actor: 'agent', action: 'a', summary: String(i) } })!;
    expect(s.log).toHaveLength(300);
    expect(s.log.at(-1)!.id).toBe('log_349');
    const again = applyEvent(s, { type: 'log', entry: s.log.at(-1)! });
    expect(again).toBe(s);
    const run = { id: 'run_1', kind: 'plan' as const, title: 't', status: 'running' as const, steps: [], startedAt: '2026-10-05T00:00:00Z' };
    s = applyEvent(s, { type: 'run', run })!;
    s = applyEvent(s, { type: 'run', run: { ...run, status: 'done' } })!;
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]!.status).toBe('done');
  });

  it('the store notifies subscribers only on a real change and taps every event', () => {
    const store = createStore();
    let renders = 0;
    const seen: string[] = [];
    store.subscribe(() => renders++);
    store.onEvent((e) => seen.push(e.type));
    store.dispatch({ type: 'project.removed', projectId: 'x' }); // before snapshot: no state change
    expect(renders).toBe(0);
    store.dispatch({ type: 'snapshot', state: harness().ws.snapshot() });
    expect(renders).toBe(1);
    store.setConnection('open');
    store.setConnection('open');
    expect(renders).toBe(2);
    expect(seen).toEqual(['project.removed', 'snapshot']);
  });
});

describe('SSE parser', () => {
  it('reassembles frames split across chunks and skips comments', () => {
    const got: ServerEvent[] = [];
    const feed = createSseParser((e) => got.push(e));
    const a: ServerEvent = { type: 'project.removed', projectId: 'p1' };
    const b: ServerEvent = { type: 'project.removed', projectId: 'p2' };
    const wire = `retry: 2000\n\ndata: ${JSON.stringify(a)}\n\n: keep-alive\n\ndata: ${JSON.stringify(b)}\n\n`;
    for (let i = 0; i < wire.length; i += 7) feed(wire.slice(i, i + 7));
    expect(got).toEqual([a, b]);
  });

  it('drops a malformed frame without losing the next one', () => {
    const got: ServerEvent[] = [];
    const feed = createSseParser((e) => got.push(e));
    feed('data: {oops\n\ndata: {"type":"project.removed","projectId":"p3"}\n\n');
    expect(got).toEqual([{ type: 'project.removed', projectId: 'p3' }]);
  });
});

describe('mock backend (?mock=1) plays the whole flow without a server', () => {
  it('plan -> approve -> approve invoice -> buyer pays -> next milestone unblocks', async () => {
    const backend = new MockBackend(0);
    const store = createStore();
    const off = backend.subscribe((e) => store.dispatch(e), (c) => store.setConnection(c));
    const first = await settled(store.get, () => true);
    expect(first.info).toMatchObject({ mock: true, mode: 'simulator', planner: 'scripted' });

    await backend.startPlanRun(BRIEF);
    const drafted = await settled(store.get, (s) => s.projects.length === 1 && s.runs.every((r) => r.status === 'done'));
    const projectId = drafted.projects[0]!.id;
    await backend.approvePlan(projectId);
    const proposed = await settled(store.get, (s) => s.proposals.some((p) => p.status === 'pending'));
    expect(proposed.invoices).toEqual([]);
    await backend.approveProposal(proposed.proposals.find((p) => p.status === 'pending')!.id);
    const sent = await settled(store.get, (s) => s.invoices.length === 1);
    await backend.simPay(sent.invoices[0]!.id);
    const paid = await settled(store.get, (s) => s.invoices[0]!.status === 'PAID' && s.lastChange?.cause === 'payment');
    expect(paid.lastChange!.unlocked).toEqual(['m2']);
    expect(paid.projects[0]!.schedule.items[1]!.workState).not.toBe('blocked');

    await expect(backend.approvePlan('nope')).rejects.toMatchObject({ name: 'ApiProblem', status: 404 });
    await backend.reset();
    expect(store.get()!.projects).toEqual([]);
    off();
  });

  it('events handed to the UI are copies, never the engine\'s live objects', async () => {
    const backend = new MockBackend(0);
    const events: ServerEvent[] = [];
    const off = backend.subscribe((e) => events.push(e));
    await backend.simLoadSample();
    const snap = events.filter((e) => e.type === 'snapshot').at(-1)!;
    if (snap.type !== 'snapshot') throw new Error('no snapshot');
    const title = snap.state.projects[0]!.plan.title;
    snap.state.projects[0]!.plan.title = 'mutated by the UI';
    expect((await backend.getState()).projects[0]!.plan.title).toBe(title);
    off();
  });
});
