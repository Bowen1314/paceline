import { describe, expect, it } from 'vitest';
import type { Plan } from '../shared/contract.ts';
import { addWorkingDays, diffDays, nextWorkingDay, rollForward, workEndFor } from '../shared/dates.ts';
import {
  NO_FACTS, PlanCycleError, computeBaseline, computeSchedule, diffSchedules, downstreamOf, isOverdue, knockOnDays, newlyUnlocked, topoOrder,
  type ScheduleFacts,
} from '../shared/schedule.ts';
import { T0, plan3 } from './helpers.ts';

const item = (plan: Plan, facts: ScheduleFacts, today: string, id: string) => computeSchedule(plan, facts, today).items.find((i) => i.milestoneId === id)!;

describe('working-day arithmetic', () => {
  it.each([
    ['2026-10-05', '2026-10-05'], // Mon
    ['2026-10-10', '2026-10-12'], // Sat -> Mon
    ['2026-10-11', '2026-10-12'], // Sun -> Mon
  ])('rollForward(%s) = %s', (d, want) => expect(rollForward(d)).toBe(want));

  it.each([
    ['2026-10-09', '2026-10-12'], // Fri -> Mon
    ['2026-10-10', '2026-10-12'], // Sat -> Mon
    ['2026-10-12', '2026-10-13'],
  ])('nextWorkingDay(%s) = %s', (d, want) => expect(nextWorkingDay(d)).toBe(want));

  it.each([
    ['2026-10-05', 0, '2026-10-05'],
    ['2026-10-05', 4, '2026-10-09'],
    ['2026-10-05', 5, '2026-10-12'],
    ['2026-10-09', 1, '2026-10-12'],
  ])('addWorkingDays(%s, %i) = %s', (d, n, want) => expect(addWorkingDays(d, n)).toBe(want));

  it.each([
    ['2026-10-05', 0, '2026-10-05'],
    ['2026-10-05', 1, '2026-10-05'],
    ['2026-10-05', 5, '2026-10-09'],
    ['2026-10-13', 5, '2026-10-19'],
    ['2026-10-27', 10, '2026-11-09'],
  ])('workEndFor(%s, %i days) = %s', (d, n, want) => expect(workEndFor(d, n)).toBe(want));

  it('crosses a year boundary without drifting', () => {
    expect(diffDays('2026-12-30', '2027-01-02')).toBe(3);
    expect(nextWorkingDay('2026-12-31')).toBe('2027-01-01');
  });
});

describe('baseline: every invoice assumed paid on its due date', () => {
  const s = computeBaseline(plan3(), T0);
  it.each([
    //  id   workStart     workEnd       invoiceOn     dueOn         paidOn
    ['m1', '2026-10-05', '2026-10-05', '2026-10-05', '2026-10-12', '2026-10-12'],
    ['m2', '2026-10-13', '2026-10-19', '2026-10-19', '2026-10-26', '2026-10-26'],
    ['m3', '2026-10-27', '2026-11-09', '2026-11-09', '2026-11-16', '2026-11-16'],
  ])('%s', (id, workStart, workEnd, invoiceOn, dueOn, paidOn) => {
    expect(s.items.find((i) => i.milestoneId === id)).toMatchObject({ workStart, workEnd, invoiceOn, dueOn, paidOn, paidActual: false });
  });
  it('delivery and final payment', () => {
    expect(s.deliveryDate).toBe('2026-11-09');
    expect(s.finalPaymentDate).toBe('2026-11-16');
  });
  it('payment gates block downstream work', () => {
    expect(s.items.map((i) => i.blockedBy)).toEqual([[], ['m1'], ['m2']]);
    expect(s.items.map((i) => i.workState)).toEqual(['delivered', 'blocked', 'blocked']);
    expect(s.items[0]!.payState).toBe('ready_to_invoice');
  });
});

