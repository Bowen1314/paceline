/**
 * The plan as a Bryntum Gantt chart.
 *
 * Bryntum renders and navigates; it does not schedule. Every date comes from
 * Paceline's own `computeSchedule` (the tested pure functions), so tasks are
 * `manuallyScheduled` and the dependency lines show the plan's gates without a
 * second engine second-guessing them. Features used: tree columns, an action
 * column, dependencies, baselines (the plan as approved, so slippage is
 * visible), time ranges (the workspace's "today" and weekends), labels and a
 * custom tooltip.
 */
import { Gantt, StringHelper, type GanttConfig, type Model } from '@bryntum/gantt';
import '@bryntum/gantt/gantt.css';
import '@bryntum/gantt/svalbard-light.css';
import '@bryntum/gantt/fontawesome/css/fontawesome.css';
import '@bryntum/gantt/fontawesome/css/solid.css';
import '../styles/bryntum.css';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { addDays, diffDays, weekday } from '../../shared/dates.ts';
import type { GanttModel, GanttRow } from './model.ts';

/** What the card header's zoom buttons can ask of the chart. */
export interface GanttApi {
  zoom(direction: 1 | -1): void;
  fit(): void;
}

export interface GanttViewProps {
  model: GanttModel;
  api?: RefObject<GanttApi | null>;
  /** Row to bring into view (e.g. the milestone a payment just unlocked). */
  focusId?: string;
  onDeliver(projectId: string, milestoneId: string): void;
  onOpenProject(projectId: string): void;
}

type Rec = Model & Record<string, unknown>;
const field = (r: unknown, name: string): string => String((r as Rec).get(name) ?? '');

function toTask(r: GanttRow): Record<string, unknown> {
  const cls = [`pl-${r.kind}`, `pl-${r.kind}--${r.state}`, r.draft && 'pl-draft', r.highlighted && 'pl-unlocked'].filter(Boolean).join(' ');
  return {
    id: r.id, name: r.name, cls, expanded: true,
    ...(r.kind === 'project' ? {} : { startDate: r.start, endDate: r.end, manuallyScheduled: true }),
    // The approved plan is only drawn where the live schedule has moved away from it.
    baselines: r.baseline && (r.baseline.start !== r.start || r.baseline.end !== r.end) ? [{ startDate: r.baseline.start, endDate: r.baseline.end }] : [],
    plKind: r.kind, plStatus: r.status, plTone: r.tone, plAmount: r.amountText ?? '', plLabel: r.label, plCanDeliver: r.canDeliver,
    plProjectId: r.projectId, plMilestoneId: r.milestoneId ?? '', plState: r.state,
    children: r.children?.map(toTask),
  };
}

/** Room kept right of the last bar for its label, in pixels. */
const LABEL_ROOM = 150;
const MIN_PX_PER_DAY = 5;
const MAX_PX_PER_DAY = 34;
const NARROW_BELOW = 960;
const day = (d: string): Date => new Date(`${d}T00:00:00`);

/**
 * Scale the time axis so the whole plan fits the visible width (times the
 * user's zoom factor). Below a legible minimum the chart scrolls instead.
 */
function applyScale(g: Gantt, model: GanttModel, zoom: number, hostWidth: number): void {
  const narrow = hostWidth < NARROW_BELOW;
  const lockedWidth = narrow ? 340 : 420;
  const amount = (g.columns as unknown as { getById(id: string): { hidden: boolean } | null }).getById('amount');
  if (amount && amount.hidden !== narrow) amount.hidden = narrow;
  const locked = g.subGrids.locked as unknown as { width: number };
  if (locked.width !== lockedWidth) locked.width = lockedWidth;

  const span = Math.max(14, diffDays(model.start, model.end));
  const room = Math.max(160, hostWidth - lockedWidth - LABEL_ROOM - 24);
  const pxPerDay = Math.min(MAX_PX_PER_DAY, Math.max(MIN_PX_PER_DAY, (room / span) * zoom));
  const weekTick = Math.round(pxPerDay * 7);
  const preset: Record<string, unknown> = pxPerDay >= 22
    ? { base: 'weekAndDayLetter', tickWidth: Math.round(pxPerDay) }
    : {
        base: 'weekAndMonth', tickWidth: weekTick,
        headers: [
          { unit: 'month', dateFormat: 'MMM YYYY' },
          { unit: 'week', dateFormat: weekTick < 46 ? 'D' : 'MMM D' },
        ],
      };
  g.viewPreset = preset as never;
  g.setTimeSpan(day(model.start), day(addDays(model.end, Math.ceil(LABEL_ROOM / pxPerDay))));
  void g.scrollToDate(day(addDays(model.start, 0)), { block: 'start' });
}

function timeRanges(model: GanttModel): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ id: 'today', name: 'Today', startDate: model.today, cls: 'pl-today' }];
  for (let d = model.start; d < addDays(model.end, 60); d = addDays(d, 1)) {
    if (weekday(d) === 6) out.push({ id: `wk-${d}`, startDate: d, endDate: addDays(d, 2), cls: 'pl-weekend' });
  }
  return out;
}

