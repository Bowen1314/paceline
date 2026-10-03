/**
 * The server end to end over real HTTP on an ephemeral port: simulator mode,
 * scripted planner, a temporary data directory.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../server/config.ts';
import { SESSION_COOKIE, contentSecurityPolicy, createApp } from '../server/http.ts';
import { RateLimiter, Semaphore } from '../server/rateLimit.ts';
import { Store } from '../server/store.ts';
import { WorkspaceManager } from '../server/workspaces.ts';
import type { ServerEvent, WorkspaceState } from '../shared/contract.ts';
import type { PayPalGateway } from '../shared/paypal/gateway.ts';
import { PayPalSimulator, newSimulatorState } from '../shared/paypal/simulator.ts';
import { ScriptedPlanner } from '../shared/planner/scripted.ts';
import { BRIEF } from './helpers.ts';

interface Booted {
  url: string;
  dir: string;
  manager: WorkspaceManager;
  store: Store;
  server: Server;
  close(): Promise<void>;
}

const open: Booted[] = [];

async function boot(opts: { env?: Record<string, string>; sandbox?: PayPalGateway; staticRoot?: string; dir?: string } = {}): Promise<Booted> {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'paceline-test-'));
  const config: Config = loadConfig({ PACELINE_DATA_DIR: dir, ...opts.env });
  const store = new Store(dir, 5);
  const models = new Semaphore(config.limits.maxAgentRuns);
  const planner = new ScriptedPlanner();
  const manager = new WorkspaceManager(config, store, planner, models, opts.sandbox);
  const app = createApp({ config, manager, store, models, planner, limiter: new RateLimiter(), staticRoot: opts.staticRoot });
  const server = createServer(app.handle);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const b: Booted = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, dir, manager, store, server,
    close: async () => {
      app.close();
      manager.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  open.push(b);
  return b;
}

afterEach(async () => {
  for (const b of open.splice(0)) {
    await b.close();
    rmSync(b.dir, { recursive: true, force: true });
  }
});

/** A visitor: a cookie jar around fetch. */
class Visitor {
  cookie = '';
  constructor(private readonly base: string) {}