describe('payment-gated dependencies', () => {
  const sent = { status: 'SENT' as const, invoiceDate: '2026-10-05', dueDate: '2026-10-12' };

  // today, deposit invoice fact -> expected m2 start/end, m3 end, m2 state, blockedBy
  it.each([
    ['unpaid, before due: projected on due date', '2026-10-07', sent, '2026-10-13', '2026-10-19', '2026-11-09', 'blocked', ['m1']],
    ['paid early: everything pulls in', '2026-10-06', { ...sent, status: 'PAID' as const, paidOn: '2026-10-06' }, '2026-10-07', '2026-10-13', '2026-11-03', 'scheduled', []],
    ['paid on the due date: baseline holds', '2026-10-12', { ...sent, status: 'PAID' as const, paidOn: '2026-10-12' }, '2026-10-13', '2026-10-19', '2026-11-09', 'scheduled', []],
    ['paid on a Friday: work starts Monday', '2026-10-09', { ...sent, status: 'PAID' as const, paidOn: '2026-10-09' }, '2026-10-12', '2026-10-16', '2026-11-06', 'scheduled', []],
    ['3 days overdue: projected paid today', '2026-10-15', sent, '2026-10-16', '2026-10-22', '2026-11-12', 'blocked', ['m1']],
    ['overdue on a Saturday: starts Monday', '2026-10-17', sent, '2026-10-19', '2026-10-23', '2026-11-13', 'blocked', ['m1']],
    ['MARKED_AS_PAID unlocks too', '2026-10-08', { ...sent, status: 'MARKED_AS_PAID' as const, paidOn: '2026-10-08' }, '2026-10-09', '2026-10-15', '2026-11-05', 'scheduled', []],
    ['PARTIALLY_PAID does not unlock', '2026-10-08', { ...sent, status: 'PARTIALLY_PAID' as const }, '2026-10-13', '2026-10-19', '2026-11-09', 'blocked', ['m1']],
    ['cancelled invoice: gate closed, back to plan dates', '2026-10-08', { ...sent, status: 'CANCELLED' as const }, '2026-10-16', '2026-10-22', '2026-11-12', 'blocked', ['m1']],
  ])('%s', (_name, today, fact, m2Start, m2End, m3End, m2State, blockedBy) => {
    const facts: ScheduleFacts = { delivered: {}, invoices: { m1: fact } };
    const s = computeSchedule(plan3(), facts, today);
    const m2 = s.items[1]!;
    expect({ start: m2.workStart, end: m2.workEnd, state: m2.workState, blockedBy: m2.blockedBy }).toEqual({ start: m2Start, end: m2End, state: m2State, blockedBy });
    expect(s.items[2]!.workEnd).toBe(m3End);
    expect(s.deliveryDate).toBe(m3End);
  });

  it('an unpaid invoice is never treated as paid, however old', () => {
    const s = computeSchedule(plan3(), { delivered: {}, invoices: { m1: sent } }, '2027-03-01');
    expect(s.items[0]).toMatchObject({ paidActual: false, payState: 'overdue', paidOn: '2027-03-01' });
    expect(s.items[1]!.workState).toBe('blocked');
  });
});

describe('overdue rescheduling and knock-on dates', () => {
  const sent = { status: 'SENT' as const, invoiceDate: '2026-10-05', dueDate: '2026-10-12' };
  const baseline = computeBaseline(plan3(), T0);

  it.each([
    ['2026-10-12', 0, 'awaiting'], // due today: not overdue yet
    ['2026-10-13', 0, 'overdue'], // 1 day late, but work would have started the 13th anyway -> starts 14th
    ['2026-10-14', 2, 'overdue'],
    ['2026-10-15', 3, 'overdue'],
    ['2026-10-19', 7, 'overdue'],
    ['2026-10-26', 14, 'overdue'],
  ])('as of %s the delivery date has slipped %i days (%s)', (today, slip, payState) => {
    const s = computeSchedule(plan3(), { delivered: {}, invoices: { m1: sent } }, today);
    expect(s.items[0]!.payState).toBe(payState);
    // One day overdue moves the start from Tue 13 to Wed 14 = +1; reported against the baseline delivery date.
    expect(knockOnDays(baseline, s)).toBe(today === '2026-10-13' ? 1 : slip);
  });

  it('every downstream milestone moves, upstream ones do not', () => {
    const before = computeSchedule(plan3(), { delivered: {}, invoices: { m1: sent } }, '2026-10-12');
    const after = computeSchedule(plan3(), { delivered: {}, invoices: { m1: sent } }, '2026-10-15');
    const shifts = diffSchedules(before, after);
    expect(new Set(shifts.map((s) => s.milestoneId))).toEqual(new Set(['m1', 'm2', 'm3']));
    expect(shifts.find((s) => s.milestoneId === 'm1' && s.field === 'workEnd')).toBeUndefined();
    expect(shifts.find((s) => s.milestoneId === 'm3' && s.field === 'workEnd')).toMatchObject({ from: '2026-11-09', to: '2026-11-12', deltaDays: 3 });
  });

  it('paying late keeps the slip; it does not snap back', () => {
    const paidLate = { ...sent, status: 'PAID' as const, paidOn: '2026-10-15' };
    const s = computeSchedule(plan3(), { delivered: {}, invoices: { m1: paidLate } }, '2026-10-20');
    expect(s.items[1]).toMatchObject({ workStart: '2026-10-16', blockedBy: [] });
    expect(knockOnDays(baseline, s)).toBe(3);
  });

  it('isOverdue: only awaiting statuses, strictly after the due date', () => {
    expect(isOverdue('SENT', '2026-10-12', '2026-10-12')).toBe(false);
    expect(isOverdue('SENT', '2026-10-12', '2026-10-13')).toBe(true);
    expect(isOverdue('PAID', '2026-10-12', '2026-11-13')).toBe(false);
    expect(isOverdue('DRAFT', '2026-10-12', '2026-11-13')).toBe(false);
    expect(isOverdue('CANCELLED', '2026-10-12', '2026-11-13')).toBe(false);
    expect(isOverdue('SCHEDULED', '2026-10-12', '2026-11-13')).toBe(false);
  });
});

