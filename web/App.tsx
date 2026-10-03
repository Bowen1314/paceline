import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Backend, LedgerQueryResponse, WorkspaceState } from '../shared/contract.ts';
import { formatDate, formatWeekday } from '../shared/dates.ts';
import { buildLedgerRows } from '../shared/ledger.ts';
import { formatMoney } from '../shared/money.ts';
import { AgentPanel } from './components/AgentPanel.tsx';
import { ComposerModal, Hero } from './components/Composer.tsx';
import { PlanEditor } from './components/PlanEditor.tsx';
import { computeKpis } from './format.ts';
import { FallbackTimeline } from './gantt/Fallback.tsx';
import type { GanttApi } from './gantt/BryntumGantt.tsx';
import { buildGanttModel, workId } from './gantt/model.ts';
import type { LedgerHandle } from './ledger/Ledger.tsx';
import type { Store } from './state.ts';
import { Button, Icon, Modal, Skeleton, Toasts, useAction, type Toast } from './ui.tsx';

const GanttView = lazy(() => import('./gantt/BryntumGantt.tsx'));
const Ledger = lazy(() => import('./ledger/Ledger.tsx'));

type Theme = 'light' | 'dark';

export function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('paceline-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage may be unavailable */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const SIM_LABEL = 'Simulated PayPal — no sandbox calls made';
const QUERIES = ['overdue over $500', 'group by client', 'unpaid, largest first', 'paid this month'];

export function App({ backend, store }: { backend: Backend; store: Store }): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const conn = useSyncExternalStore(store.subscribe, store.connection);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [highlight, setHighlight] = useState<ReadonlySet<string>>(new Set());
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const [focusId, setFocusId] = useState<string | undefined>();
  const [kpiFlash, setKpiFlash] = useState(0);
  const toastId = useRef(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('paceline-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3500);
  }, []);
  const onError = useCallback((m: string) => toast(m, 'error'), [toast]);

  useEffect(() => backend.subscribe((e) => store.dispatch(e), (s) => store.setConnection(s)), [backend, store]);

  // One-shot effects driven by events rather than by state: the unlock animation, row flash, opening a fresh draft.
  useEffect(() => {
    const known = new Set<string>();
    let primed = false;
    return store.onEvent((e) => {
      if (e.type === 'snapshot') {
        known.clear();
        for (const p of e.state.projects) known.add(p.id);
        primed = true;
      } else if (e.type === 'project') {
        if (primed && !known.has(e.project.id) && e.project.status === 'draft' && e.project.origin === 'agent') setEditing(e.project.id);
        known.add(e.project.id);
      } else if (e.type === 'change') {
        const c = e.change;
        if (c.unlocked.length > 0) {
          setHighlight(new Set(c.unlocked.map((m) => `${c.projectId}:${m}`)));
          setFocusId(workId(c.projectId, c.unlocked[0]!));
          setTimeout(() => setHighlight(new Set()), 5200);
        }
        if (c.invoiceId && (c.cause === 'payment' || c.cause === 'overdue')) {
          setFlash(new Set([c.invoiceId]));
          setTimeout(() => setFlash(new Set()), 2600);
        }
        if (c.cause === 'payment') setKpiFlash((n) => n + 1);
      }
    });
  }, [store]);

  if (!state) {
    return (
      <div className="app">
        <header className="topbar"><Brand /></header>
        <div className="main"><div className="workarea"><div className="card plan-card"><div className="card-body"><Skeleton rows={8} /></div></div></div><aside className="agent" /></div>
        <footer className="footer"><span className="conn" data-state={conn}><i />{conn === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span></footer>
      </div>
    );
  }

  const sim = state.info.mode === 'simulator';
  const empty = state.projects.length === 0;
  const editingProject = editing ? state.projects.find((p) => p.id === editing && p.status === 'draft') : undefined;

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <span className="brand-tag">Milestone billing that keeps its own schedule</span>
        <span className="topbar-spacer" />
        <span className="mode-chip" data-mode={state.info.mode} title={sim ? 'Invoices live in an in-memory PayPal simulator. No request leaves this app.' : `Live calls to ${state.info.paypalHost}`}>
          <span className="dot" />
          {sim ? <>Simulated PayPal<span className="long"> — no sandbox calls made</span></> : 'PayPal sandbox'}
        </span>
        {sim ? <Clock state={state} backend={backend} onError={onError} /> : null}
        {!empty ? <Button variant="primary" icon="plus" onClick={() => setComposing(true)}>New brief</Button> : null}
        <Button variant="ghost" icon={theme === 'dark' ? 'sun' : 'moon'} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} title="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />
        {!empty ? <Button variant="ghost" icon="reset" aria-label="Reset workspace" title="Reset this workspace" onClick={() => setConfirmReset(true)} /> : null}
      </header>

      <div className="main">
        <main className="workarea">
          {empty ? <Hero backend={backend} state={state} onError={onError} /> : (
            <Dashboard state={state} backend={backend} onError={onError} toast={toast} highlight={highlight} flash={flash} focusId={focusId} kpiFlash={kpiFlash} onEdit={setEditing} />
          )}
        </main>
        <AgentPanel state={state} backend={backend} onError={onError} onReviewDraft={setEditing} />
      </div>

      <footer className="footer">
        <strong>Sandbox only</strong>
        <span>PayPal host is pinned to <span className="mono">{state.info.paypalHost}</span></span>
        <span className="sep" />
        <span>{sim ? SIM_LABEL : 'Live sandbox mode — invoices are real sandbox invoices'}</span>
        <span className="sep opt" />
        <span className="opt">{state.info.mock ? 'Mock mode: running in this browser, no backend' : `Planner: ${state.info.planner === 'nebius' ? state.info.plannerModel : 'scripted (no model key)'}`}</span>
        <span className="grow" />
        <span className="conn" data-state={conn}><i />{conn === 'open' ? 'Live' : 'Reconnecting…'}</span>
        <span className="mono opt">v{state.info.version}</span>
      </footer>

      {composing ? <ComposerModal backend={backend} state={state} onError={onError} onClose={() => setComposing(false)} /> : null}
      {editingProject ? <PlanEditor key={editingProject.id} project={editingProject} backend={backend} today={state.info.today} onError={onError} onClose={() => setEditing(null)} /> : null}
      {confirmReset ? (
        <Modal title="Reset this workspace?" narrow onClose={() => setConfirmReset(false)}
          footer={<><span className="grow" /><Button onClick={() => setConfirmReset(false)}>Keep it</Button><Button variant="primary" onClick={() => { setConfirmReset(false); backend.reset().catch((e: Error) => onError(e.message)); }}>Reset</Button></>}>
          <p style={{ color: 'var(--text-2)' }}>
            All projects, invoices{sim ? ' in the simulator' : ''}, approvals and the action log in this workspace are removed.
            {sim ? '' : ' Invoices already created in the PayPal sandbox are not deleted there.'}
          </p>
        </Modal>
      ) : null}
      <Toasts items={toasts} />
    </div>
  );
}

