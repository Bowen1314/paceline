/**
 * A validated LedgerIntent -> AG Grid state. The model (or the rule parser)
 * never touches the grid: it produces a small typed intent, the server
 * validates it against a schema, and this function applies it through AG
 * Grid's public filter / column-state APIs. Pure, so it is unit-tested.
 */
import type { LedgerIntent } from '../../shared/contract.ts';

const NUMBER_OP = { gt: 'greaterThan', lt: 'lessThan', gte: 'greaterThanOrEqual', lte: 'lessThanOrEqual', eq: 'equals' } as const;

export interface GridInstruction {
  filterModel: Record<string, unknown>;
  columnState: { colId: string; rowGroup?: boolean; rowGroupIndex?: number; sort?: 'asc' | 'desc'; sortIndex?: number }[];
}

export function intentToGrid(intent: LedgerIntent): GridInstruction {
  const filterModel: Record<string, unknown> = {};
  for (const f of intent.filters) {
    switch (f.op) {
      case 'in':
        filterModel.status = { filterType: 'set', values: f.values };
        break;
      case 'contains':
        filterModel[f.column] = { filterType: 'text', type: 'contains', filter: f.value };
        break;
      case 'between':
        filterModel[f.column] = { filterType: 'date', type: 'inRange', dateFrom: f.from ?? null, dateTo: f.to ?? null };
        break;
      case 'before':
        filterModel[f.column] = { filterType: 'date', type: 'lessThan', dateFrom: f.to ?? f.from ?? null, dateTo: null };
        break;
      case 'after':
        filterModel[f.column] = { filterType: 'date', type: 'greaterThan', dateFrom: f.from ?? f.to ?? null, dateTo: null };
        break;
      default:
        // Money columns hold minor units in the data and display major units in the grid.
        filterModel[f.column] = { filterType: 'number', type: NUMBER_OP[f.op], filter: f.column === 'daysPastDue' ? f.value : f.value / 100 };
    }
  }
  const columnState: GridInstruction['columnState'] = [];
  intent.groupBy.forEach((colId, i) => columnState.push({ colId, rowGroup: true, rowGroupIndex: i }));
  intent.sort.forEach((s, i) => {
    const existing = columnState.find((c) => c.colId === s.column);
    if (existing) Object.assign(existing, { sort: s.dir, sortIndex: i });
    else columnState.push({ colId: s.column, sort: s.dir, sortIndex: i });
  });
  return { filterModel, columnState };
}