describe('work states', () => {
  const paid = { status: 'PAID' as const, invoiceDate: '2026-10-05', dueDate: '2026-10-12', paidOn: '2026-10-06' };
  const facts = (delivered: Record<string, string> = {}): ScheduleFacts => ({ delivered, invoices: { m1: paid } });

  it.each([
    ['2026-10-06', 'scheduled', '2026-10-13'],
    ['2026-10-07', 'in_progress', '2026-10-13'],
    ['2026-10-13', 'in_progress', '2026-10-13'],
    ['2026-10-15', 'late', '2026-10-15'],
    ['2026-10-17', 'late', '2026-10-19'], // Saturday: projected to the next working day
  ])('as of %s milestone m2 is %s, ending %s', (today, state, end) => {
    expect(item(plan3(), facts(), today, 'm2')).toMatchObject({ workState: state, workEnd: end });
  });

  it('late work pushes its own invoice and everything after it', () => {
    const s = computeSchedule(plan3(), facts(), '2026-10-15');
    expect(s.items[1]).toMatchObject({ invoiceOn: '2026-10-15', dueOn: '2026-10-22' });
    expect(s.items[2]!.workStart).toBe('2026-10-23');
  });

  it('delivering early pulls the invoice and downstream in', () => {
    const s = computeSchedule(plan3(), facts({ m2: '2026-10-09' }), '2026-10-09');
    expect(s.items[1]).toMatchObject({ workState: 'delivered', workEnd: '2026-10-09', payState: 'ready_to_invoice', invoiceOn: '2026-10-09', dueOn: '2026-10-16' });
    expect(s.items[2]!.workStart).toBe('2026-10-19');
  });

  it('once PayPal has the invoice, PayPal dates win over the plan', () => {
    const f: ScheduleFacts = { delivered: { m2: '2026-10-09' }, invoices: { m1: paid, m2: { status: 'SENT', invoiceDate: '2026-10-10', dueDate: '2026-10-24' } } };
    expect(item(plan3(), f, '2026-10-12', 'm2')).toMatchObject({ invoiceOn: '2026-10-10', dueOn: '2026-10-24', paidOn: '2026-10-24', payState: 'awaiting' });
  });

  it('a billing-only milestone waits for its day', () => {
    const future = plan3({ startDate: '2026-10-12' });
    expect(item(future, NO_FACTS, '2026-10-05', 'm1')).toMatchObject({ workState: 'scheduled', payState: 'planned' });
    expect(item(future, NO_FACTS, '2026-10-12', 'm1')).toMatchObject({ workState: 'delivered', payState: 'ready_to_invoice' });
  });
});