export default function BryntumGanttView({ model, api, focusId, onDeliver, onOpenProject }: GanttViewProps): ReactNode {
  const host = useRef<HTMLDivElement>(null);
  const gantt = useRef<Gantt | null>(null);
  const handlers = useRef({ onDeliver, onOpenProject });
  handlers.current = { onDeliver, onOpenProject };
  const fitted = useRef('');
  const zoom = useRef(1);
  const latest = useRef(model);
  latest.current = model;

  useEffect(() => {
    const config: Partial<GanttConfig> = {
      appendTo: host.current!,
      readOnly: true,
      rowHeight: 36,
      barMargin: 10,
      viewPreset: 'weekAndMonth',
      weekStartDay: 1,
      enableUndoRedoKeys: false,
      project: { autoSetConstraints: false },
      subGridConfigs: { locked: { width: 420 } },
      columns: [
        {
          type: 'name', field: 'name', text: 'Milestone', width: 190,
          renderer: ({ record, value }: { record: unknown; value: unknown }) => ({
            tag: 'span', className: `pl-name pl-name--${field(record, 'plKind')}`, text: String(value ?? ''),
          }),
        },
        { id: 'amount', field: 'plAmount', text: 'Amount', width: 80, align: 'end', cellCls: 'pl-mono', htmlEncode: true },
        {
          field: 'plStatus', text: 'Status', width: 116,
          renderer: ({ record }: { record: unknown }) => ({ tag: 'span', className: 'pill', dataset: { tone: field(record, 'plTone') }, text: field(record, 'plStatus') }),
        },
        {
          type: 'action', width: 34, align: 'center', cellCls: 'pl-actions',
          actions: [
            {
              cls: 'fa fa-flag-checkered', tooltip: 'Mark this milestone delivered',
              visible: ({ record }: { record: unknown }) => (record as Rec).get('plCanDeliver') === true,
              onClick: ({ record }: { record: unknown }) => handlers.current.onDeliver(field(record, 'plProjectId'), field(record, 'plMilestoneId')),
            },
            {
              cls: 'fa fa-pen', tooltip: 'Review this draft plan',
              visible: ({ record }: { record: unknown }) => field(record, 'plKind') === 'project' && field(record, 'plState') === 'draft',
              onClick: ({ record }: { record: unknown }) => handlers.current.onOpenProject(field(record, 'plProjectId')),
            },
          ],
        },
      ],
      features: {
        baselines: { disabled: false },
        dependencies: { radius: 6 },
        timeRanges: { showCurrentTimeLine: false, showHeaderElements: true, enableResizing: false },
        // Label renderers return HTML: encode, even though labels are built from figures, not free text.
        labels: { after: { renderer: ({ taskRecord }: { taskRecord: unknown }) => (field(taskRecord, 'plKind') === 'project' ? '' : StringHelper.encodeHtml(field(taskRecord, 'plLabel'))) } },
        taskTooltip: {
          template: ({ taskRecord }: { taskRecord: unknown }) => {
            const e = (s: string): string => StringHelper.encodeHtml(s);
            const amount = field(taskRecord, 'plAmount');
            return `<div class="pl-tip"><b>${e(field(taskRecord, 'name'))}</b><span>${e(field(taskRecord, 'plStatus'))}${amount && field(taskRecord, 'plKind') !== 'work' ? ` · ${e(amount)}` : ''}</span><span>${e(field(taskRecord, 'plLabel'))}</span></div>`;
          },
        },
        projectLines: false, taskMenu: false, cellMenu: false, headerMenu: false, timeAxisHeaderMenu: false, scheduleMenu: false,
        cellEdit: false, taskEdit: false, taskDrag: false, taskResize: false, taskDragCreate: false, dependencyEdit: false,
        percentBar: false, sort: false, rollups: false, columnLines: false, group: false, filter: false,
      },
    } as Partial<GanttConfig>;
    const g = new Gantt(config);
    gantt.current = g;
    const rescale = (): void => {
      if (gantt.current === g && host.current) applyScale(g, latest.current, zoom.current, host.current.clientWidth);
    };
    if (api) {
      api.current = {
        zoom: (direction) => {
          zoom.current = Math.min(8, Math.max(1, zoom.current * (direction > 0 ? 1.5 : 1 / 1.5)));
          rescale();
        },
        fit: () => {
          zoom.current = 1;
          rescale();
        },
      };
    }
    // Keep the plan fitted when the layout changes width (window resize, breakpoints).
    let width = host.current!.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      const next = host.current?.clientWidth ?? width;
      if (Math.abs(next - width) < 8) return;
      width = next;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(rescale);
    });
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      if (api) api.current = null;
      gantt.current = null;
      g.destroy();
    };
  }, [api]);

  useEffect(() => {
    const g = gantt.current;
    if (!g) return;
    let cancelled = false;
    void g.project
      .loadInlineData({
        tasks: model.rows.map(toTask),
        dependencies: model.links.map((l) => ({ id: l.id, fromTask: l.from, toTask: l.to, type: 2, cls: `pl-dep pl-dep--${l.gate}${l.met ? ' pl-dep--met' : ''}` })),
      })
      .then(() => {
        if (cancelled || gantt.current !== g) return;
        g.project.timeRangeStore.data = timeRanges(model);
        // Re-fit only when the set of projects or the window changes, not on every status update.
        const key = `${model.rows.map((r) => r.id).join(',')}|${model.start}|${model.end}`;
        if (key !== fitted.current) {
          fitted.current = key;
          if (host.current) applyScale(g, model, zoom.current, host.current.clientWidth);
        }
      });
    return () => { cancelled = true; };
  }, [model]);

  useEffect(() => {
    const g = gantt.current;
    if (!g || !focusId) return;
    const t = setTimeout(() => {
      const task = g.taskStore.getById(focusId);
      if (task) void g.scrollTaskIntoView(task as never, { animate: true, block: 'center', edgeOffset: 80 } as never);
    }, 250);
    return () => clearTimeout(t);
  }, [focusId]);

  return <div className="host pl-gantt" ref={host} />;
}
