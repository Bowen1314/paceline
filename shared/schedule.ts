/**
 * Scheduling: pure functions, no I/O, no clock access (today is a parameter).
 *
 * The idea that makes Paceline different from an ordinary Gantt: a milestone's
 * invoice being PAID is a dependency like any other. Until PayPal says the
 * upstream invoice is paid, the schedule uses a projection (the due date, or
 * today once the invoice is overdue), so every late day visibly pushes all
 * downstream work and the delivery date.
 */
import type {
  ISODate, Milestone, PayPalInvoiceStatus, Plan, Schedule, ScheduledMilestone, ScheduleShift,
} from './contract.ts';
import { addDays, diffDays, maxDate, minDate, nextWorkingDay, rollForward, workEndFor } from './dates.ts';

/** What PayPal has told us about the current invoice of a milestone. */
export interface InvoiceFact {
  status: PayPalInvoiceStatus;
  invoiceDate: ISODate;
  dueDate: ISODate;
  paidOn?: ISODate;
}

export interface ScheduleFacts {
  /** milestone id -> the day the user marked its work delivered */
  delivered: Record<string, ISODate>;
  /** milestone id -> its current (non-cancelled) invoice */
  invoices: Record<string, InvoiceFact>;
}

export const NO_FACTS: ScheduleFacts = { delivered: {}, invoices: {} };

const SETTLED: ReadonlySet<PayPalInvoiceStatus> = new Set(['PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL', 'PARTIALLY_REFUNDED']);
const DEAD: ReadonlySet<PayPalInvoiceStatus> = new Set(['CANCELLED', 'AUTO_CANCELLED', 'REFUNDED', 'MARKED_AS_REFUNDED', 'REFUNDED_EXTERNAL']);
const AWAITING: ReadonlySet<PayPalInvoiceStatus> = new Set(['SENT', 'UNPAID', 'PARTIALLY_PAID', 'PAYMENT_PENDING', 'SHARED', 'SCHEDULED']);

/** The invoice counts as paid for the purpose of unlocking downstream work. */
export function isSettled(status: PayPalInvoiceStatus): boolean {
  return SETTLED.has(status);
}
/** Cancelled or fully refunded: the gate is closed and the invoice must be re-issued. */
export function isDead(status: PayPalInvoiceStatus): boolean {
  return DEAD.has(status);
}
export function isAwaitingPayment(status: PayPalInvoiceStatus): boolean {
  return AWAITING.has(status);
}
/** PayPal has no OVERDUE status; Paceline derives it. */
export function isOverdue(status: PayPalInvoiceStatus, dueDate: ISODate, today: ISODate): boolean {
  return isAwaitingPayment(status) && status !== 'SCHEDULED' && today > dueDate;
}