describe('dependency kinds and graph shape', () => {
  it('a "delivered" gate does not wait for payment', () => {
    const p = plan3();
    p.milestones[2]!.dependsOn = [{ on: 'm2', gate: 'delivered' }];
    const s = computeBaseline(p, T0);
    expect(s.items[2]!.workStart).toBe('2026-10-20'); // day after m2 work ends, not after it is paid
    const delivered = computeSchedule(p, { delivered: { m2: '2026-10-19' }, invoices: { m1: { status: 'PAID', invoiceDate: T0, dueDate: '2026-10-12', paidOn: '2026-10-12' } } }, '2026-10-19');
    expect(delivered.items[2]!.blockedBy).toEqual([]);
  });

  it('with two gates the later one decides', () => {
    const p = plan3();
    p.milestones.push({ id: 'm4', title: 'Launch', deliverable: '', durationDays: 2, amountMinor: 100_000, netDays: 7, dependsOn: [{ on: 'm1', gate: 'paid' }, { on: 'm3', gate: 'delivered' }] });
    const s = computeBaseline(p, T0);
    expect(s.items[3]).toMatchObject({ workStart: '2026-11-10', workEnd: '2026-11-11', blockedBy: ['m1', 'm3'] });
  });

  it('parallel branches are independent', () => {
    const p = plan3();
    p.milestones[2]!.dependsOn = [{ on: 'm1', gate: 'paid' }];
    const s = computeBaseline(p, T0);
    expect(s.items[1]!.workStart).toBe(s.items[2]!.workStart);
    expect(s.deliveryDate).toBe('2026-10-26');
  });

  it('reports items in plan order even when declared out of dependency order', () => {
    const p = plan3();
    p.milestones.reverse();
    expect(computeBaseline(p, T0).items.map((i) => i.milestoneId)).toEqual(['m3', 'm2', 'm1']);
    expect(topoOrder(p.milestones).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('rejects cycles', () => {
    const p = plan3();
    p.milestones[0]!.dependsOn = [{ on: 'm3', gate: 'paid' }];
    expect(() => computeBaseline(p, T0)).toThrow(PlanCycleError);
  });

  it('downstreamOf is transitive', () => {
    expect(downstreamOf(plan3(), 'm1')).toEqual(['m2', 'm3']);
    expect(downstreamOf(plan3(), 'm3')).toEqual([]);
  });

  it('newlyUnlocked reports exactly the milestones a payment released', () => {
    const sent = { status: 'SENT' as const, invoiceDate: T0, dueDate: '2026-10-12' };
    const before = computeSchedule(plan3(), { delivered: {}, invoices: { m1: sent } }, '2026-10-06');
    const after = computeSchedule(plan3(), { delivered: {}, invoices: { m1: { ...sent, status: 'PAID', paidOn: '2026-10-06' } } }, '2026-10-06');
    expect(newlyUnlocked(before, after)).toEqual(['m2']);
  });
});

describe('weekends', () => {
  it('a deposit (billing-only, no gate) is billable on a Saturday start; work still starts on a working day', () => {
    const saturday = '2026-10-03';
    const plan = plan3({ startDate: saturday });
    const s = computeSchedule(plan, NO_FACTS, saturday);
    const m1 = s.items.find((i) => i.milestoneId === 'm1')!;
    expect(m1).toMatchObject({ workStart: saturday, workState: 'delivered', payState: 'ready_to_invoice', invoiceOn: saturday });
    const paidSat = computeSchedule(plan, { delivered: {}, invoices: { m1: { status: 'PAID', invoiceDate: saturday, dueDate: '2026-10-10', paidOn: saturday } } }, saturday);
    expect(paidSat.items.find((i) => i.milestoneId === 'm2')!.workStart).toBe('2026-10-05'); // Monday
  });
});

describe('dates in a time zone', () => {
  it('dateInZone gives the calendar date where the merchant is', async () => {
    const { dateInZone, isTimeZone } = await import('../shared/dates.ts');
    expect(dateInZone(new Date('2026-10-03T00:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-02');
    expect(dateInZone(new Date('2026-10-03T00:30:00Z'), 'UTC')).toBe('2026-10-03');
    expect(dateInZone(new Date('2026-10-02T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-10-03');
    expect(isTimeZone('America/New_York')).toBe(true);
    expect(isTimeZone('Nowhere/Special')).toBe(false);
  });
});
