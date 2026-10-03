import type { Invoice, LedgerStatus, Project, WorkspaceState } from '../shared/contract.ts';
import { diffDays, formatDate } from '../shared/dates.ts';
import { buildLedgerRows } from '../shared/ledger.ts';
import { formatMoney } from '../shared/money.ts';

export const STATUS_LABEL: Record<LedgerStatus, string> = {
  planned: 'Planned', draft: 'Draft', awaiting: 'Awaiting', overdue: 'Overdue', paid: 'Paid', cancelled: 'Cancelled', refunded: 'Refunded',
};

export const STATUS_TONE: Record<LedgerStatus, 'outline' | 'neutral' | 'accent' | 'late' | 'paid' | 'danger'> = {
  planned: 'outline', draft: 'neutral', awaiting: 'accent', overdue: 'late', paid: 'paid', cancelled: 'neutral', refunded: 'danger',
};

export function relativeDay(date: string, today: string): string {
  const d = diffDays(today, date);
  if (d === 0) return 'today';
  if (d === 1) return 'tomorrow';
  if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface Kpis {
  currency: Project['plan']['currency'];
  collected: number;
  collectedCount: number;
  outstanding: number;
  outstandingCount: number;
  overdue: number;
  overdueCount: number;
  worstOverdueDays: number;
  planned: number;
  slipDays: number;
  slipProject?: string;
  nextDelivery?: { date: string; title: string };
  activeProjects: number;
}

/** Headline figures. Everything is a sum of PayPal-reported or plan-approved amounts. */
export function computeKpis(state: WorkspaceState): Kpis {
  const rows = buildLedgerRows(state.projects, state.invoices, state.info.today);
  const sum = (pick: (r: (typeof rows)[number]) => number, when: (r: (typeof rows)[number]) => boolean): number => rows.filter(when).reduce((s, r) => s + pick(r), 0);
  const active = state.projects.filter((p) => p.status === 'active');
  const worst = [...active].sort((a, b) => b.knockOnDays - a.knockOnDays)[0];
  const next = active.map((p) => ({ date: p.schedule.deliveryDate, title: p.plan.title })).sort((a, b) => a.date.localeCompare(b.date))[0];
  const overdueRows = rows.filter((r) => r.status === 'overdue');
  return {
    currency: state.projects[0]?.plan.currency ?? 'USD',
    collected: sum((r) => r.paidMinor, () => true),
    collectedCount: rows.filter((r) => r.status === 'paid').length,
    outstanding: sum((r) => r.balanceMinor, (r) => r.status === 'awaiting' || r.status === 'overdue'),
    outstandingCount: rows.filter((r) => r.status === 'awaiting' || r.status === 'overdue').length,
    overdue: overdueRows.reduce((s, r) => s + r.balanceMinor, 0),
    overdueCount: overdueRows.length,
    worstOverdueDays: Math.max(0, ...overdueRows.map((r) => r.daysPastDue ?? 0)),
    planned: sum((r) => r.amountMinor, (r) => r.status === 'planned'),
    slipDays: worst?.knockOnDays ?? 0,
    slipProject: worst && worst.knockOnDays > 0 ? worst.plan.title : undefined,
    nextDelivery: next,
    activeProjects: active.length,
  };
}

export function invoiceLine(i: Invoice): string {
  return `${i.number} · ${formatMoney(i.amountMinor, i.currency)} · due ${formatDate(i.dueDate)}`;
}

export { formatDate, formatMoney };