export class PlanCycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Milestone dependencies form a cycle: ${cycle.join(' -> ')}`);
    this.name = 'PlanCycleError';
  }
}

/** Milestones ordered so that every dependency comes before its dependants. Stable. */
export function topoOrder(milestones: Milestone[]): Milestone[] {
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const state = new Map<string, 1 | 2>();
  const out: Milestone[] = [];
  const visit = (m: Milestone, trail: string[]): void => {
    const s = state.get(m.id);
    if (s === 2) return;
    if (s === 1) throw new PlanCycleError([...trail.slice(trail.indexOf(m.id)), m.id]);
    state.set(m.id, 1);
    for (const dep of m.dependsOn) {
      const up = byId.get(dep.on);
      if (!up) throw new Error(`Milestone ${m.id} depends on unknown milestone ${dep.on}`);
      visit(up, [...trail, m.id]);
    }
    state.set(m.id, 2);
    out.push(m);
  };
  for (const m of milestones) visit(m, []);
  return out;
}

/**
 * Compute the schedule for a plan given what has actually happened so far.
 *
 * Rules
 *  1. A milestone with no dependencies starts on the plan's start date.
 *  2. Otherwise work starts on the first working day after its last gate is met.
 *     A `paid` gate is met on the day the upstream invoice is paid; a
 *     `delivered` gate on the day the upstream work is delivered.
 *  3. Unmet gates are projected: an unpaid invoice is assumed paid on its due
 *     date, or today if it is already overdue (so each late day slips the plan).
 *  4. Work lasts `durationDays` working days (Mon–Fri). Unblocked work that has
 *     run past its planned end is `late` and projected to finish today.
 *  5. The invoice is issued the day the work is delivered and is due `netDays`
 *     calendar days later. Once PayPal has the invoice, PayPal's dates win.
 *  6. Billing-only milestones (0 days) fall on a single day and count as
 *     delivered as soon as that day arrives with all gates met. That day is not
 *     rolled to a working day: an invoice can go out on a Saturday, only work
 *     follows Mon–Fri (a plan approved at the weekend bills its deposit at once).
 */
export function computeSchedule(plan: Plan, facts: ScheduleFacts, today: ISODate): Schedule {
  const done = new Map<string, ScheduledMilestone>();

  for (const m of topoOrder(plan.milestones)) {
    const blockedBy: string[] = [];
    const gateDates: ISODate[] = [];
    for (const dep of m.dependsOn) {
      const up = done.get(dep.on)!;
      if (dep.gate === 'paid') {
        gateDates.push(up.paidOn);
        if (!up.paidActual) blockedBy.push(dep.on);
      } else {
        gateDates.push(up.workEnd);
        if (up.workState !== 'delivered') blockedBy.push(dep.on);
      }
    }

    const billingOnly = m.durationDays <= 0;
    let workStart: ISODate;
    if (billingOnly) workStart = gateDates.length === 0 ? plan.startDate : maxDate(...gateDates);
    else if (gateDates.length === 0) workStart = rollForward(plan.startDate);
    else workStart = nextWorkingDay(maxDate(...gateDates));

    const plannedEnd = workEndFor(workStart, m.durationDays);
    const deliveredOn = facts.delivered[m.id];
    let workEnd = plannedEnd;
    let workState: ScheduledMilestone['workState'];

    if (deliveredOn) {
      workState = 'delivered';
      workEnd = deliveredOn;
      workStart = minDate(workStart, deliveredOn);
    } else if (blockedBy.length > 0) {
      workState = 'blocked';
    } else if (billingOnly) {
      workState = today >= workStart ? 'delivered' : 'scheduled';
    } else if (today < workStart) {
      workState = 'scheduled';
    } else if (today <= plannedEnd) {
      workState = 'in_progress';
    } else {
      workState = 'late';
      workEnd = rollForward(today);
    }

    const inv = facts.invoices[m.id];
    const live = inv && !isDead(inv.status) && inv.status !== 'DRAFT' ? inv : undefined;
    let invoiceOn: ISODate;
    let dueOn: ISODate;
    let paidOn: ISODate;
    let paidActual = false;
    let payState: ScheduledMilestone['payState'];

    if (live) {
      invoiceOn = live.invoiceDate;
      dueOn = live.dueDate;
      if (isSettled(live.status)) {
        paidActual = true;
        paidOn = live.paidOn ?? today;
        payState = 'paid';
      } else {
        paidOn = maxDate(dueOn, today);
        payState = isOverdue(live.status, dueOn, today) ? 'overdue' : 'awaiting';
      }
    } else {
      invoiceOn = workState === 'delivered' ? maxDate(workEnd, today) : workEnd;
      dueOn = addDays(invoiceOn, m.netDays);
      paidOn = dueOn;
      payState = workState === 'delivered' ? 'ready_to_invoice' : 'planned';
    }

    done.set(m.id, {
      milestoneId: m.id, workStart, workEnd, workState, invoiceOn, dueOn, paidOn, paidActual, payState, blockedBy,
    });
  }

  // Report in plan order, not topological order.
  const items = plan.milestones.map((m) => done.get(m.id)!);
  return {
    asOf: today,
    items,
    deliveryDate: items.length ? maxDate(...items.map((i) => i.workEnd)) : rollForward(plan.startDate),
    finalPaymentDate: items.length ? maxDate(...items.map((i) => i.paidOn)) : rollForward(plan.startDate),
  };
}

/** The plan as approved: no facts, as of the approval day. */
export function computeBaseline(plan: Plan, approvedOn: ISODate): Schedule {
  return computeSchedule(plan, NO_FACTS, approvedOn);
}

/** Calendar days the delivery date has moved against the baseline (+ = later). */
export function knockOnDays(baseline: Schedule | undefined, current: Schedule): number {
  return baseline ? diffDays(baseline.deliveryDate, current.deliveryDate) : 0;
}

/** Field-level differences between two schedules of the same plan. */
export function diffSchedules(before: Schedule, after: Schedule): ScheduleShift[] {
  const prev = new Map(before.items.map((i) => [i.milestoneId, i]));
  const shifts: ScheduleShift[] = [];
  for (const cur of after.items) {
    const old = prev.get(cur.milestoneId);
    if (!old) continue;
    for (const field of ['workStart', 'workEnd', 'paidOn'] as const) {
      if (old[field] !== cur[field]) {
        shifts.push({ milestoneId: cur.milestoneId, field, from: old[field], to: cur[field], deltaDays: diffDays(old[field], cur[field]) });
      }
    }
  }
  return shifts;
}

/** Milestones that were blocked before and are not blocked now. */
export function newlyUnlocked(before: Schedule, after: Schedule): string[] {
  const wasBlocked = new Set(before.items.filter((i) => i.blockedBy.length > 0).map((i) => i.milestoneId));
  return after.items.filter((i) => wasBlocked.has(i.milestoneId) && i.blockedBy.length === 0).map((i) => i.milestoneId);
}

/** Every milestone downstream of `id` (transitively), in plan order. */
export function downstreamOf(plan: Plan, id: string): string[] {
  const hit = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of plan.milestones) {
      if (!hit.has(m.id) && m.dependsOn.some((d) => hit.has(d.on))) {
        hit.add(m.id);
        grew = true;
      }
    }
  }
  hit.delete(id);
  return plan.milestones.filter((m) => hit.has(m.id)).map((m) => m.id);
}
