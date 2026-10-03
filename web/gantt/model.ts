/**
 * Projects -> Gantt rows. Pure, so it is unit-tested and shared by the
 * Bryntum adapter and the fallback timeline.
 *
 * Every milestone becomes up to two bars: its WORK and its INVOICE (issued ->
 * paid). The dependency lines are the plan's gates: work -> its invoice, and
 * invoice paid -> the next milestone's work. Dates always come from
 * `computeSchedule`; the chart never schedules anything itself.
 */
import type { Invoice, PayState, Project, WorkState } from '../../shared/contract.ts';
import { addDays, formatDate, maxDate, minDate } from '../../shared/dates.ts';
import { formatMoney } from '../../shared/money.ts';

export type RowKind = 'project' | 'work' | 'pay';

export interface GanttRow {
  id: string;
  kind: RowKind;
  projectId: string;
  milestoneId?: string;
  name: string;
  /** Inclusive first day. */
  start: string;
  /** Exclusive end day (the day after the last day), as Gantt charts expect. */
  end: string;
  state: WorkState | PayState | 'draft' | 'active' | 'completed';
  /** Short status text for the grid column. */
  status: string;
  tone: 'neutral' | 'accent' | 'paid' | 'late' | 'outline';
  amountMinor?: number;
  amountText?: string;
  /** Text drawn next to the bar. */
  label: string;
  baseline?: { start: string; end: string };
  draft: boolean;
  /** This milestone can be marked delivered right now. */
  canDeliver: boolean;
  highlighted: boolean;
  children?: GanttRow[];
}

export interface GanttLink {
  id: string;
  from: string;
  to: string;
  gate: 'invoice' | 'paid' | 'delivered';
  /** The gate is satisfied (paid / delivered). */
  met: boolean;
}

export interface GanttModel {
  rows: GanttRow[];
  links: GanttLink[];
  start: string;
  end: string;
  today: string;
}

const WORK_TEXT: Record<WorkState, [string, GanttRow['tone']]> = {
  blocked: ['Blocked', 'outline'],
  scheduled: ['Scheduled', 'neutral'],
  in_progress: ['In progress', 'accent'],
  late: ['Running late', 'late'],
  delivered: ['Delivered', 'paid'],
};

const PAY_TEXT: Record<PayState, [string, GanttRow['tone']]> = {
  planned: ['Planned', 'outline'],
  ready_to_invoice: ['To invoice', 'accent'],
  awaiting: ['Awaiting', 'accent'],
  overdue: ['Overdue', 'late'],
  paid: ['Paid', 'paid'],
};

export const workId = (projectId: string, milestoneId: string): string => `w:${projectId}:${milestoneId}`;
export const payId = (projectId: string, milestoneId: string): string => `i:${projectId}:${milestoneId}`;

