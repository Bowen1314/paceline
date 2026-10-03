import { useEffect, useState, type ReactNode } from 'react';
import type { AgentRun, Backend, ChangeSet, Project, Proposal, WorkspaceState } from '../../shared/contract.ts';
import { formatDate } from '../../shared/dates.ts';
import { formatMoney } from '../../shared/money.ts';
import { clockTime, relativeDay } from '../format.ts';
import { Button, Icon, useAction } from '../ui.tsx';

interface Props {
  state: WorkspaceState;
  backend: Backend;
  onError(message: string): void;
  onReviewDraft(projectId: string): void;
}

const KIND_ICON: Record<Proposal['kind'], string> = { issue_invoice: 'invoice', send_reminder: 'bell', cancel_invoice: 'ban' };
const APPROVE_LABEL: Record<Proposal['kind'], string> = { issue_invoice: 'Approve & send invoice', send_reminder: 'Approve & send reminder', cancel_invoice: 'Approve cancellation' };
const CALL_HINT: Record<string, string> = {
  create_invoice: 'POST /v2/invoicing/invoices',
  send_invoice: 'POST /v2/invoicing/invoices/{id}/send',
  send_invoice_reminder: 'POST /v2/invoicing/invoices/{id}/remind',
  cancel_sent_invoice: 'POST /v2/invoicing/invoices/{id}/cancel',
};

function ProposalCard({ p, state, backend, onError }: { p: Proposal; state: WorkspaceState; backend: Backend; onError(m: string): void }): ReactNode {
  const [busy, run] = useAction(onError);
  const editable = p.payload.kind !== 'issue_invoice';
  const [subject, setSubject] = useState(editable && 'subject' in p.payload ? p.payload.subject : '');
  const [note, setNote] = useState(editable && 'note' in p.payload ? p.payload.note : '');
  const [touched, setTouched] = useState(false);
  // The agent may swap its template for a model draft a moment later; follow it until the user edits.
  const serverSubject = 'subject' in p.payload ? p.payload.subject : '';
  const serverNote = 'note' in p.payload ? p.payload.note : '';
  useEffect(() => {
    if (!touched) {
      setSubject(serverSubject);
      setNote(serverNote);
    }
  }, [serverSubject, serverNote, touched]);

  const project = state.projects.find((x) => x.id === p.payload.projectId);
  const milestone = project?.plan.milestones.find((m) => m.id === p.payload.milestoneId);
  const sim = state.info.mode === 'simulator';

  return (
    <article className="proposal" data-kind={p.kind}>
      <div className="proposal-head">
        <span className="proposal-icon"><Icon name={KIND_ICON[p.kind]} /></span>
        <div>
          <div className="proposal-title">{p.title}</div>
          <div className="proposal-why">{p.rationale}</div>
        </div>
      </div>

      {p.payload.kind === 'issue_invoice' ? (
        <dl className="facts">
          <dt>Bill to</dt><dd title={p.payload.clientEmail}>{p.payload.clientName}</dd>
          <dt>Email</dt><dd className="mono" title={p.payload.clientEmail}>{p.payload.clientEmail}</dd>
          <dt>For</dt><dd title={p.payload.itemName}>{milestone?.title ?? p.payload.itemName}</dd>
          <dt>Amount</dt><dd className="mono"><b>{formatMoney(p.payload.amountMinor, p.payload.currency, { cents: true })}</b></dd>
          <dt>Issued / due</dt><dd className="mono">{formatDate(p.payload.invoiceDate)} → {formatDate(p.payload.dueDate)}</dd>
        </dl>
      ) : (
        <div className="draft">
          <input aria-label="Subject" value={subject} maxLength={200} onChange={(e) => { setTouched(true); setSubject(e.target.value); }} />
          <textarea aria-label="Message" value={note} maxLength={1200} onChange={(e) => { setTouched(true); setNote(e.target.value); }} />
          <span className="draft-by">
            To <span className="mono">{p.payload.clientEmail}</span> about <span className="mono">{p.payload.invoiceNumber}</span>
            {p.payload.kind === 'send_reminder' ? ` · drafted by ${p.payload.draftedBy === 'model' ? 'the model, figures verified' : 'template'}` : ''}
            {touched ? ' · edited by you' : ''}
          </span>
        </div>
      )}

      <div className="calls">
        {p.paypalCalls.map((c) => <div key={c}><b>{c}</b> · {CALL_HINT[c] ?? ''}</div>)}
        <div>{sim ? 'Simulated PayPal — no sandbox call will be made' : `→ ${state.info.paypalHost}`}</div>
      </div>

      {p.status === 'failed' && p.error ? <div className="proposal-error">PayPal did not accept this: {p.error}</div> : null}

      <div className="proposal-actions">
        <Button variant="primary" size="sm" icon="check" busy={busy || p.status === 'executing'}
          onClick={() => run(() => backend.approveProposal(p.id, editable && touched ? { subject, note } : {}))}>
          {p.status === 'failed' ? 'Approve & retry' : APPROVE_LABEL[p.kind]}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => backend.rejectProposal(p.id))}>Reject</Button>
        <span className="grow" />
      </div>
    </article>
  );
}