function Brand(): ReactNode {
  return <div className="brand"><span className="brand-mark"><Icon name="logo" size={16} /></span>Paceline</div>;
}

function Clock({ state, backend, onError }: { state: WorkspaceState; backend: Backend; onError(m: string): void }): ReactNode {
  const [busy, run] = useAction(onError);
  const t = state.info.today;
  return (
    <div className="clock" title="Simulator clock. Move time forward to see due dates pass.">
      <span className="clock-label">Today <b>{formatWeekday(t)} {formatDate(t)}</b>{state.info.clockOffsetDays > 0 ? ` · +${state.info.clockOffsetDays}d` : ''}</span>
      <button type="button" disabled={busy} onClick={() => run(() => backend.simAdvanceClock(1))}>+1 day</button>
      <button type="button" disabled={busy} onClick={() => run(() => backend.simAdvanceClock(7))}>+1 week</button>
    </div>
  );
}

interface DashProps {
  state: WorkspaceState;
  backend: Backend;
  onError(m: string): void;
  toast(text: string): void;
  highlight: ReadonlySet<string>;
  flash: ReadonlySet<string>;
  focusId?: string;
  kpiFlash: number;
  onEdit(projectId: string): void;
}

function Dashboard({ state, backend, onError, highlight, flash, focusId, kpiFlash, onEdit }: DashProps): ReactNode {
  const today = state.info.today;
  const model = useMemo(() => buildGanttModel(state.projects, state.invoices, today, highlight), [state.projects, state.invoices, today, highlight]);
  const rows = useMemo(() => buildLedgerRows(state.projects, state.invoices, today), [state.projects, state.invoices, today]);
  const k = useMemo(() => computeKpis(state), [state]);
  const forceFallback = useMemo(() => new URLSearchParams(location.search).get('gantt') === 'fallback', []);
  const ledger = useRef<LedgerHandle>(null);
  const ganttApi = useRef<GanttApi | null>(null);
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<LedgerQueryResponse | null>(null);
  const [asking, ask] = useAction(onError);
  const [view, setView] = useState({ shown: rows.length, total: rows.length, filtered: false, grouped: false, panel: false });
  const [paying, setPaying] = useState<string | undefined>();
  const sim = state.info.mode === 'simulator';
  const active = state.projects.filter((p) => p.status !== 'draft').length;

  const submit = (text: string): void => {
    const q = text.trim();
    if (!q) return;
    setQuery(q);
    ask(async () => {
      const res = await backend.ledgerQuery({ query: q });
      setAnswer(res);
      if (res.understood) ledger.current?.applyIntent(res.intent);
    });
  };
  const clear = (): void => {
    setQuery('');
    setAnswer(null);
    ledger.current?.clear();
  };

  const fallback = <FallbackTimeline model={model} />;

  return (
    <>
      <div className="kpis">
        <div className="kpi" data-tone={k.collected > 0 ? 'paid' : undefined} data-flash={kpiFlash > 0 ? '1' : '0'} key={`c${kpiFlash}`}>
          <div className="eyebrow">Collected</div>
          <div className="kpi-value">{formatMoney(k.collected, k.currency)}</div>
          <div className="kpi-note">{k.collectedCount} paid invoice{k.collectedCount === 1 ? '' : 's'} · {formatMoney(k.planned, k.currency)} still to bill</div>
        </div>
        <div className="kpi">
          <div className="eyebrow">Outstanding</div>
          <div className="kpi-value">{formatMoney(k.outstanding, k.currency)}</div>
          <div className="kpi-note">{k.outstandingCount === 0 ? 'No open invoices' : `${k.outstandingCount} open invoice${k.outstandingCount === 1 ? '' : 's'}`}</div>
        </div>
        <div className="kpi" data-tone={k.overdueCount > 0 ? 'late' : undefined}>
          <div className="eyebrow">Overdue</div>
          <div className="kpi-value">{formatMoney(k.overdue, k.currency)}</div>
          <div className="kpi-note">{k.overdueCount === 0 ? 'Nothing is late' : `${k.overdueCount} invoice${k.overdueCount === 1 ? '' : 's'} · up to ${k.worstOverdueDays} days late`}</div>
        </div>
        <div className="kpi" data-tone={k.slipDays > 0 ? 'late' : undefined}>
          <div className="eyebrow">Delivery</div>
          <div className="kpi-value">{k.activeProjects === 0 ? '—' : k.slipDays > 0 ? `+${k.slipDays} days` : 'On plan'}</div>
          <div className="kpi-note">{k.slipProject ? `${k.slipProject} is behind its approved plan` : k.nextDelivery ? `Next: ${k.nextDelivery.title} · ${formatDate(k.nextDelivery.date)}` : 'Approve a plan to start'}</div>
        </div>
      </div>

      <section className="card plan-card" aria-label="Plan">
        <div className="card-head">
          <span className="card-title">Plan</span>
          <span className="card-sub grow">{active} active project{active === 1 ? '' : 's'}{state.projects.length > active ? ` · ${state.projects.length - active} draft` : ''}</span>
          <div className="legend" aria-hidden="true">
            <span><i />Work</span>
            <span><i className="await" />Awaiting payment</span>
            <span><i className="paid" />Paid</span>
            <span><i className="late" />Late</span>
            <span className="opt"><i className="base" />Approved plan</span>
          </div>
          {forceFallback ? null : (
            <div className="zoom" role="group" aria-label="Timeline zoom">
              <Button variant="ghost" size="sm" icon="minus" title="Zoom out" aria-label="Zoom out" onClick={() => ganttApi.current?.zoom(-1)} />
              <Button variant="ghost" size="sm" title="Fit the whole plan" onClick={() => ganttApi.current?.fit()}>Fit</Button>
              <Button variant="ghost" size="sm" icon="plus" title="Zoom in" aria-label="Zoom in" onClick={() => ganttApi.current?.zoom(1)} />
            </div>
          )}
        </div>
        <div className="card-body">
          {forceFallback ? fallback : (
            <Boundary fallback={fallback}>
              <Suspense fallback={<Skeleton rows={7} />}>
                <GanttView model={model} api={ganttApi} focusId={focusId} onDeliver={(p, m) => { backend.markDelivered(p, m).catch((e: Error) => onError(e.message)); }} onOpenProject={onEdit} />
              </Suspense>
            </Boundary>
          )}
        </div>
      </section>

      {/* While the ledger is being questioned, grouped or configured it takes the larger share of the height. */}
      <section className="card ledger-card" aria-label="Ledger" data-focus={answer || view.grouped || view.panel ? '1' : '0'}>
        <div className="askbar">
          <span className="card-title">Ledger</span>
          <form className="ask" onSubmit={(e) => { e.preventDefault(); submit(query); }}>
            <Icon name="spark" size={14} />
            <input value={query} maxLength={200} placeholder="Ask the ledger: overdue over $500, group by client…" aria-label="Ask the ledger in plain language" onChange={(e) => setQuery(e.target.value)} />
            {asking ? <kbd><span className="spinner" /></kbd> : <kbd>↵</kbd>}
          </form>
          <div className="chips">
            {QUERIES.map((q) => <button type="button" className="chip" key={q} onClick={() => submit(q)}>{q}</button>)}
          </div>
          <Button variant="ghost" size="sm" icon="columns" title="Columns and filters" onClick={() => ledger.current?.toggleColumns()}>Columns</Button>
        </div>
        {answer ? (
          <div className="answer" data-ok={answer.understood ? '1' : '0'}>
            <Icon name={answer.understood ? 'spark' : 'x'} size={13} />
            <span className="grow">{answer.explanation}</span>
            <span className="by">{answer.by === 'model' ? 'model · validated against the ledger schema' : 'rule parser'} · {view.shown} of {view.total} rows</span>
            <Button variant="ghost" size="sm" onClick={clear}>Clear</Button>
          </div>
        ) : null}
        <div className="card-body">
          <Suspense fallback={<Skeleton rows={6} />}>
            <Ledger
              ref={ledger} rows={rows} currency={k.currency} simulator={sim} flash={flash} busyId={paying}
              onViewChanged={setView}
              onCancel={(id) => { backend.requestCancel(id).catch((e: Error) => onError(e.message)); }}
              onPay={(id) => {
                setPaying(id);
                backend.simPay(id).catch((e: Error) => onError(e.message)).finally(() => setPaying(undefined));
              }}
            />
          </Suspense>
        </div>
      </section>
    </>
  );
}
