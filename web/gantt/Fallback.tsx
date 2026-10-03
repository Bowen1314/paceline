/** A plain timeline used while the Gantt chunk loads fails to load. Same model, no vendor code. */
import type { ReactNode } from 'react';
import { diffDays } from '../../shared/dates.ts';
import type { GanttModel, GanttRow } from './model.ts';

const TONE: Record<GanttRow['tone'], string> = {
  neutral: 'var(--bar-ghost)', accent: 'var(--bar-work)', paid: 'var(--paid)', late: 'var(--late)', outline: 'var(--bar-ghost)',
};

export function FallbackTimeline({ model }: { model: GanttModel }): ReactNode {
  const span = Math.max(1, diffDays(model.start, model.end));
  const pct = (d: string): number => (diffDays(model.start, d) / span) * 100;
  const flat = model.rows.flatMap((r) => [r, ...(r.children ?? [])]);
  return (
    <div className="tl" role="table" aria-label="Plan timeline">
      {flat.map((r) => (
        <div className="tl-row" data-kind={r.kind} key={r.id} role="row">
          <div className="tl-name" role="cell">{r.name}</div>
          <div className="tl-track" role="cell" title={`${r.status} · ${r.label}`}>
            <span className="tl-today" style={{ left: `${pct(model.today)}%` }} />
            <span className="tl-bar" style={{ left: `${pct(r.start)}%`, width: `${Math.max(0.6, pct(r.end) - pct(r.start))}%`, background: TONE[r.tone], opacity: r.kind === 'project' ? 0.35 : 1 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
