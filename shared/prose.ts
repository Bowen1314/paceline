/**
 * Facts and deterministic prose.
 *
 * `factsFor` lists every figure the system actually knows about a project.
 * The template writers below build their sentences only from those figures,
 * so their output passes the no-invention guard by construction (a test
 * asserts this). When a model is configured its prose is checked against the
 * same facts, and these templates are the fallback.
 */
import type { ChangeSet, ISODate, Invoice, Milestone, Project } from './contract.ts';
import { diffDays, formatDate } from './dates.ts';
import { emptyFacts, type Facts } from './guard.ts';
import { formatMoney } from './money.ts';
import { planTotal } from './plan.ts';
import { downstreamOf } from './schedule.ts';

export type ProseKind = 'plan' | 'payment' | 'overdue' | 'delivery' | 'reminder' | 'cancel';

const STATUS_BY_KIND: Record<ProseKind, string[]> = {
  plan: ['paid', 'draft'],
  payment: ['paid'],
  overdue: ['overdue', 'unpaid', 'sent'],
  delivery: ['sent', 'paid'],
  reminder: ['overdue', 'unpaid'],
  cancel: ['cancelled'],
};

export function factsFor(kind: ProseKind, project: Project, invoices: Invoice[], today: ISODate, change?: ChangeSet): Facts {
  const f = emptyFacts();
  const plan = project.plan;
  const mine = invoices.filter((i) => i.projectId === project.id);
  const total = planTotal(plan);
  const paid = mine.reduce((s, i) => s + i.payments.reduce((a, p) => a + p.amountMinor, 0), 0);

  f.amountsMinor.add(total).add(paid).add(total - paid);
  for (const m of plan.milestones) {
    f.amountsMinor.add(m.amountMinor);
    f.numbers.add(m.durationDays).add(m.netDays);
    if (total > 0) f.numbers.add(Math.round((m.amountMinor / total) * 100));
    f.names.add(m.title);
  }
  for (const i of mine) {
    f.amountsMinor.add(i.amountMinor).add(i.dueAmountMinor);
    f.ids.add(i.id.toUpperCase()).add(i.number.toUpperCase());
    f.dates.add(i.invoiceDate).add(i.dueDate);
    if (i.paidOn) f.dates.add(i.paidOn);
    f.numbers.add(i.daysOverdue).add(i.remindersSent);
  }
  f.dates.add(today).add(plan.startDate);
  for (const s of [project.schedule, project.baseline]) {
    if (!s) continue;
    f.dates.add(s.deliveryDate).add(s.finalPaymentDate);
    for (const it of s.items) f.dates.add(it.workStart).add(it.workEnd).add(it.invoiceOn).add(it.dueOn).add(it.paidOn);
  }
  const n = plan.milestones.length;
  for (let i = 0; i <= n; i++) f.numbers.add(i);
  f.numbers.add(mine.length).add(Math.abs(project.knockOnDays));
  f.numbers.add(plan.milestones.reduce((s, m) => s + m.durationDays, 0));
  if (project.baseline) f.numbers.add(Math.abs(diffDays(today, project.schedule.deliveryDate)));
  if (change) {
    f.dates.add(change.deliveryFrom).add(change.deliveryTo);
    f.numbers.add(Math.abs(change.deliveryDeltaDays)).add(change.unlocked.length).add(new Set(change.shifts.map((s) => s.milestoneId)).size);
    for (const s of change.shifts) {
      f.dates.add(s.from).add(s.to);
      f.numbers.add(Math.abs(s.deltaDays));
    }
  }
  if (plan.client.email) f.emails.add(plan.client.email.toLowerCase());
  f.names.add(plan.title).add(plan.client.name);
  for (const s of STATUS_BY_KIND[kind]) f.statuses.add(s);
  return f;
}

const days = (n: number): string => `${Math.abs(n)} ${Math.abs(n) === 1 ? 'day' : 'days'}`;
const money = (minor: number, p: Project): string => formatMoney(minor, p.plan.currency);
const title = (p: Project, id: string): string => `"${p.plan.milestones.find((m) => m.id === id)?.title ?? id}"`;
const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

function deliverySentence(change: ChangeSet): string {
  const d = change.deliveryDeltaDays;
  if (d === 0) return `The delivery date stays ${formatDate(change.deliveryTo)}.`;
  return d < 0
    ? `Delivery moves up from ${formatDate(change.deliveryFrom)} to ${formatDate(change.deliveryTo)}, ${days(d)} sooner.`
    : `Delivery slips from ${formatDate(change.deliveryFrom)} to ${formatDate(change.deliveryTo)}, ${days(d)} later.`;
}

export function explainPlan(project: Project): string {
  const p = project.plan;
  const n = p.milestones.length;
  const gated = p.milestones.filter((m) => m.dependsOn.some((d) => d.gate === 'paid')).length;
  const parts = [
    `I split ${p.title} for ${p.client.name} into ${n} ${n === 1 ? 'milestone' : 'milestones'} totalling ${money(planTotal(p), project)}.`,
  ];
  if (gated > 0) parts.push(`${gated} of them start only once the invoice before them is paid, so each payment wait is a real dependency in the plan.`);
  parts.push(`If every invoice is paid on its due date, delivery lands on ${formatDate(project.schedule.deliveryDate)}.`);
  parts.push('Nothing has gone to PayPal. Check the amounts and dates, then approve the plan.');
  return parts.join(' ');
}