  async raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return res;
  }

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const json = (await res.json()) as T;
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json)}`), { status: res.status, body: json });
    return json;
  }

  state(): Promise<WorkspaceState> {
    return this.call('GET', '/api/state');
  }

  async until(pred: (s: WorkspaceState) => boolean, what: string): Promise<WorkspaceState> {
    for (let i = 0; i < 200; i++) {
      const s = await this.state();
      if (pred(s)) return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Plan from the brief, approve the plan, return the first pending invoice proposal. */
  async planAndApprove(): Promise<{ projectId: string; proposalId: string }> {
    await this.call('POST', '/api/runs/plan', { brief: BRIEF });
    const drafted = await this.until((s) => s.projects.length === 1 && s.runs.every((r) => r.status !== 'running'), 'draft plan');
    const projectId = drafted.projects[0]!.id;
    await this.call('POST', `/api/projects/${projectId}/approve`);
    const s = await this.until((x) => x.proposals.some((p) => p.status === 'pending'), 'invoice proposal');
    return { projectId, proposalId: s.proposals.find((p) => p.status === 'pending')!.id };
  }
}

const status = async (p: Promise<unknown>): Promise<number> => p.then(() => 200, (e: { status?: number }) => e.status ?? -1);

describe('http: basics', () => {
  it('/healthz reports mode and the pinned PayPal host without a session', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toMatchObject({ ok: true, mode: 'simulator', paypalHost: 'api-m.sandbox.paypal.com', planner: 'scripted' });
  });

  it('issues an HttpOnly SameSite session cookie and an empty simulator workspace', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/api/state`);
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[a-f0-9]{32}; Path=/; HttpOnly; SameSite=Lax`));
    const state = (await res.json()) as WorkspaceState;
    expect(state.info).toMatchObject({ mode: 'simulator', paypalHost: 'api-m.sandbox.paypal.com', planner: 'scripted', mock: false });
    expect(state.projects).toEqual([]);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('ignores a malformed session cookie instead of using it as a file name', async () => {
    const b = await boot();
    const res = await fetch(`${b.url}/api/state`, { headers: { cookie: `${SESSION_COOKIE}=../../etc/passwd` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^paceline_sid=[a-f0-9]{32};/);
  });

  it('rejects cross-origin writes, non-JSON bodies, bad JSON and oversized bodies', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    await v.state();
    expect((await v.raw('POST', '/api/runs/plan', { brief: BRIEF }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await v.raw('POST', '/api/runs/plan', 'brief=x', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await v.raw('POST', '/api/runs/plan', '{nope')).status).toBe(400);
    expect((await v.raw('POST', '/api/runs/plan', { brief: 'x'.repeat(40_000) })).status).toBe(413);
    expect((await v.raw('GET', '/api/nope')).status).toBe(404);
    expect((await v.raw('DELETE', '/api/state')).status).toBe(405);
    expect((await v.state()).projects).toEqual([]);
  });

  it('rate-limits agent runs per IP with a Retry-After', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    const codes: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 9; i++) {
      const res = await v.raw('POST', '/api/runs/plan', { brief: '' });
      codes.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get('retry-after');
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(3);
    expect(codes.slice(0, 6).every((c) => c !== 429)).toBe(true);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});

describe('http: the workflow', () => {
  it('plan -> approve -> invoice only after approval -> simulated payment unblocks the next milestone', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    const { projectId, proposalId } = await v.planAndApprove();

    // The agent has proposed an invoice. Nothing has been created in PayPal yet.
    let s = await v.state();
    expect(s.invoices).toEqual([]);
    expect(s.proposals.find((p) => p.id === proposalId)).toMatchObject({ kind: 'issue_invoice', status: 'pending', proposedBy: 'agent' });
    expect(s.projects[0]!.schedule.items.find((i) => i.milestoneId === 'm2')!.workState).toBe('blocked');

    const approved = await v.call('POST', `/api/proposals/${proposalId}/approve`, {});
    expect(approved).toMatchObject({ status: 'executed', decidedBy: 'user' });
    s = await v.state();
    expect(s.invoices).toHaveLength(1);
    const invoice = s.invoices[0]!;
    expect(invoice).toMatchObject({ status: 'SENT', projectId, milestoneId: 'm1', amountMinor: 300000, source: 'simulator' });
    expect(invoice.id).toMatch(/^INV2-SIM0-/);

    expect(await v.call('POST', '/api/sim/pay', { invoiceId: invoice.id })).toEqual({ outcome: 'applied' });
    s = await v.until((x) => x.runs.every((r) => r.status !== 'running'), 'payment run to finish');
    expect(s.invoices[0]).toMatchObject({ status: 'PAID', dueAmountMinor: 0 });
    expect(s.projects[0]!.schedule.items.find((i) => i.milestoneId === 'm2')!.workState).not.toBe('blocked');
    expect(s.lastChange).toMatchObject({ cause: 'payment', unlocked: ['m2'] });
    expect(s.runs.find((r) => r.kind === 'payment')?.message).toBeTruthy();

    // The action log shows who approved what.
    const approvals = s.log.filter((l) => l.actor === 'user').map((l) => l.action);
    expect(approvals).toEqual(expect.arrayContaining(['plan.approved', 'proposal.approved']));
    expect(s.log.some((l) => l.actor === 'paypal')).toBe(true);
  });

  it('visitors are isolated: no shared state, no acting on each other\'s proposals or invoices', async () => {
    const b = await boot();
    const alice = new Visitor(b.url);
    const bob = new Visitor(b.url);
    const { projectId, proposalId } = await alice.planAndApprove();
    expect((await bob.state()).projects).toEqual([]);
    expect(await status(bob.call('POST', `/api/proposals/${proposalId}/approve`, {}))).toBe(404);
    expect(await status(bob.call('POST', `/api/projects/${projectId}/approve`))).toBe(404);
    expect(await status(bob.call('DELETE', `/api/projects/${projectId}`))).toBe(404);

    await alice.call('POST', `/api/proposals/${proposalId}/approve`, {});
    const invoiceId = (await alice.state()).invoices[0]!.id;
    expect(await status(bob.call('POST', '/api/sim/pay', { invoiceId }))).toBe(404);
    expect(await status(bob.call('POST', `/api/invoices/${invoiceId}/cancel`))).toBe(404);
    expect((await alice.state()).invoices[0]!.status).toBe('SENT');
    expect((await bob.state()).invoices).toEqual([]);

    // Bob's own clock does not move Alice's.
    await bob.call('POST', '/api/sim/clock', { days: 20 });
    expect((await alice.state()).info.clockOffsetDays).toBe(0);
    expect((await bob.state()).info.clockOffsetDays).toBe(20);
  });

  it('a rejected proposal creates nothing; reset wipes the workspace', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    const { proposalId } = await v.planAndApprove();
    expect(await v.call('POST', `/api/proposals/${proposalId}/reject`)).toMatchObject({ status: 'rejected', decidedBy: 'user' });
    expect((await v.state()).invoices).toEqual([]);
    await v.call('POST', '/api/reset');
    const s = await v.state();
    expect(s.projects).toEqual([]);
    expect(s.proposals).toEqual([]);
    expect(s.log).toEqual([]);
  });

  it('answers a plain-language ledger request with a typed intent', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    const r = await v.call('POST', '/api/ledger/query', { query: 'overdue over $500, group by client' });
    expect(r).toMatchObject({ by: 'rules', understood: true });
    expect(r.intent.groupBy).toEqual(['client']);
    expect(r.intent.filters).toEqual(expect.arrayContaining([{ column: 'status', op: 'in', values: ['overdue'] }, { column: 'amountMinor', op: 'gt', value: 50000 }]));
    expect(await status(v.call('POST', '/api/ledger/query', { query: '' }))).toBe(400);
  });

  it('loads the sample workspace through the real engine and webhook path', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    await v.call('POST', '/api/sim/sample');
    const s = await v.state();
    expect(s.projects).toHaveLength(2);
    expect(s.invoices.filter((i) => i.status === 'PAID')).toHaveLength(2);
    expect(s.invoices.some((i) => i.overdue)).toBe(true);
    expect(s.proposals.some((p) => p.kind === 'send_reminder' && p.status === 'pending')).toBe(true);
    expect(await status(v.call('POST', '/api/sim/sample'))).toBe(409);
  });

  it('persists a workspace across a restart', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    const { proposalId } = await v.planAndApprove();
    await v.call('POST', `/api/proposals/${proposalId}/approve`, {});
    const before = await v.state();
    await b.close();
    open.splice(open.indexOf(b), 1);

    const again = await boot({ dir: b.dir });
    const v2 = new Visitor(again.url);
    v2.cookie = v.cookie;
    const after = await v2.state();
    expect(after.projects[0]!.id).toBe(before.projects[0]!.id);
    expect(after.invoices).toEqual(before.invoices);
    // The simulator state came back too: the invoice can still be paid.
    expect(await v2.call('POST', '/api/sim/pay', { invoiceId: after.invoices[0]!.id })).toEqual({ outcome: 'applied' });
  });
});

describe('http: webhook endpoint', () => {
  async function sentInvoice(): Promise<{ b: Booted; v: Visitor; invoiceId: string; sid: string }> {
    const b = await boot();
    const v = new Visitor(b.url);
    const { proposalId } = await v.planAndApprove();
    await v.call('POST', `/api/proposals/${proposalId}/approve`, {});
    return { b, v, invoiceId: (await v.state()).invoices[0]!.id, sid: v.cookie.split('=')[1]! };
  }
  const post = (b: Booted, headers: Record<string, string>, body: string): Promise<Response> =>
    fetch(`${b.url}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('applies a correctly signed delivery once; a redelivery is acknowledged as a duplicate', async () => {
    const { b, v, invoiceId, sid } = await sentInvoice();
    const signed = await b.manager.get(sid).simulatePayment(invoiceId);
    const headers = Object.fromEntries(Object.entries(signed.headers).filter((e): e is [string, string] => typeof e[1] === 'string'));

    const first = await post(b, headers, signed.rawBody);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ outcome: 'applied' });
    const s = await v.until((x) => x.invoices[0]!.status === 'PAID' && x.runs.every((r) => r.status !== 'running'), 'paid');
    const runs = s.runs.filter((r) => r.kind === 'payment').length;

    const second = await post(b, headers, signed.rawBody);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ outcome: 'duplicate' });
    const after = await v.state();
    expect(after.runs.filter((r) => r.kind === 'payment')).toHaveLength(runs);
    expect(after.log.filter((l) => l.action === 'webhook.received')).toHaveLength(1);
    expect(after.log.filter((l) => l.action === 'plan.advanced')).toHaveLength(1);
  });

  it('rejects a forged or tampered delivery with 401 and changes nothing', async () => {
    const { b, v, invoiceId, sid } = await sentInvoice();
    const forged = JSON.stringify({ id: 'WH-FORGED-000001', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: invoiceId, status: 'PAID' } } });
    expect((await post(b, {}, forged)).status).toBe(401);
    expect((await post(b, { 'paypal-transmission-id': 'x', 'paypal-transmission-time': 'y', 'paypal-transmission-sig': 'z', 'paypal-auth-algo': 'HMAC-SHA256', 'paypal-cert-url': 'simulator' }, forged)).status).toBe(401);

    // A genuine signature does not survive a changed body.
    const signed = await b.manager.get(sid).simulatePayment(invoiceId);
    const headers = Object.fromEntries(Object.entries(signed.headers).filter((e): e is [string, string] => typeof e[1] === 'string'));
    expect((await post(b, headers, signed.rawBody.replace('INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.REFUNDED'))).status).toBe(401);
    const quiet = await v.state();
    expect(quiet.log.some((l) => l.actor === 'paypal')).toBe(false);
    expect(quiet.invoices[0]!.status).toBe('SENT');

    expect((await post(b, {}, 'x'.repeat(300_000))).status).toBe(413);
    expect((await fetch(`${b.url}/api/webhooks/paypal`)).status).toBe(405);
  });
});

