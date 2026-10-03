/** Review and edit a draft plan before approving it. The plan is validated by the same shared code the server uses. */
import { useMemo, useState, type ReactNode } from 'react';
import type { Backend, GateKind, Milestone, Plan, Project } from '../../shared/contract.ts';
import { CURRENCIES, LIMITS } from '../../shared/contract.ts';
import { formatDate } from '../../shared/dates.ts';
import { formatMoney, parseHumanAmount } from '../../shared/money.ts';
import { approvalBlockers, planTotal } from '../../shared/plan.ts';
import { Button, Modal, useAction } from '../ui.tsx';

const amountText = (minor: number): string => (minor / 100).toFixed(minor % 100 === 0 ? 0 : 2);

export function PlanEditor({ project, backend, today, onError, onClose }: { project: Project; backend: Backend; today: string; onError(m: string): void; onClose(): void }): ReactNode {
  const [plan, setPlan] = useState<Plan>(() => structuredClone(project.plan));
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(project.plan.milestones.map((m) => [m.id, amountText(m.amountMinor)])));
  const [busy, run] = useAction(onError);
  const dirty = useMemo(() => JSON.stringify(plan) !== JSON.stringify(project.plan), [plan, project.plan]);
  const blockers = useMemo(() => approvalBlockers(plan), [plan]);
  const originalTotal = planTotal(project.plan);
  const total = planTotal(plan);

  const patch = (id: string, change: Partial<Milestone>): void =>
    setPlan((p) => ({ ...p, milestones: p.milestones.map((m) => (m.id === id ? { ...m, ...change } : m)) }));
  const setGate = (id: string, gate: GateKind): void =>
    setPlan((p) => ({ ...p, milestones: p.milestones.map((m) => (m.id === id ? { ...m, dependsOn: m.dependsOn.map((d) => ({ ...d, gate })) } : m)) }));

  const save = async (): Promise<void> => {
    if (dirty) await backend.updatePlan(project.id, plan);
  };

  return (
    <Modal
      title={`Review plan · ${project.plan.title}`}
      onClose={onClose}
      footer={
        <>
          <span className="grow">
            {project.plannedBy === 'nebius' ? 'Proposed by the model; amounts and names were checked against your brief.' : 'Proposed by the built-in rule-based planner, not the model (see the note above).'}
            {' '}Approving creates no invoice yet — each one is proposed when it is due.
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await backend.discardProject(project.id); onClose(); })}>Discard</Button>
          <Button disabled={busy || !dirty || blockers.length > 0} onClick={() => run(save)}>Save changes</Button>
          <Button variant="primary" icon="check" busy={busy} disabled={blockers.length > 0}
            onClick={() => run(async () => { await save(); await backend.approvePlan(project.id); onClose(); })}>
            Approve plan
          </Button>
        </>
      }
    >
      <div className="field-row">
        <label className="field">Project<input value={plan.title} maxLength={120} onChange={(e) => setPlan({ ...plan, title: e.target.value })} /></label>
        <label className="field">Client<input value={plan.client.name} maxLength={120} onChange={(e) => setPlan({ ...plan, client: { ...plan.client, name: e.target.value } })} /></label>
        <label className="field">Client email<input type="email" value={plan.client.email} maxLength={254} placeholder="required to invoice" onChange={(e) => setPlan({ ...plan, client: { ...plan.client, email: e.target.value.trim() } })} /></label>
        <label className="field">Currency
          <select value={plan.currency} onChange={(e) => setPlan({ ...plan, currency: e.target.value as Plan['currency'] })}>
            {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="field">Start<input type="date" value={plan.startDate} min={today} onChange={(e) => e.target.value && setPlan({ ...plan, startDate: e.target.value })} /></label>
      </div>

      <table className="ms-table">
        <thead>
          <tr><th /><th>Milestone</th><th>Working days</th><th>Amount</th><th>Net days</th><th>Starts when</th></tr>
        </thead>
        <tbody>
          {plan.milestones.map((m, i) => (
            <tr key={m.id}>
              <td>{String(i + 1).padStart(2, '0')}</td>
              <td><input value={m.title} maxLength={120} aria-label={`Milestone ${i + 1} title`} onChange={(e) => patch(m.id, { title: e.target.value })} /></td>
              <td className="num" style={{ width: 110 }}><input type="number" min={0} max={LIMITS.maxDurationDays} value={m.durationDays} aria-label="Working days" onChange={(e) => patch(m.id, { durationDays: Math.max(0, Math.round(Number(e.target.value) || 0)) })} /></td>
              <td className="num" style={{ width: 130 }}>
                <input inputMode="decimal" value={amounts[m.id] ?? ''} aria-label="Amount"
                  onChange={(e) => {
                    setAmounts({ ...amounts, [m.id]: e.target.value });
                    const v = parseHumanAmount(e.target.value);
                    if (v !== null) patch(m.id, { amountMinor: v });
                  }} />
              </td>
              <td className="num" style={{ width: 90 }}><input type="number" min={0} max={LIMITS.maxNetDays} value={m.netDays} aria-label="Net days" onChange={(e) => patch(m.id, { netDays: Math.max(0, Math.round(Number(e.target.value) || 0)) })} /></td>
              <td style={{ width: 210 }}>
                {m.dependsOn.length === 0 ? <span style={{ padding: '0 8px', color: 'var(--text-3)' }}>On the start date</span> : (
                  <select value={m.dependsOn[0]!.gate} aria-label="Gate" onChange={(e) => setGate(m.id, e.target.value as GateKind)}>
                    <option value="paid">Previous invoice is paid</option>
                    <option value="delivered">Previous work is delivered</option>
                  </select>
                )}
              </td>
            </tr>
          ))}
          <tr className="ms-total">
            <td /><td>Total</td><td />
            <td className="num mono" style={{ textAlign: 'right', paddingRight: 12 }}>{formatMoney(total, plan.currency)}</td>
            <td /><td style={{ color: 'var(--text-3)', fontWeight: 400, paddingLeft: 12 }}>Delivery {formatDate(project.schedule.deliveryDate)}{dirty ? ' (before your edits)' : ''}</td>
          </tr>
        </tbody>
      </table>

      {total !== originalTotal ? <div className="notice">The total is now {formatMoney(total, plan.currency)}; the agent proposed {formatMoney(originalTotal, plan.currency)}. That is your call — the figure you approve is the figure that gets invoiced.</div> : null}
      {project.warnings.length > 0 ? (
        <div className="notice"><ul>{project.warnings.map((w) => <li key={w.code + (w.milestoneId ?? '')}>{w.message}</li>)}</ul></div>
      ) : null}
      {blockers.length > 0 ? (
        <div className="notice" data-tone="danger"><ul>{blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>
      ) : null}
    </Modal>
  );
}
