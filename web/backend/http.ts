import type {
  ApiError, ApproveProposalRequest, Backend, LedgerQueryRequest, LedgerQueryResponse, Plan, Project, Proposal, ServerEvent,
  StartPlanRunResponse, WorkspaceState,
} from '../../shared/contract.ts';

export class ApiProblem extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details: string[] = []) {
    super(message);
    this.name = 'ApiProblem';
  }
}

/** Parse an SSE byte stream into events. Exported for tests. */
export function createSseParser(onEvent: (e: ServerEvent) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end < 0) return;
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue; // comments (keep-alive) and retry hints
      try {
        onEvent(JSON.parse(data) as ServerEvent);
      } catch {
        /* a torn frame is dropped; the next snapshot repairs the state */
      }
    }
  };
}

export class HttpBackend implements Backend {
  constructor(private readonly base = '') {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiProblem(0, 'offline', 'Could not reach the Paceline server. Check your connection and try again.');
    }
    const json = (await res.json().catch(() => null)) as (T & Partial<ApiError>) | null;
    if (!res.ok) {
      const err = json?.error;
      throw new ApiProblem(res.status, err?.code ?? 'http_error', err?.message ?? `The server answered ${res.status}.`, err?.details);
    }
    return json as T;
  }

  getState(): Promise<WorkspaceState> {
    return this.call('GET', '/api/state');
  }

  subscribe(onEvent: (e: ServerEvent) => void, onStatus?: (s: 'open' | 'reconnecting') => void): () => void {
    // EventSource reconnects by itself; the server sends a full snapshot on every (re)connect.
    const es = new EventSource(`${this.base}/api/events`);
    es.onopen = () => onStatus?.('open');
    es.onerror = () => onStatus?.('reconnecting');
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data as string) as ServerEvent);
      } catch {
        /* ignore a malformed frame */
      }
    };
    return () => es.close();
  }

  startPlanRun(brief: string): Promise<StartPlanRunResponse> {
    return this.call('POST', '/api/runs/plan', { brief });
  }
  updatePlan(projectId: string, plan: Plan): Promise<Project> {
    return this.call('PUT', `/api/projects/${projectId}/plan`, { plan });
  }
  approvePlan(projectId: string): Promise<Project> {
    return this.call('POST', `/api/projects/${projectId}/approve`);
  }
  async discardProject(projectId: string): Promise<void> {
    await this.call('DELETE', `/api/projects/${projectId}`);
  }
  markDelivered(projectId: string, milestoneId: string): Promise<Project> {
    return this.call('POST', `/api/projects/${projectId}/milestones/${milestoneId}/deliver`);
  }
  approveProposal(proposalId: string, edits: ApproveProposalRequest = {}): Promise<Proposal> {
    return this.call('POST', `/api/proposals/${proposalId}/approve`, edits);
  }
  rejectProposal(proposalId: string): Promise<Proposal> {
    return this.call('POST', `/api/proposals/${proposalId}/reject`);
  }
  requestCancel(invoiceId: string): Promise<Proposal> {
    return this.call('POST', `/api/invoices/${invoiceId}/cancel`);
  }
  ledgerQuery(req: LedgerQueryRequest): Promise<LedgerQueryResponse> {
    return this.call('POST', '/api/ledger/query', req);
  }
  async simPay(invoiceId: string): Promise<void> {
    await this.call('POST', '/api/sim/pay', { invoiceId });
  }
  async simAdvanceClock(days: number): Promise<void> {
    await this.call('POST', '/api/sim/clock', { days });
  }
  async simLoadSample(): Promise<void> {
    await this.call('POST', '/api/sim/sample');
  }
  async reset(): Promise<void> {
    await this.call('POST', '/api/reset');
  }
}