describe('http: server-sent events', () => {
  it('streams a snapshot first, then run and project events as the agent works', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    await v.state();
    const ac = new AbortController();
    const res = await fetch(`${b.url}/api/events`, { headers: { cookie: v.cookie }, signal: ac.signal });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const events: ServerEvent[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as ServerEvent);
          }
        }
      } catch {
        /* aborted */
      }
    })();
    await v.call('POST', '/api/runs/plan', { brief: BRIEF });
    for (let i = 0; i < 200 && !events.some((e) => e.type === 'run' && e.run.status === 'done'); i++) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await pump;
    expect(events[0]!.type).toBe('snapshot');
    const types = events.map((e) => e.type);
    expect(types).toContain('project');
    expect(types.filter((t) => t === 'run').length).toBeGreaterThanOrEqual(2);
    const last = events.filter((e) => e.type === 'run').at(-1)!;
    expect(last.type === 'run' && last.run.status).toBe('done');
  });

  it('caps open streams per workspace', async () => {
    const b = await boot();
    const v = new Visitor(b.url);
    await v.state();
    const acs: AbortController[] = [];
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ac = new AbortController();
      acs.push(ac);
      codes.push((await fetch(`${b.url}/api/events`, { headers: { cookie: v.cookie }, signal: ac.signal })).status);
    }
    for (const ac of acs) ac.abort();
    expect(codes).toEqual([200, 200, 200, 200, 503, 503]);
  });
});