const CAUSE_TITLE: Record<ChangeSet['cause'], string> = {
  payment: 'Payment received', overdue: 'Invoice overdue', delivery: 'Milestone delivered', approval: 'Plan approved', clock: 'Schedule updated', cancel: 'Invoice cancelled',
};

function Latest({ run, change, project }: { run?: AgentRun; change?: ChangeSet; project?: Project }): ReactNode {
  if (!run) return null;
  const running = run.status === 'running';
  // Only the change this run itself caused: same project, same cause, made after the run began.
  const linked = change && run.projectId === change.projectId && run.kind === change.cause && change.at >= run.startedAt ? change : undefined;
  const title = (id: string): string => project?.plan.milestones.find((m) => m.id === id)?.title ?? id;
  return (
    <div className="explain" data-cause={run.kind} key={run.id}>
      <div className="explain-title">
        {running ? <span className="spinner" /> : <Icon name={run.status === 'error' ? 'x' : 'spark'} size={14} />}
        {run.title}
      </div>
      {run.message ? <p>{run.message}</p> : null}
      {run.error ? <p>{run.error}</p> : null}
      {running || run.status === 'error' || !run.message ? (
        <ul className="steps">
          {run.steps.map((s) => (
            <li key={s.id} data-status={s.status}>
              <span className="tick">{s.status === 'active' ? <span className="spinner" /> : s.status === 'done' ? <Icon name="check" size={12} /> : <Icon name="x" size={12} />}</span>
              {s.label}
            </li>
          ))}
        </ul>
      ) : null}
      {!running && linked ? (
        <div className="explain-meta">
          {linked.unlocked.map((id) => <span className="tag" data-tone="paid" key={id}><Icon name="unlock" size={11} />{title(id)} unblocked</span>)}
          {linked.deliveryDeltaDays !== 0 ? (
            <span className="tag" data-tone={linked.deliveryDeltaDays > 0 ? 'late' : 'paid'}>
              Delivery {formatDate(linked.deliveryFrom)} → {formatDate(linked.deliveryTo)} ({linked.deliveryDeltaDays > 0 ? '+' : ''}{linked.deliveryDeltaDays}d)
            </span>
          ) : <span className="tag">Delivery stays {formatDate(linked.deliveryTo)}</span>}
          {run.messageBy ? <span className="tag" title={run.messageBy === 'model' ? 'Written by the model; every figure was checked against PayPal and plan data before it was shown.' : 'Deterministic text built from PayPal and plan data.'}>{run.messageBy === 'model' ? 'Model · figures verified' : 'Template'}</span> : null}
        </div>
      ) : null}
      {!running && !linked && run.messageBy ? <div className="explain-meta"><span className="tag">{run.messageBy === 'model' ? 'Model · figures verified' : 'Template'}</span></div> : null}
    </div>
  );
}