export function explainPayment(project: Project, invoice: Invoice, change: ChangeSet): string {
  const parts = [`PayPal confirmed ${invoice.number} (${money(invoice.amountMinor, project)}) as paid${invoice.paidOn ? ` on ${formatDate(invoice.paidOn)}` : ''}.`];
  if (change.unlocked.length > 0) {
    const starts = change.unlocked.map((id) => {
      const it = project.schedule.items.find((i) => i.milestoneId === id)!;
      return `${title(project, id)} (starts ${formatDate(it.workStart)})`;
    });
    parts.push(`That payment was the gate for ${list(starts)}, so the work is unlocked.`);
  } else if (project.schedule.items.every((i) => i.paidActual)) {
    parts.push('Every invoice on this project is now paid.');
  }
  parts.push(deliverySentence(change));
  return parts.join(' ');
}

/** `reminder`: `drafted` on the day it goes overdue; later re-tellings say whether one is still `waiting`. */
export function explainOverdue(project: Project, invoice: Invoice, change: ChangeSet, reminder: 'drafted' | 'waiting' | 'none' = 'drafted'): string {
  const held = downstreamOf(project.plan, invoice.milestoneId);
  const parts = [
    `${invoice.number} (${money(invoice.amountMinor, project)}) was due ${formatDate(invoice.dueDate)} and is now ${days(invoice.daysOverdue)} overdue.`,
  ];
  if (held.length > 0) {
    parts.push(change.shifts.length > 0
      ? `${title(project, held[0]!)} cannot start until it is settled, so I rescheduled ${held.length === 1 ? 'it' : `it and everything after it`}.`
      : `${title(project, held[0]!)} cannot start until it is settled. Nothing downstream has had to move yet.`);
  }
  parts.push(deliverySentence(change));
  if (project.knockOnDays > 0) parts.push(`That is ${days(project.knockOnDays)} behind the plan you approved.`);
  if (reminder === 'drafted') parts.push('I drafted a reminder for you to review. Nothing is sent until you approve it.');
  if (reminder === 'waiting') parts.push('The reminder I drafted is still waiting for your decision.');
  return parts.join(' ');
}

export function explainDelivery(project: Project, milestone: Milestone, dueOn: ISODate): string {
  return `"${milestone.title}" is marked delivered. Its invoice for ${money(milestone.amountMinor, project)} is ready: approve it and I will create and send it through PayPal, due ${formatDate(dueOn)}.`;
}

/** After the user approves a plan. `first` is the milestone whose invoice is waiting for approval, if any. */
export function explainApproval(project: Project, first?: Milestone): string {
  const parts = [`The plan is approved and frozen as the baseline. If every invoice is paid on its due date, delivery lands on ${formatDate(project.schedule.deliveryDate)}.`];
  if (first) parts.push(`The first invoice, ${money(first.amountMinor, project)} for ${title(project, first.id)}, is ready for your approval. Nothing goes to PayPal until you approve it.`);
  return parts.join(' ');
}

/** After an approved invoice went out through PayPal. */
export function explainInvoiceSent(project: Project, invoice: Invoice, email: string): string {
  const held = downstreamOf(project.plan, invoice.milestoneId)[0];
  const parts = [`You approved it, so I created ${invoice.number} for ${money(invoice.amountMinor, project)} in PayPal and sent it to ${email}. It is due ${formatDate(invoice.dueDate)}.`];
  parts.push(held
    ? `${title(project, held)} stays locked until PayPal reports it paid; the plan will move by itself when the webhook arrives.`
    : 'The plan will update by itself when PayPal reports it paid.');
  return parts.join(' ');
}

export function explainReminderSent(invoice: Invoice, email: string): string {
  return `You approved it, so PayPal sent a reminder for ${invoice.number} to ${email}. I will keep the schedule current while it stays open, and prepare another reminder for your approval in a week if nothing changes.`;
}

export function explainCancelled(project: Project, invoice: Invoice): string {
  return `You approved it, so I cancelled ${invoice.number} in PayPal. ${title(project, invoice.milestoneId)} is back to "ready to invoice"; a fresh invoice proposal is waiting for you.`;
}

export function reminderTemplate(project: Project, invoice: Invoice): { subject: string; note: string } {
  const held = downstreamOf(project.plan, invoice.milestoneId)[0];
  const next = held ? ` Work on the next stage, ${title(project, held)}, starts as soon as it is settled.` : '';
  return {
    subject: `Reminder: invoice ${invoice.number} for ${project.plan.title}`,
    note: `Hi ${project.plan.client.name}, a quick reminder that invoice ${invoice.number} for ${money(invoice.amountMinor, project)} was due on ${formatDate(invoice.dueDate)} and is still open.${next} You can pay it from the link in the original invoice email. Thank you!`,
  };
}

export function cancelTemplate(project: Project, invoice: Invoice): { subject: string; note: string } {
  return {
    subject: `Invoice ${invoice.number} cancelled`,
    note: `Hi ${project.plan.client.name}, invoice ${invoice.number} for ${money(invoice.amountMinor, project)} has been cancelled. No payment is needed for it.`,
  };
}

export function issueRationale(project: Project, m: Milestone, dueOn: ISODate, reissue: boolean): string {
  const amount = money(m.amountMinor, project);
  if (reissue) return `The previous invoice for "${m.title}" was cancelled and the milestone has no open invoice. Re-issue ${amount}, due ${formatDate(dueOn)}?`;
  return m.durationDays === 0
    ? `"${m.title}" is billed up front. Create and send an invoice for ${amount}, due ${formatDate(dueOn)}. Work that depends on it stays locked until PayPal reports it paid.`
    : `"${m.title}" is delivered. Create and send its invoice for ${amount}, due ${formatDate(dueOn)}.`;
}

export function reminderRationale(project: Project, invoice: Invoice): string {
  const held = downstreamOf(project.plan, invoice.milestoneId)[0];
  return `${invoice.number} is ${days(invoice.daysOverdue)} overdue${held ? ` and is holding up ${title(project, held)}` : ''}. Send the client a reminder through PayPal.`;
}