describe('http: sandbox mode', () => {
  const neverCalled: PayPalGateway = {
    mode: 'sandbox',
    createInvoice: () => Promise.reject(new Error('unexpected PayPal call')),
    sendInvoice: () => Promise.reject(new Error('unexpected PayPal call')),
    getInvoice: () => Promise.reject(new Error('unexpected PayPal call')),
    sendReminder: () => Promise.reject(new Error('unexpected PayPal call')),
    cancelInvoice: () => Promise.reject(new Error('unexpected PayPal call')),
    verifyWebhook: () => Promise.resolve(false),
  };
  const ENV = { PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: '8PT597110X687430LKGECATA', PACELINE_SANDBOX_BUYER_EMAIL: 'buyer@personal.example.com' };

  it('says so in the state, has no simulator controls, and never leaks credentials', async () => {
    const b = await boot({ env: ENV, sandbox: neverCalled });
    const v = new Visitor(b.url);
    const s = await v.state();
    expect(s.info).toMatchObject({ mode: 'sandbox', paypalHost: 'api-m.sandbox.paypal.com', sandboxBuyerEmail: 'buyer@personal.example.com' });
    expect(JSON.stringify(s)).not.toContain('secret');
    expect(await status(v.call('POST', '/api/sim/clock', { days: 3 }))).toBe(409);
    expect(await status(v.call('POST', '/api/sim/sample'))).toBe(409);
    expect(await status(v.call('POST', '/api/sim/pay', { invoiceId: 'INV2-AAAA-BBBB-CCCC-DDDD' }))).toBe(409);
  });

  it('planning and approving a plan makes no PayPal call; unsigned webhooks are refused', async () => {
    const b = await boot({ env: ENV, sandbox: neverCalled });
    const v = new Visitor(b.url);
    const { proposalId } = await v.planAndApprove();
    const s = await v.state();
    expect(s.invoices).toEqual([]);
    expect(s.proposals.find((p) => p.id === proposalId)!.payload).toMatchObject({ clientEmail: 'buyer@personal.example.com' });
    const res = await fetch(`${b.url}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"WH-1234567","event_type":"INVOICING.INVOICE.PAID"}' });
    expect(res.status).toBe(401);
  });
});

describe('http: static frontend', () => {
  function site(): string {
    const root = mkdtempSync(join(tmpdir(), 'paceline-static-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><meta name="paceline-nonce" content="__CSP_NONCE__"><meta name="paceline-ag-grid" content="__AG_GRID_LICENSE__"><div id="root"></div>');
    writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
    return root;
  }

  it('serves the page with a strict CSP and a per-request nonce, assets as immutable', async () => {
    const root = site();
    const b = await boot({ staticRoot: root, env: { PACELINE_AG_GRID_LICENSE_KEY: 'Using_this_{AG_Grid}_key_[v3]_abc==' } });
    const res = await fetch(`${b.url}/`);
    const csp = res.headers.get('content-security-policy')!;
    const html = await res.text();
    const nonce = /name="paceline-nonce" content="([^"]+)"/.exec(html)![1]!;
    expect(csp).toBe(contentSecurityPolicy(nonce));
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
    expect(csp).not.toMatch(/https?:/);
    expect(html).not.toContain('__CSP_NONCE__');
    expect(html).toContain('content="Using_this_AG_Grid_key_[v3]_abc=="');
    const second = await (await fetch(`${b.url}/`)).text();
    expect(/content="([^"]+)"/.exec(second)![1]).not.toBe(nonce);

    const asset = await fetch(`${b.url}/assets/app-abc123.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect(asset.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect((await fetch(`${b.url}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${b.url}/some/client/route`)).status).toBe(200);
    expect((await fetch(`${b.url}/..%2f..%2fpackage.json`)).status).toBe(404);
    expect((await fetch(`${b.url}/assets/../../package.json`)).status).toBe(404);
    rmSync(root, { recursive: true, force: true });
  });

  it('gzips large text assets for clients that accept it, and only those', async () => {
    const root = site();
    const big = `export const rows = [${Array.from({ length: 400 }, (_, i) => `{id:${i},name:"milestone ${i}"}`).join(',')}];\n`;
    writeFileSync(join(root, 'assets', 'vendor-def456.js'), big);
    const b = await boot({ staticRoot: root });

    const gz = await fetch(`${b.url}/assets/vendor-def456.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('vary')).toBe('accept-encoding');
    expect(Number(gz.headers.get('content-length'))).toBeLessThan(big.length / 3);
    expect(await gz.text()).toBe(big); // fetch decompresses: same bytes as the file

    const plain = await fetch(`${b.url}/assets/vendor-def456.js`, { headers: { 'accept-encoding': 'identity' } });
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(Number(plain.headers.get('content-length'))).toBe(Buffer.byteLength(big));
    expect(await plain.text()).toBe(big);

    // Tiny files and the page itself are sent as they are.
    expect((await fetch(`${b.url}/assets/app-abc123.js`, { headers: { 'accept-encoding': 'gzip' } })).headers.get('content-encoding')).toBeNull();
    expect((await fetch(`${b.url}/`, { headers: { 'accept-encoding': 'gzip' } })).headers.get('content-encoding')).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('http: operator mode (live sandbox for one browser, simulator for everyone else)', () => {
  const TOKEN = 'op-token-0123456789abcdefghijklmnop';
  const WEBHOOK_ID = '8PT597110X687430LKGECATA';
  const ENV = {
    PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
    PACELINE_SANDBOX_BUYER_EMAIL: 'buyer@personal.example.com', PACELINE_OPERATOR_TOKEN: TOKEN,
  };

  /** A stand-in for the shared sandbox merchant: records every call; "PayPal" vouches for deliveries signed "ok". */
  function fakeSandbox(): { gateway: PayPalGateway; calls: string[]; sim: PayPalSimulator } {
    const sim = new PayPalSimulator(newSimulatorState(), () => new Date());
    const calls: string[] = [];
    const gateway: PayPalGateway = {
      mode: 'sandbox',
      createInvoice: (i) => { calls.push(`create ${i.recipientEmail}`); return sim.createInvoice(i); },
      sendInvoice: (id, n) => { calls.push('send'); return sim.sendInvoice(id, n); },
      getInvoice: (id) => { calls.push('get'); return sim.getInvoice(id); },
      sendReminder: (id, n) => { calls.push('remind'); return sim.sendReminder(id, n); },
      cancelInvoice: (id, n) => { calls.push('cancel'); return sim.cancelInvoice(id, n); },
      verifyWebhook: async (headers) => { calls.push('verify'); return headers['paypal-transmission-sig'] === 'ok'; },
    };
    return { gateway, calls, sim };
  }

  const form = (b: Booted, v: Visitor, body: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${b.url}/operator`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: b.url, ...(v.cookie ? { cookie: v.cookie } : {}), ...headers },
      body,
    }).then((res) => {
      const set = res.headers.get('set-cookie');
      if (set) v.cookie = set.split(';')[0]!;
      return res;
    });

  it('visitors get the simulator: no PayPal call, sample data and the clock work', async () => {
    const f = fakeSandbox();
    const b = await boot({ env: ENV, sandbox: f.gateway });
    const v = new Visitor(b.url);
    expect((await v.state()).info).toMatchObject({ mode: 'simulator' });
    expect((await v.state()).info.sandboxBuyerEmail).toBeUndefined();
    const { proposalId } = await v.planAndApprove();
    await v.call('POST', `/api/proposals/${proposalId}/approve`, {});
    const s = await v.state();
    expect(s.invoices[0]).toMatchObject({ source: 'simulator', status: 'SENT' });
    await v.call('POST', '/api/sim/pay', { invoiceId: s.invoices[0]!.id });
    expect((await v.state()).invoices[0]!.status).toBe('PAID');
    expect(await status(v.call('POST', '/api/sim/clock', { days: 1 }))).toBe(200);
    expect(f.calls).toEqual([]);
    expect(await (await fetch(`${b.url}/healthz`)).json()).toMatchObject({ mode: 'sandbox', sandboxAccess: 'operator' });
  });

  it('the operator page is script-free, and a wrong token is refused without unlocking anything', async () => {
    const f = fakeSandbox();
    const b = await boot({ env: ENV, sandbox: f.gateway });
    const page = await fetch(`${b.url}/operator`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    const html = await page.text();
    expect(html).not.toContain('<script');
    expect(html).toContain('name="token"');

    const v = new Visitor(b.url);
    const wrong = await form(b, v, `token=${encodeURIComponent('x'.repeat(30))}`);
    expect(wrong.status).toBe(401);
    expect((await v.state()).info.mode).toBe('simulator');
    // Cross-origin posts and non-form bodies are refused too.
    expect((await form(b, v, `token=${TOKEN}`, { origin: 'https://evil.example' })).status).toBe(403);
    // `Origin: null` (sandboxed frames, data: URLs) is only trusted when the browser says the post is same-origin.
    expect((await form(b, v, `token=${TOKEN}`, { origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await form(b, v, `token=${TOKEN}`, { origin: 'null' })).status).toBe(403);
    expect((await form(b, v, JSON.stringify({ token: TOKEN }), { 'content-type': 'application/json' })).status).toBe(415);
    expect((await v.state()).info.mode).toBe('simulator');
  });

  it('a real browser form post works: no-referrer pages send Origin: null with Sec-Fetch-Site: same-origin', async () => {
    const f = fakeSandbox();
    const b = await boot({ env: ENV, sandbox: f.gateway });
    expect((await fetch(`${b.url}/operator`)).headers.get('referrer-policy')).toBe('no-referrer');
    const v = new Visitor(b.url);
    await v.state();
    const browser = { origin: 'null', 'sec-fetch-site': 'same-origin' };
    expect((await form(b, v, `token=${encodeURIComponent(TOKEN)}`, browser)).status).toBe(303);
    expect((await v.state()).info.mode).toBe('sandbox');
    expect((await form(b, v, 'action=lock', browser)).status).toBe(303);
    expect((await v.state()).info.mode).toBe('simulator');
  });

  it('the right token gives this browser a live workspace; invoices go to the sandbox buyer; a real webhook unlocks the plan', async () => {
    const f = fakeSandbox();
    const b = await boot({ env: ENV, sandbox: f.gateway });
    const op = new Visitor(b.url);
    await op.state(); // an ordinary session first
    const res = await form(b, op, `token=${encodeURIComponent(TOKEN)}`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    const s0 = await op.state();
    expect(s0.info).toMatchObject({ mode: 'sandbox', sandboxBuyerEmail: 'buyer@personal.example.com' });
    expect(await (await fetch(`${b.url}/operator`, { headers: { cookie: op.cookie } })).text()).toContain('Back to the simulator');
    expect(await status(op.call('POST', '/api/sim/clock', { days: 1 }))).toBe(409);

    const { proposalId } = await op.planAndApprove();
    await op.call('POST', `/api/proposals/${proposalId}/approve`, {});
    const sent = await op.state();
    expect(f.calls.slice(0, 2)).toEqual(['create buyer@personal.example.com', 'send']);
    const invoice = sent.invoices[0]!;
    expect(invoice.source).toBe('sandbox');

    // Another visitor at the same time is still on the simulator and cannot see the operator's invoice.
    const other = new Visitor(b.url);
    expect((await other.state()).info.mode).toBe('simulator');
    expect((await other.state()).invoices).toEqual([]);

    // PayPal delivers INVOICING.INVOICE.PAID; the shared sandbox verifier vouches for it.
    const { rawBody } = await f.sim.pay(invoice.id);
    const bad = await fetch(`${b.url}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', 'paypal-transmission-sig': 'forged' }, body: rawBody });
    expect(bad.status).toBe(401);
    const good = await fetch(`${b.url}/api/webhooks/paypal`, { method: 'POST', headers: { 'content-type': 'application/json', 'paypal-transmission-sig': 'ok' }, body: rawBody });
    expect(await good.json()).toMatchObject({ outcome: 'applied' });
    const paid = await op.until((x) => x.invoices[0]?.status === 'PAID', 'paid');
    expect(paid.lastChange?.unlocked).toEqual(['m2']);

    // Reset keeps the operator live; "Back to the simulator" leaves it.
    await op.call('POST', '/api/reset');
    expect((await op.state()).info.mode).toBe('sandbox');
    expect((await form(b, op, 'action=lock')).status).toBe(303);
    expect((await op.state()).info.mode).toBe('simulator');
  });

  it('a live workspace survives a restart, but not a change of operator token', async () => {
    const f = fakeSandbox();
    const dir = mkdtempSync(join(tmpdir(), 'paceline-op-'));
    const b1 = await boot({ env: ENV, sandbox: f.gateway, dir });
    const op = new Visitor(b1.url);
    await form(b1, op, `token=${encodeURIComponent(TOKEN)}`);
    expect((await op.state()).info.mode).toBe('sandbox');
    await b1.close();
    open.splice(open.indexOf(b1), 1);

    const b2 = await boot({ env: ENV, sandbox: f.gateway, dir });
    const again = Object.assign(new Visitor(b2.url), { cookie: op.cookie });
    expect((await again.state()).info.mode).toBe('sandbox');
    await b2.close();
    open.splice(open.indexOf(b2), 1);

    const b3 = await boot({ env: { ...ENV, PACELINE_OPERATOR_TOKEN: `${TOKEN}-rotated` }, sandbox: f.gateway, dir });
    const after = Object.assign(new Visitor(b3.url), { cookie: op.cookie });
    expect((await after.state()).info.mode).toBe('simulator');
  });

  it('pairing: a browser shows a code, another device submits it with the token, and only that browser goes live', async () => {
    const b = await boot({ env: ENV, sandbox: fakeSandbox().gateway });
    const screen = new Visitor(b.url);
    const page = await fetch(`${b.url}/operator`);
    screen.cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    const code = /pairing code <strong class="code">([A-Z0-9]{4}-[A-Z0-9]{4})</.exec(await page.text())![1]!;
    // The same browser keeps its code across reloads.
    expect(await (await fetch(`${b.url}/operator`, { headers: { cookie: screen.cookie } })).text()).toContain(code);

    const phone = new Visitor(b.url);
    expect((await form(b, phone, `token=${'z'.repeat(30)}&code=${code}`)).status).toBe(401);
    expect((await form(b, phone, `token=${encodeURIComponent(TOKEN)}&code=ZZZZ-ZZZZ`)).status).toBe(404);
    expect((await screen.state()).info.mode).toBe('simulator');
    const ok = await form(b, phone, `token=${encodeURIComponent(TOKEN)}&code=${code.toLowerCase()}`);
    expect(ok.status).toBe(200);
    expect((await screen.state()).info.mode).toBe('sandbox');
    expect((await phone.state()).info.mode).toBe('simulator');
    // A code works once.
    expect((await form(b, phone, `token=${encodeURIComponent(TOKEN)}&code=${code}`)).status).toBe(404);
  });

  it('unlock attempts are rate limited per address', async () => {
    const b = await boot({ env: ENV, sandbox: fakeSandbox().gateway });
    const v = new Visitor(b.url);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await form(b, v, `token=${'y'.repeat(30)}`)).status);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('/operator does not exist unless operator mode is on', async () => {
    const b = await boot();
    expect((await fetch(`${b.url}/operator`)).status).toBe(404);
    const everyone = await boot({ env: { ...ENV, PACELINE_OPERATOR_TOKEN: '', PACELINE_SANDBOX_ACCESS: 'everyone' }, sandbox: fakeSandbox().gateway });
    expect((await fetch(`${everyone.url}/operator`)).status).toBe(404);
    expect((await new Visitor(everyone.url).state()).info.mode).toBe('sandbox');
  });
});