export function AgentPanel({ state, backend, onError, onReviewDraft }: Props): ReactNode {
  const [busy, run] = useAction(onError);
  const pending = state.proposals.filter((p) => p.status === 'pending' || p.status === 'failed' || p.status === 'executing');
  const drafts = state.projects.filter((p) => p.status === 'draft');
  const latest = state.runs.at(-1);
  const today = state.info.today;

  const now = state.projects.filter((p) => p.status === 'active').flatMap((p) =>
    p.schedule.items.filter((s) => s.workState === 'in_progress' || s.workState === 'late').map((s) => ({ p, s, m: p.plan.milestones.find((m) => m.id === s.milestoneId)! })),
  ).filter((x) => x.m && x.m.durationDays > 0);

  const log = state.log.slice(-40).reverse();
  const count = pending.length + drafts.length;

  return (
    <aside className="agent" aria-label="Agent">
      <div className="agent-head">
        <Icon name="spark" />
        <span className="card-title">Agent</span>
        <span className="card-sub">{state.info.planner === 'nebius' ? `Nemotron via Nebius` : 'Scripted planner · no model key'}</span>
      </div>
      <div className="agent-scroll">
        {latest ? <div className="wide"><Latest run={latest} change={state.lastChange} project={state.projects.find((p) => p.id === latest.projectId)} /></div> : null}

        <section>
          <div className="section-head">
            <span className="eyebrow">Needs your approval</span>
            {count > 0 ? <span className="count">{count}</span> : null}
          </div>
          {drafts.map((d) => (
            <article className="proposal" key={d.id}>
              <div className="proposal-head">
                <span className="proposal-icon"><Icon name="flag" /></span>
                <div>
                  <div className="proposal-title">Draft plan: {d.plan.title}</div>
                  <div className="proposal-why">
                    {d.plan.milestones.length} milestones · {formatMoney(d.plan.milestones.reduce((s, m) => s + m.amountMinor, 0), d.plan.currency)} · delivery {formatDate(d.schedule.deliveryDate)}
                    {d.warnings.length ? ` · ${d.warnings.length} thing${d.warnings.length === 1 ? '' : 's'} to check` : ''}
                  </div>
                </div>
              </div>
              <div className="proposal-actions">
                <Button variant="primary" size="sm" icon="pencil" onClick={() => onReviewDraft(d.id)}>Review plan</Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => backend.discardProject(d.id))}>Discard</Button>
              </div>
            </article>
          ))}
          {pending.map((p) => <ProposalCard key={p.id} p={p} state={state} backend={backend} onError={onError} />)}
          {count === 0 ? (
            <div className="empty-note"><Icon name="check" />Nothing is waiting on you. The agent will ask before it sends, reminds or cancels anything.</div>
          ) : null}
        </section>

        {now.length > 0 ? (
          <section>
            <div className="section-head"><span className="eyebrow">In progress</span></div>
            {now.map(({ p, s, m }) => (
              <div className="now-item" key={`${p.id}:${m.id}`}>
                <div className="now-main">
                  <div className="now-title">{m.title}</div>
                  <div className="now-sub">{p.plan.client.name} · {s.workState === 'late' ? `was due ${formatDate(s.workEnd)}` : `ends ${formatDate(s.workEnd)} (${relativeDay(s.workEnd, today)})`}</div>
                </div>
                <Button size="sm" icon="flag" disabled={busy} onClick={() => run(() => backend.markDelivered(p.id, m.id))}>Mark delivered</Button>
              </div>
            ))}
          </section>
        ) : null}

        <section className="wide">
          <div className="section-head"><span className="eyebrow">Action log</span></div>
          {log.length === 0 ? <div className="empty-note"><Icon name="clock" />Every approval, PayPal call and webhook is recorded here with who did it.</div> : (
            <ul className="log">
              {log.map((l) => (
                <li key={l.id} data-actor={l.actor}>
                  <span className="log-who">{l.actor === 'paypal' ? 'PayPal' : l.actor}<small>{clockTime(l.at)}</small></span>
                  <span className="log-what">{l.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
