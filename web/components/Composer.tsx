import { useState, type ReactNode } from 'react';
import type { Backend, WorkspaceState } from '../../shared/contract.ts';
import { LIMITS } from '../../shared/contract.ts';
import { SAMPLE_BRIEFS } from '../../shared/sample.ts';
import { Button, Modal, useAction } from '../ui.tsx';

function Box({ backend, state, onError, onStarted, autoFocus }: { backend: Backend; state: WorkspaceState; onError(m: string): void; onStarted?: () => void; autoFocus?: boolean }): ReactNode {
  const [brief, setBrief] = useState('');
  const [busy, run] = useAction(onError);
  const planning = state.runs.some((r) => r.kind === 'plan' && r.status === 'running');
  const submit = (): void => {
    if (!brief.trim()) return;
    run(async () => {
      await backend.startPlanRun(brief);
      setBrief('');
      onStarted?.();
    });
  };
  return (
    <>
      <div className="composer">
        <textarea
          value={brief} autoFocus={autoFocus} maxLength={LIMITS.briefMaxChars} spellCheck={false}
          placeholder={'Paste a brief or statement of work.\n\nInclude the client, the total fee, any deposit, payment terms and the deliverables. The agent only uses figures that are written here.'}
          aria-label="Project brief"
          onChange={(e) => setBrief(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); }}
        />
        <div className="composer-bar">
          <span className="grow">{brief.length > 0 ? `${brief.length.toLocaleString('en-US')} / ${LIMITS.briefMaxChars.toLocaleString('en-US')} characters` : 'Nothing is sent to PayPal or to a client until you approve it.'}</span>
          <Button variant="primary" icon="spark" busy={busy || planning} disabled={!brief.trim()} onClick={submit}>{planning ? 'Planning…' : 'Propose a plan'}</Button>
        </div>
      </div>
      <div className="samples">
        Try a sample brief:
        {SAMPLE_BRIEFS.map((s) => <button type="button" className="chip" key={s.label} onClick={() => setBrief(s.text)}>{s.label}</button>)}
      </div>
    </>
  );
}

export function Hero({ backend, state, onError }: { backend: Backend; state: WorkspaceState; onError(m: string): void }): ReactNode {
  const [busy, run] = useAction(onError);
  const sim = state.info.mode === 'simulator';
  return (
    <div className="hero">
      <div className="hero-inner">
        <span className="eyebrow">Milestone billing for freelancers and small studios</span>
        <h1 style={{ marginTop: 10 }}>A project plan where <em>getting paid</em> is part of the schedule.</h1>
        <p className="hero-lede">Paste a brief. Paceline proposes milestones, bills each one through PayPal when you approve, and moves the plan by itself when a payment lands — or when one is late.</p>
        <Box backend={backend} state={state} onError={onError} />
        {sim ? (
          <div className="hero-or">
            <span className="grow">Or explore a workspace that is already in motion: one project with paid invoices, one with an overdue invoice.</span>
            <Button icon="play" busy={busy} onClick={() => run(() => backend.simLoadSample())}>Load sample workspace</Button>
          </div>
        ) : null}
        <div className="how">
          <div><span className="num">01</span><b>Plan</b>The agent turns the brief into milestones with amounts, dates and payment gates. Every figure is checked against your brief.</div>
          <div><span className="num">02</span><b>Approve</b>Invoices, reminders and cancellations are proposals. Nothing reaches PayPal or a client without your click.</div>
          <div><span className="num">03</span><b>Let it run</b>A PayPal payment unblocks the next milestone. A late one reschedules what follows and shows the new delivery date.</div>
        </div>
      </div>
    </div>
  );
}

export function ComposerModal({ backend, state, onError, onClose }: { backend: Backend; state: WorkspaceState; onError(m: string): void; onClose(): void }): ReactNode {
  return (
    <Modal title="New project from a brief" onClose={onClose} narrow>
      <Box backend={backend} state={state} onError={onError} onStarted={onClose} autoFocus />
    </Modal>
  );
}
