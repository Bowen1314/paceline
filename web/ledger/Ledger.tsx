/**
 * The ledger: every invoice (and every milestone not yet invoiced) in one AG
 * Grid. Community features: Theming API (driven by Paceline's tokens), custom
 * cell renderers, custom overlays, filters, row animation. Enterprise features,
 * used where they earn their place: row grouping with aggregated totals
 * ("group by client"), the set filter for status, a grand-total row, and the
 * columns / filters tool panels.
 */
import {
  AllCommunityModule, ModuleRegistry, themeQuartz,
  type ColDef, type GetRowIdParams, type GridApi, type GridReadyEvent, type ICellRendererParams, type RowClassParams, type ValueFormatterParams,
} from 'ag-grid-community';
import {
  ColumnsToolPanelModule, FiltersToolPanelModule, LicenseManager, RowGroupingModule, RowGroupingPanelModule, SetFilterModule, SideBarModule,
} from 'ag-grid-enterprise';
import { AgGridReact } from 'ag-grid-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';
import type { CurrencyCode, LedgerIntent, LedgerRow, LedgerStatus } from '../../shared/contract.ts';
import { formatDate } from '../../shared/dates.ts';
import { formatMoney } from '../../shared/money.ts';
import { STATUS_LABEL, STATUS_TONE } from '../format.ts';
import { Icon } from '../ui.tsx';
import '../styles/ag-grid.css';
import { intentToGrid } from './intent.ts';

ModuleRegistry.registerModules([AllCommunityModule, RowGroupingModule, RowGroupingPanelModule, SetFilterModule, SideBarModule, ColumnsToolPanelModule, FiltersToolPanelModule]);

const meta = (name: string): string => {
  const v = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? '';
  return v.startsWith('__') ? '' : v;
};
const licenseKey = meta('paceline-ag-grid');
if (licenseKey) LicenseManager.setLicenseKey(licenseKey);
const styleNonce = meta('paceline-nonce') || undefined;

/* One theme for both modes: every colour is a Paceline token, so the grid follows data-theme by itself. */
const theme = themeQuartz.withParams({
  fontFamily: 'var(--font-ui)',
  fontSize: 13,
  backgroundColor: 'var(--surface)',
  foregroundColor: 'var(--text)',
  accentColor: 'var(--accent)',
  borderColor: 'var(--border)',
  headerBackgroundColor: 'var(--surface)',
  headerTextColor: 'var(--text-3)',
  headerFontSize: 11,
  headerFontWeight: 600,
  rowHoverColor: 'var(--surface-2)',
  oddRowBackgroundColor: 'var(--surface)',
  chromeBackgroundColor: 'var(--surface-2)',
  selectedRowBackgroundColor: 'var(--accent-soft)',
  rowHeight: 38,
  headerHeight: 36,
  spacing: 7,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowBorder: { color: 'var(--border)' },
  columnBorder: false,
  headerColumnResizeHandleColor: 'var(--border-strong)',
  cellHorizontalPadding: 12,
  iconSize: 14,
  menuBackgroundColor: 'var(--surface)',
  menuShadow: 'var(--shadow-2)',
  inputFocusBorder: { color: 'var(--accent)' },
});

export interface LedgerHandle {
  applyIntent(intent: LedgerIntent): void;
  clear(): void;
  toggleColumns(): void;
}

export interface LedgerProps {
  rows: LedgerRow[];
  currency: CurrencyCode;
  simulator: boolean;
  /** Row ids that just changed status (flash). */
  flash: ReadonlySet<string>;
  busyId?: string;
  onPay(invoiceId: string): void;
  onCancel(invoiceId: string): void;
  onViewChanged(summary: { shown: number; total: number; filtered: boolean; grouped: boolean; panel: boolean }): void;
}

interface Ctx {
  simulator: boolean;
  busyId?: string;
  onPay(id: string): void;
  onCancel(id: string): void;
}

function StatusCell(p: ICellRendererParams<LedgerRow, LedgerStatus>): ReactNode {
  if (!p.value) return null;
  const late = p.data?.status === 'overdue' && p.data.daysPastDue ? ` · ${p.data.daysPastDue}d` : '';
  return <span className="pill" data-tone={STATUS_TONE[p.value]}>{STATUS_LABEL[p.value]}{late}</span>;
}

function NumberCell(p: ICellRendererParams<LedgerRow, string>): ReactNode {
  if (!p.data) return p.value ?? null;
  return p.data.kind === 'planned' ? <span className="pl-dim">Not issued</span> : <span className="mono">{p.value}</span>;
}

