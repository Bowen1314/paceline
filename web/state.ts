/**
 * Client state: one reducer over the server's event stream. The same reducer
 * runs against the HTTP backend (SSE) and the in-browser mock.
 */
import type { ServerEvent, WorkspaceState } from '../shared/contract.ts';

const MAX_LOG = 300;
const MAX_RUNS = 20;

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/** Apply one event. Pure: never mutates `state`. Events before the first snapshot are dropped. */
export function applyEvent(state: WorkspaceState | null, e: ServerEvent): WorkspaceState | null {
  if (e.type === 'snapshot') return e.state;
  if (!state) return null;
  switch (e.type) {
    case 'info':
      return { ...state, info: e.info };
    case 'run':
      return { ...state, runs: upsert(state.runs, e.run).slice(-MAX_RUNS) };
    case 'project':
      return { ...state, projects: upsert(state.projects, e.project) };
    case 'project.removed':
      return { ...state, projects: state.projects.filter((p) => p.id !== e.projectId) };
    case 'invoice':
      return { ...state, invoices: upsert(state.invoices, e.invoice) };
    case 'proposal':
      return { ...state, proposals: upsert(state.proposals, e.proposal) };
    case 'log':
      return state.log.some((l) => l.id === e.entry.id) ? state : { ...state, log: [...state.log, e.entry].slice(-MAX_LOG) };
    case 'change':
      return { ...state, lastChange: e.change };
    default:
      return state;
  }
}

export type Connection = 'connecting' | 'open' | 'reconnecting';

export interface Store {
  get(): WorkspaceState | null;
  connection(): Connection;
  subscribe(fn: () => void): () => void;
  dispatch(e: ServerEvent): void;
  setConnection(c: Connection): void;
  /** Listen to raw events (used for one-shot effects such as the unlock animation). */
  onEvent(fn: (e: ServerEvent) => void): () => void;
}

export function createStore(): Store {
  let state: WorkspaceState | null = null;
  let conn: Connection = 'connecting';
  const subs = new Set<() => void>();
  const taps = new Set<(e: ServerEvent) => void>();
  const notify = (): void => { for (const fn of subs) fn(); };
  return {
    get: () => state,
    connection: () => conn,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    dispatch(e) {
      const next = applyEvent(state, e);
      const changed = next !== state;
      state = next;
      if (changed) notify();
      for (const fn of taps) fn(e);
    },
    setConnection(c) {
      if (c === conn) return;
      conn = c;
      notify();
    },
    onEvent(fn) {
      taps.add(fn);
      return () => taps.delete(fn);
    },
  };
}