export function buildGanttModel(projects: Project[], invoices: Invoice[], today: string, highlight: ReadonlySet<string> = new Set()): GanttModel {
  const rows: GanttRow[] = [];
  const links: GanttLink[] = [];
  let lo = today;
  let hi = today;

  for (const p of projects) {
    const draft = p.status === 'draft';
    const children: GanttRow[] = [];
    const hasWork = new Set(p.plan.milestones.filter((m) => m.durationDays > 0).map((m) => m.id));
    let pStart = p.schedule.items[0]?.workStart ?? today;
    let pEnd = pStart;

    for (const m of p.plan.milestones) {
      const s = p.schedule.items.find((x) => x.milestoneId === m.id);
      if (!s) continue;
      const base = p.baseline?.items.find((x) => x.milestoneId === m.id);
      const invoice = invoices.find((i) => i.id === p.progress[m.id]?.invoiceId);
      const amountText = formatMoney(m.amountMinor, p.plan.currency);
      const lit = highlight.has(`${p.id}:${m.id}`);

      if (hasWork.has(m.id)) {
        const [status, tone] = WORK_TEXT[s.workState];
        children.push({
          id: workId(p.id, m.id), kind: 'work', projectId: p.id, milestoneId: m.id, name: m.title,
          start: s.workStart, end: addDays(s.workEnd, 1), state: s.workState, status: draft ? 'Draft' : status, tone: draft ? 'outline' : tone,
          label: s.workState === 'delivered' ? `Delivered ${formatDate(p.progress[m.id]?.deliveredOn ?? s.workEnd)}` : `${m.durationDays}d · ends ${formatDate(s.workEnd)}`,
          baseline: base ? { start: base.workStart, end: addDays(base.workEnd, 1) } : undefined,
          draft, highlighted: lit,
          canDeliver: !draft && (s.workState === 'in_progress' || s.workState === 'late'),
        });
        links.push({ id: `l:${p.id}:${m.id}:inv`, from: workId(p.id, m.id), to: payId(p.id, m.id), gate: 'invoice', met: s.workState === 'delivered' });
      }

      const [payStatus, payTone] = PAY_TEXT[s.payState];
      const paidEnd = addDays(maxDate(s.paidOn, s.invoiceOn), 1);
      const label =
        s.payState === 'paid' ? `${amountText} paid ${formatDate(s.paidOn)}`
        : s.payState === 'overdue' ? `${amountText} was due ${formatDate(s.dueOn)}`
        : s.payState === 'awaiting' ? `${amountText} due ${formatDate(s.dueOn)}`
        : `${amountText} · due ${formatDate(s.dueOn)}`;
      children.push({
        id: payId(p.id, m.id), kind: 'pay', projectId: p.id, milestoneId: m.id,
        name: !hasWork.has(m.id) ? m.title : invoice ? invoice.number : 'Invoice',
        start: s.invoiceOn, end: paidEnd, state: s.payState, status: draft ? 'Draft' : payStatus, tone: draft ? 'outline' : payTone,
        amountMinor: m.amountMinor, amountText, label,
        baseline: base ? { start: base.invoiceOn, end: addDays(maxDate(base.paidOn, base.invoiceOn), 1) } : undefined,
        draft, highlighted: false, canDeliver: false,
      });

      for (const d of m.dependsOn) {
        const from = d.gate === 'paid' || !hasWork.has(d.on) ? payId(p.id, d.on) : workId(p.id, d.on);
        const to = hasWork.has(m.id) ? workId(p.id, m.id) : payId(p.id, m.id);
        const up = p.schedule.items.find((x) => x.milestoneId === d.on);
        const met = d.gate === 'paid' ? up?.payState === 'paid' : up?.workState === 'delivered';
        links.push({ id: `l:${p.id}:${d.on}:${m.id}`, from, to, gate: d.gate, met: Boolean(met) });
      }

      pStart = minDate(pStart, minDate(s.workStart, s.invoiceOn));
      pEnd = maxDate(pEnd, maxDate(addDays(s.workEnd, 1), paidEnd));
      if (base) pEnd = maxDate(pEnd, addDays(base.paidOn, 1));
    }

    const total = p.plan.milestones.reduce((sum, m) => sum + m.amountMinor, 0);
    const slip = p.knockOnDays;
    rows.push({
      id: `p:${p.id}`, kind: 'project', projectId: p.id, name: p.plan.title, start: pStart, end: pEnd, state: p.status,
      status: draft ? 'Draft plan' : p.status === 'completed' ? 'Completed' : slip > 0 ? `+${slip}d vs plan` : 'On plan',
      tone: draft ? 'outline' : p.status === 'completed' ? 'paid' : slip > 0 ? 'late' : 'neutral',
      amountMinor: total, amountText: formatMoney(total, p.plan.currency), label: `${p.plan.client.name} · delivery ${formatDate(p.schedule.deliveryDate)}`,
      draft, highlighted: false, canDeliver: false, children,
    });
    lo = minDate(lo, pStart);
    hi = maxDate(hi, pEnd);
  }

  return { rows, links, start: addDays(lo, -3), end: addDays(hi, 6), today };
}