function DueCell(p: ICellRendererParams<LedgerRow, string>): ReactNode {
  if (!p.value) return null;
  const d = p.data?.daysPastDue;
  const late = p.data?.status === 'overdue';
  const open = p.data && (p.data.status === 'awaiting' || p.data.status === 'overdue');
  return (
    <span className="pl-due">
      <span className="mono" data-late={late ? '1' : '0'}>{formatDate(p.value)}</span>
      {open && d !== undefined && d <= 0 ? <small>{d === 0 ? 'today' : `in ${-d}d`}</small> : null}
    </span>
  );
}

function ActionsCell(p: ICellRendererParams<LedgerRow> & { context: Ctx }): ReactNode {
  const r = p.data;
  if (!r || r.kind !== 'invoice' || !r.invoiceId) return null;
  const open = r.status === 'awaiting' || r.status === 'overdue';
  if (!open) return r.paymentId ? <span className="pl-dim mono" title="PayPal payment id">{r.paymentId}</span> : null;
  const id = r.invoiceId;
  const busy = p.context.busyId === id;
  return (
    <span className="pl-row-actions">
      {p.context.simulator ? (
        <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => p.context.onPay(id)} title="Simulator: the buyer pays this invoice. Paceline receives a signed INVOICING.INVOICE.PAID webhook.">
          {busy ? <span className="spinner" /> : null}Pay as buyer
        </button>
      ) : r.payerViewUrl ? (
        <a className="btn btn--sm" href={r.payerViewUrl} target="_blank" rel="noopener noreferrer" title="Open PayPal's payer page on sandbox.paypal.com and pay with the sandbox buyer account. The plan moves when PayPal's webhook arrives.">
          Open as buyer
        </a>
      ) : null}
      <button type="button" className="btn btn--sm btn--ghost btn--icon" aria-label="Cancel invoice" onClick={() => p.context.onCancel(id)} title="Cancel this invoice: the agent drafts the cancellation for your approval"><Icon name="ban" size={13} /></button>
    </span>
  );
}

function EmptyOverlay(): ReactNode {
  return (
    <div className="pl-overlay">
      <b>No invoices match</b>
      <span>Clear the request above, or approve a plan to see its milestones here.</span>
    </div>
  );
}

export const Ledger = forwardRef<LedgerHandle, LedgerProps>(function Ledger(props, ref): ReactNode {
  const api = useRef<GridApi<LedgerRow> | null>(null);
  const { currency } = props;

  const money = useMemo(() => (p: ValueFormatterParams<LedgerRow, number>): string => (p.value == null ? '' : formatMoney(Math.round(p.value * 100), p.data?.currency ?? currency, { cents: true })), [currency]);

  const columns = useMemo<ColDef<LedgerRow>[]>(() => {
    const amount = (colId: 'amountMinor' | 'paidMinor' | 'balanceMinor', headerName: string): ColDef<LedgerRow> => ({
      colId, headerName, type: 'rightAligned', minWidth: 94, flex: 0.9, hide: colId === 'paidMinor', cellClass: 'mono', filter: 'agNumberColumnFilter', aggFunc: 'sum',
      valueGetter: (p) => (p.data ? p.data[colId] / 100 : undefined), valueFormatter: money, enableCellChangeFlash: true,
    });
    return [
      { colId: 'number', field: 'number', headerName: 'Invoice', minWidth: 112, flex: 1, cellRenderer: NumberCell, filter: 'agTextColumnFilter' },
      { colId: 'client', field: 'client', headerName: 'Client', minWidth: 112, flex: 1.5, enableRowGroup: true, filter: 'agTextColumnFilter' },
      { colId: 'project', field: 'project', headerName: 'Project', minWidth: 130, flex: 1.2, enableRowGroup: true, filter: 'agTextColumnFilter', hide: true },
      { colId: 'milestone', field: 'milestone', headerName: 'Milestone', minWidth: 112, flex: 1.5, enableRowGroup: true, filter: 'agTextColumnFilter' },
      {
        colId: 'status', field: 'status', headerName: 'Status', minWidth: 112, flex: 0.9, enableRowGroup: true, cellRenderer: StatusCell, filter: 'agSetColumnFilter',
        filterParams: { valueFormatter: (p: { value: LedgerStatus | null }) => (p.value ? STATUS_LABEL[p.value] : '') }, enableCellChangeFlash: true,
      },
      amount('amountMinor', 'Amount'),
      amount('paidMinor', 'Paid'),
      amount('balanceMinor', 'Balance'),
      { colId: 'issuedOn', field: 'issuedOn', headerName: 'Issued', minWidth: 96, flex: 0.7, cellClass: 'mono', filter: 'agDateColumnFilter', cellDataType: 'dateString', valueFormatter: (p) => (p.value ? formatDate(p.value as string) : ''), hide: true },
      { colId: 'dueOn', field: 'dueOn', headerName: 'Due', minWidth: 108, flex: 0.9, cellRenderer: DueCell, filter: 'agDateColumnFilter', cellDataType: 'dateString', filterParams: { inRangeInclusive: true } },
      { colId: 'paidOn', field: 'paidOn', headerName: 'Paid on', minWidth: 96, flex: 0.7, cellClass: 'mono', filter: 'agDateColumnFilter', cellDataType: 'dateString', filterParams: { inRangeInclusive: true }, valueFormatter: (p) => (p.value ? formatDate(p.value as string) : ''), hide: true },
      { colId: 'daysPastDue', field: 'daysPastDue', headerName: 'Days past due', minWidth: 110, type: 'rightAligned', cellClass: 'mono', filter: 'agNumberColumnFilter', hide: true },
      { colId: 'actions', headerName: '', width: 142, pinned: 'right', lockPinned: true, sortable: false, filter: false, suppressHeaderMenuButton: true, cellRenderer: ActionsCell, suppressColumnsToolPanel: true, suppressFiltersToolPanel: true, resizable: false },
    ];
  }, [money]);

  const total = useRef(props.rows.length);
  total.current = props.rows.length;
  const report = (): void => {
    const g = api.current;
    if (!g) return;
    let shown = 0;
    g.forEachNodeAfterFilter((n) => { if (n.data) shown += 1; });
    props.onViewChanged({ shown, total: total.current, filtered: g.isAnyFilterPresent(), grouped: g.getRowGroupColumns().length > 0, panel: g.isSideBarVisible() && g.getOpenedToolPanel() !== null });
  };

  useImperativeHandle(ref, () => ({
    applyIntent(intent) {
      const g = api.current;
      if (!g) return;
      const { filterModel, columnState } = intentToGrid(intent);
      g.setFilterModel(filterModel);
      g.applyColumnState({ state: columnState, defaultState: { rowGroup: false, sort: null } });
      g.expandAll();
    },
    clear() {
      const g = api.current;
      if (!g) return;
      g.setFilterModel(null);
      g.applyColumnState({ defaultState: { rowGroup: false, sort: null } });
    },
    toggleColumns() {
      const g = api.current;
      if (!g) return;
      const open = g.isSideBarVisible() && g.getOpenedToolPanel() !== null;
      g.setSideBarVisible(!open);
      if (open) g.closeToolPanel();
      else g.openToolPanel('columns');
      report();
    },
  }), []);

  // "2d late" and the row actions depend on the row, not on the cell's own value, so redraw them when rows change.
  useEffect(() => {
    api.current?.refreshCells({ columns: ['status', 'dueOn', 'actions'], force: true, suppressFlash: true });
  }, [props.rows, props.busyId]);

  const context: Ctx = { simulator: props.simulator, busyId: props.busyId, onPay: props.onPay, onCancel: props.onCancel };
  const flash = props.flash;

  return (
    <div className="host pl-grid">
      <AgGridReact<LedgerRow>
        theme={theme}
        styleNonce={styleNonce}
        rowData={props.rows}
        columnDefs={columns}
        context={context}
        getRowId={(p: GetRowIdParams<LedgerRow>) => p.data.rowId}
        defaultColDef={{ sortable: true, resizable: true, filter: true, suppressHeaderFilterButton: true }}
        autoSizeStrategy={{ type: 'fitGridWidth' }}
        autoGroupColumnDef={{ headerName: 'Group', minWidth: 220, flex: 1.6, cellRendererParams: { suppressCount: false } }}
        groupDefaultExpanded={-1}
        grandTotalRow="bottom"
        rowGroupPanelShow="onlyWhenGrouping"
        suppressAggFuncInHeader
        animateRows
        suppressCellFocus
        cellFlashDuration={900}
        cellFadeDuration={700}
        tooltipShowDelay={400}
        sideBar={{ toolPanels: ['columns', 'filters'], hiddenByDefault: true, position: 'right' }}
        noRowsOverlayComponent={EmptyOverlay}
        rowClassRules={{
          'pl-row--planned': (p: RowClassParams<LedgerRow>) => p.data?.kind === 'planned',
          'pl-row--overdue': (p: RowClassParams<LedgerRow>) => p.data?.status === 'overdue',
          'pl-row--flash': (p: RowClassParams<LedgerRow>) => Boolean(p.data && flash.has(p.data.rowId)),
        }}
        onGridReady={(e: GridReadyEvent<LedgerRow>) => { api.current = e.api; report(); }}
        onFilterChanged={report}
        onColumnRowGroupChanged={report}
        onToolPanelVisibleChanged={report}
        onRowDataUpdated={report}
      />
    </div>
  );
});

export default Ledger;
