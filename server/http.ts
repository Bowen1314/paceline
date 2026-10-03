/**
 * HTTP surface: JSON API, server-sent events, the PayPal webhook endpoint and
 * the built frontend. Plain node:http — no framework, nothing to configure.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { gzip, gzipSync } from 'node:zlib';
import type { ApiError, LedgerQueryRequest, LedgerQueryResponse, ServerEvent } from '../shared/contract.ts';
import { LIMITS } from '../shared/contract.ts';
import { Problem, VERSION, type Workspace } from '../shared/engine.ts';
import { PAYPAL_SANDBOX_HOST, PayPalError } from '../shared/paypal/gateway.ts';
import { loadSampleWorkspace } from '../shared/sample.ts';
import { WEBHOOK_MAX_BYTES, handleWebhook } from '../shared/webhook.ts';
import { BudgetedPlanner } from './budget.ts';
import { sha256Hex, type Config } from './config.ts';
import { NebiusPlanner } from './planner/nebius.ts';
import type { Planner } from '../shared/planner/types.ts';
import { BusyError, type BucketName, type RateLimiter, type Semaphore } from './rateLimit.ts';
import { Store } from './store.ts';
import type { WorkspaceManager } from './workspaces.ts';

export const SESSION_COOKIE = 'paceline_sid';
const API_BODY_MAX = 32 * 1024;
const SSE_PER_WORKSPACE = 4;
const MAX_WORKSPACES_ON_DISK = 5000;
const OPERATOR_BODY_MAX = 2048;

/**
 * The policy the production server sends. It is `default-src 'self'` plus the
 * hardening directives that `default-src` does not cover, and one widening:
 * `style-src-attr 'unsafe-inline'` because Bryntum Gantt and AG Grid position
 * rows and bars with inline `style=""` attributes in the markup they generate.
 * Stylesheets themselves (`style-src-elem`) stay `'self'` — AG Grid's theme is
 * injected through a constructable stylesheet / nonce'd element (see
 * web/ledger), and data: is allowed only for images and fonts embedded in the
 * vendors' own CSS.
 */
export function contentSecurityPolicy(styleNonce: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'nonce-${styleNonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** index.html carries two placeholders the server fills per request: the style nonce and the (optional) AG Grid licence key. */
export function fillPlaceholders(html: string, nonce: string, agGridLicenseKey: string | undefined): string {
  const safeKey = (agGridLicenseKey ?? '').replace(/[^\w\-\[\]=+/.,: ]/g, '');
  return html.replaceAll('__CSP_NONCE__', nonce).replaceAll('__AG_GRID_LICENSE__', safeKey);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

interface StaticFile { path: string; type: string; size: number; immutable: boolean }

/** Text-like assets worth gzipping (the two vendor bundles go from 6.1 MB to 2.2 MB on the wire). */
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg\+xml|font\/ttf)/;
const compressible = (f: StaticFile): boolean => f.immutable && f.size > 1024 && COMPRESSIBLE.test(f.type);

/** Index the built frontend once. Requests can only ever hit a file found here, so there is no path to traverse. */
export function indexStatic(root: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, `${prefix}${name}/`);
      else if (st.isFile()) files.set(`/${prefix}${name}`, { path: full, type: TYPES[extname(name)] ?? 'application/octet-stream', size: st.size, immutable: prefix.startsWith('assets/') });
    }
  };
  walk(root, '');
  return files;
}

export interface AppDeps {
  config: Config;
  manager: WorkspaceManager;
  store: Store;
  limiter: RateLimiter;
  models: Semaphore;
  planner: Planner;
  /** Built frontend (production). */
  staticRoot?: string;
  /** Dev: a connect-style middleware (Vite) that serves everything that is not the API. */
  devMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  log?: (line: string) => void;
}

type Handler = (ctx: Ctx, params: string[]) => Promise<unknown> | unknown;
interface Route { method: string; pattern: RegExp; bucket: BucketName; handler: Handler; body?: boolean }

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  ws: Workspace;
  sid: string;
  body: Record<string, unknown>;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Problem(400, 'invalid_request', `"${name}" is required.`);
  return v;
}

export function createApp(deps: AppDeps): { handle: (req: IncomingMessage, res: ServerResponse) => void; close: () => void; sseClients: () => number } {
  const { config, manager, store, limiter, models, planner } = deps;
  const log = deps.log ?? (() => {});
  const secure = config.publicUrl?.startsWith('https://') ?? false;
  const allowedOrigins = new Set<string>();
  if (config.publicUrl) allowedOrigins.add(new URL(config.publicUrl).origin);
  const files = deps.staticRoot ? indexStatic(deps.staticRoot) : new Map<string, StaticFile>();
  const indexHtml = files.get('/index.html');
  // Gzipped copies of the hashed assets, made once in the background at start-up
  // (or on first request if a visitor gets there first) and kept in memory.
  const gzipped = new Map<string, Buffer>();
  for (const f of files.values()) {
    if (!compressible(f)) continue;
    gzip(readFileSync(f.path), { level: 9 }, (err, out) => { if (!err && !gzipped.has(f.path)) gzipped.set(f.path, out); });
  }
  const streams = new Set<ServerResponse>();
  const startedAt = Date.now();

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(': keep-alive\n\n');
  }, 20_000);
  heartbeat.unref();

  /* ───────────── helpers ───────────── */

  const clientIp = (req: IncomingMessage): string => {
    if (config.trustProxy) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && cf) return cf;
      const xff = req.headers['x-forwarded-for'];
      const last = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const baseHeaders = (res: ServerResponse): void => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
    res.end(text);
  };

  const fail = (res: ServerResponse, status: number, code: string, message: string, details?: string[], headers: Record<string, string> = {}): void => {
    const body: ApiError = { error: { code, message, ...(details?.length ? { details } : {}) } };
    json(res, status, body, headers);
  };

  const readBody = (req: IncomingMessage, max: number): Promise<string> =>
    new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] ?? 0);
      if (declared > max) {
        reject(new Problem(413, 'body_too_large', 'Request body is too large.'));
        req.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > max) {
          reject(new Problem(413, 'body_too_large', 'Request body is too large.'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  const session = (req: IncomingMessage, res: ServerResponse): string => {
    const raw = req.headers.cookie ?? '';
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{32})(?:;|$)`).exec(raw);
    if (m && Store.validId(m[1]!)) return m[1]!;
    if (store.workspaceCount() >= MAX_WORKSPACES_ON_DISK) throw new Problem(503, 'full', 'The demo is at capacity. Please try again later.');
    const sid = randomBytes(16).toString('hex');
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure ? '; Secure' : ''}`);
    return sid;
  };

  /** State-changing requests must come from our own pages. */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (!origin) return site === undefined || site === 'same-origin' || site === 'none';
    // With `referrer-policy: no-referrer`, browsers send `Origin: null` on form POSTs (the /operator
    // forms). Sec-Fetch-Site is set by the browser and cannot be forged by a page, so trust it here.
    if (origin === 'null') return site === 'same-origin';
    if (allowedOrigins.has(origin)) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  /* ───────────── routes ───────────── */

  const ledger = async (ws: Workspace, req: LedgerQueryRequest): Promise<LedgerQueryResponse> => {
    const rules = ws.ledgerQuery(req); // validates the query too
    // Behind the spend guard, a model answer needs a run from this visitor's allowance; otherwise the rules answer.
    const own = ws.planner;
    const model = own instanceof BudgetedPlanner ? (own.admit() ? own.inner : undefined) : own;
    if (!(model instanceof NebiusPlanner)) return rules;
    try {
      const data = ws.data;
      const answer = await models.run(() =>
        model.ledgerIntent(String(req.query).trim(), {
          today: ws.today(),
          clients: [...new Set(data.projects.map((p) => p.plan.client.name))],
          projects: [...new Set(data.projects.map((p) => p.plan.title))],
        }),
      );
      if (answer) return { intent: answer.intent, explanation: answer.explanation, by: 'model', understood: true };
    } catch (e) {
      log(`[ledger] model unavailable, using rules: ${(e as Error).message}`);
    }
    return rules;
  };

  const routes: Route[] = [
    { method: 'GET', pattern: /^\/api\/state$/, bucket: 'read', handler: ({ ws }) => ws.snapshot() },
    {
      method: 'POST', pattern: /^\/api\/runs\/plan$/, bucket: 'agent', body: true,
      handler: ({ ws, body }) => {
        const brief = str(body.brief, 'brief');
        if (models.inFlight >= config.limits.maxAgentRuns + 8) throw new BusyError();
        const { runId, done } = ws.startPlanRun(brief);
        done.catch((e: unknown) => log(`[run ${runId}] ${(e as Error).message}`));
        return { runId };
      },
    },
    { method: 'PUT', pattern: /^\/api\/projects\/([\w-]{1,40})\/plan$/, bucket: 'write', body: true, handler: ({ ws, body }, [id]) => ws.updatePlan(id!, body.plan as never) },
    { method: 'POST', pattern: /^\/api\/projects\/([\w-]{1,40})\/approve$/, bucket: 'write', handler: ({ ws }, [id]) => ws.approvePlan(id!) },
    { method: 'DELETE', pattern: /^\/api\/projects\/([\w-]{1,40})$/, bucket: 'write', handler: async ({ ws }, [id]) => { await ws.discardProject(id!); return { ok: true }; } },
    { method: 'POST', pattern: /^\/api\/projects\/([\w-]{1,40})\/milestones\/([\w-]{1,40})\/deliver$/, bucket: 'write', handler: ({ ws }, [id, mid]) => ws.markDelivered(id!, mid!) },
    {
      method: 'POST', pattern: /^\/api\/proposals\/([\w-]{1,40})\/approve$/, bucket: 'write', body: true,
      handler: ({ ws, body }, [id]) => ws.approveProposal(id!, {
        ...(typeof body.subject === 'string' ? { subject: body.subject } : {}),
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
      }),
    },
    { method: 'POST', pattern: /^\/api\/proposals\/([\w-]{1,40})\/reject$/, bucket: 'write', handler: ({ ws }, [id]) => ws.rejectProposal(id!) },
    { method: 'POST', pattern: /^\/api\/invoices\/([\w-]{1,60})\/cancel$/, bucket: 'write', handler: ({ ws }, [id]) => ws.requestCancel(id!) },
    { method: 'POST', pattern: /^\/api\/ledger\/query$/, bucket: 'write', body: true, handler: ({ ws, body }) => ledger(ws, { query: str(body.query, 'query').slice(0, LIMITS.ledgerQueryMaxChars + 1) }) },
    {
      // The simulated buyer pays. The resulting signed event goes through the same handler as POST /api/webhooks/paypal.
      method: 'POST', pattern: /^\/api\/sim\/pay$/, bucket: 'write', body: true,
      handler: async ({ ws, body }) => {
        const signed = await ws.simulatePayment(str(body.invoiceId, 'invoiceId'));
        const result = await handleWebhook(manager.webhookDeps(), signed.headers, signed.rawBody);
        if (result.status !== 200) throw new Problem(502, 'webhook_failed', `The simulated webhook was not accepted (${result.reason}).`);
        return { outcome: result.outcome };
      },
    },
    { method: 'POST', pattern: /^\/api\/sim\/clock$/, bucket: 'write', body: true, handler: async ({ ws, body }) => { await ws.advanceClock(Number(body.days)); return { ok: true }; } },
    {
      method: 'POST', pattern: /^\/api\/sim\/sample$/, bucket: 'agent',
      handler: async ({ ws }) => {
        if (ws.paypalMode !== 'simulator') throw new Problem(409, 'not_simulator', 'Sample data only exists in simulator mode.');
        if (ws.data.projects.length > 0) throw new Problem(409, 'not_empty', 'Reset the workspace before loading the sample.');
        await loadSampleWorkspace(ws, manager.webhookDeps());
        return { ok: true };
      },
    },
    { method: 'POST', pattern: /^\/api\/reset$/, bucket: 'agent', handler: ({ sid }) => { manager.reset(sid); return { ok: true }; } },
  ];

  const events = (req: IncomingMessage, res: ServerResponse, sid: string, ip: string): void => {
    if (streams.size >= config.limits.maxSseClients || manager.subscribers(sid) >= SSE_PER_WORKSPACE) {
      fail(res, 503, 'too_many_streams', 'Too many open connections. Close another tab and retry.', undefined, { 'retry-after': '5' });
      return;
    }
    const ws = manager.get(sid, ip);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (e: ServerEvent): void => { res.write(`data: ${JSON.stringify(e)}\n\n`); };
    res.write('retry: 2000\n\n');
    send({ type: 'snapshot', state: ws.snapshot() });
    const off = manager.subscribe(sid, send);
    streams.add(res);
    const done = (): void => { off(); streams.delete(res); };
    req.on('close', done);
    res.on('error', done);
  };

  const webhook = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req, WEBHOOK_MAX_BYTES);
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
    const result = await handleWebhook(manager.webhookDeps(), headers, raw);
    log(`[webhook] ${result.status} ${result.outcome}${result.reason ? ` (${result.reason})` : ''}`);
    json(res, result.status, { outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse, path: string): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
    let file = files.get(path);
    const isPage = !file && !extname(path) && indexHtml !== undefined;
    if (isPage) file = indexHtml;
    if (!file) return fail(res, 404, 'not_found', 'Not found.');
    const html = file.type.startsWith('text/html');
    if (html) {
      // A fresh nonce per page load, stamped on the one <meta> the app reads for AG Grid's injected theme styles.
      const nonce = randomBytes(16).toString('base64');
      const body = fillPlaceholders(readFileSync(file.path, 'utf8'), nonce, config.agGridLicenseKey);
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-cache', 'content-security-policy': contentSecurityPolicy(nonce), 'content-length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    const caching = file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (compressible(file)) {
      if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) {
        let gz = gzipped.get(file.path);
        if (!gz) {
          gz = gzipSync(readFileSync(file.path), { level: 9 });
          gzipped.set(file.path, gz);
        }
        res.writeHead(200, { 'content-type': file.type, 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': gz.length, 'cache-control': caching });
        res.end(req.method === 'HEAD' ? undefined : gz);
        return;
      }
      res.setHeader('vary', 'accept-encoding');
    }
    res.writeHead(200, { 'content-type': file.type, 'content-length': file.size, 'cache-control': caching });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file.path));
  };

  const api = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const method = req.method ?? 'GET';
    const ip = clientIp(req);

    if (path === '/api/webhooks/paypal') {
      if (method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
      const wait = limiter.take(ip, 'webhook');
      if (wait) return fail(res, 429, 'rate_limited', 'Too many requests.', undefined, { 'retry-after': String(wait) });
      return webhook(req, res);
    }

    if (path === '/api/events') {
      if (method !== 'GET') return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
      const wait = limiter.take(ip, 'read');
      if (wait) return fail(res, 429, 'rate_limited', 'Too many requests.', undefined, { 'retry-after': String(wait) });
      return events(req, res, session(req, res), ip);
    }

    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) return fail(res, routes.some((r) => r.pattern.test(path)) ? 405 : 404, 'not_found', 'No such endpoint.');

    const wait = limiter.take(ip, route.bucket);
    if (wait) return fail(res, 429, 'rate_limited', 'You are going a little fast. Try again in a moment.', undefined, { 'retry-after': String(wait) });

    let body: Record<string, unknown> = {};
    if (method !== 'GET') {
      if (!sameOrigin(req)) return fail(res, 403, 'cross_origin', 'Cross-origin requests are not accepted.');
      const raw = await readBody(req, API_BODY_MAX);
      if (raw.length > 0) {
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return fail(res, 415, 'unsupported_media_type', 'Send JSON.');
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          body = parsed as Record<string, unknown>;
        } catch {
          return fail(res, 400, 'invalid_json', 'The request body is not valid JSON.');
        }
      } else if (route.body) return fail(res, 400, 'invalid_request', 'A JSON body is required.');
    }

    const sid = session(req, res);
    const ws = manager.get(sid, ip);
    const params = route.pattern.exec(path)!.slice(1);
    const result = await route.handler({ req, res, ws, sid, body }, params);
    json(res, 200, result ?? { ok: true });
  };

  /* ───────────── operator unlock (live sandbox for one browser) ───────────── */

  const operatorEnabled = manager.sandboxAccess === 'operator' && config.paypal.mode === 'sandbox' && Boolean(config.paypal.operatorTokenSha256);

  const tokenMatches = (candidate: string): boolean => {
    if (config.paypal.mode !== 'sandbox' || !config.paypal.operatorTokenSha256) return false;
    const a = Buffer.from(sha256Hex(candidate), 'hex');
    const b = Buffer.from(config.paypal.operatorTokenSha256, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const esc = (t: string): string => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  /**
   * Pairing: a browser waiting on /operator shows a short code; the operator
   * submits that code with the token from another device (a phone, a terminal)
   * and the waiting browser's workspace goes live. The token never has to be
   * typed on the machine that records the demo.
   */
  const PAIRING_MS = 10 * 60_000;
  const pairings = new Map<string, { sid: string; expires: number }>();
  const pairingCode = (sid: string): string => {
    const now = Date.now();
    for (const [c, p] of pairings) {
      if (p.expires < now) pairings.delete(c);
      else if (p.sid === sid) return c;
    }
    if (pairings.size >= 1000) pairings.clear();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = [...randomBytes(8)].map((b) => alphabet[b % alphabet.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    pairings.set(code, { sid, expires: now + PAIRING_MS });
    return code;
  };

  /** A small server-rendered page: no script at all, its own strict CSP. */
  const operatorPage = (req: IncomingMessage, res: ServerResponse, status: number, message?: string, sid?: string): void => {
    let live = false;
    let own = sid;
    try {
      own ??= new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{32})(?:;|$)`).exec(req.headers.cookie ?? '')?.[1];
      live = own ? manager.modeOf(own) === 'sandbox' : false;
    } catch { /* no session yet */ }
    const code = !live && own ? pairingCode(own) : undefined;
    const nonce = randomBytes(16).toString('base64');
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Paceline operator</title><style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#fafafa;--fg:#18181b;--mute:#52525b;--line:#e4e4e7;--acc:#2563eb;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--mute:#a1a1aa;--line:#27272a;--acc:#60a5fa;--card:#18181b}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:460px;margin:12vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 8px}p{color:var(--mute);margin:0 0 16px}.msg{color:var(--fg);font-weight:600}
label{display:block;font-size:13px;margin-bottom:6px}input{box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{margin-top:12px;padding:10px 14px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}a{color:var(--acc)}
.pair{margin-top:20px}.code{font-family:ui-monospace,Menlo,monospace;letter-spacing:.08em;color:var(--fg)}
</style></head><body><main><div class="card"><h1>Paceline operator</h1>
${message ? `<p class="msg">${esc(message)}</p>` : ''}
${live
  ? `<p>This browser's workspace is connected to the live <strong>PayPal sandbox</strong> (${PAYPAL_SANDBOX_HOST}). Approved invoices are created in the sandbox merchant account and sent to the sandbox buyer.</p>
<p><a href="/">Open Paceline</a></p>
<form method="post" action="/operator"><input type="hidden" name="action" value="lock"><button class="sec" type="submit">Back to the simulator</button></form>`
  : `<p>Visitors use the built-in PayPal simulator. With the operator token, this browser gets a fresh workspace that creates real invoices in the PayPal <strong>sandbox</strong> (never live PayPal).</p>
<form method="post" action="/operator"><label for="t">Operator token</label><input id="t" name="token" type="password" autocomplete="current-password" required minlength="24" maxlength="200"><button type="submit">Unlock the live sandbox</button></form>
${code ? `<p class="pair">Or unlock this browser from another device: submit the token with pairing code <strong class="code">${code}</strong> (valid 10 minutes), then reload this page.</p>` : ''}`}
</div></main></body></html>`;
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body),
      'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const operator = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!operatorEnabled) return fail(res, 404, 'not_found', 'Not found.');
    if (req.method === 'GET' || req.method === 'HEAD') return operatorPage(req, res, 200, undefined, session(req, res));
    if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', 'Method not allowed.');
    const wait = limiter.take(clientIp(req), 'operator');
    if (wait) return operatorPage(req, res, 429, `Too many attempts. Try again in ${wait} seconds.`);
    if (!sameOrigin(req)) return operatorPage(req, res, 403, 'Cross-origin requests are not accepted.');
    if (!(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return operatorPage(req, res, 415, 'Send the form.');
    const form = new URLSearchParams(await readBody(req, OPERATOR_BODY_MAX));
    const code = (form.get('code') ?? '').trim().toUpperCase();
    if (code) {
      // Pairing: unlock the browser that is showing this code, not the one sending the form.
      if (!tokenMatches(form.get('token') ?? '')) return operatorPage(req, res, 401, 'That token is not right.');
      const waiting = pairings.get(code);
      if (!waiting || waiting.expires < Date.now()) return operatorPage(req, res, 404, 'No browser is waiting with that pairing code (codes last 10 minutes).');
      pairings.delete(code);
      manager.switchMode(waiting.sid, true);
      log('[operator] a session was unlocked with a pairing code');
      return operatorPage(req, res, 200, 'Paired: that browser now has a live sandbox workspace. Reload it.');
    }
    const sid = session(req, res);
    if (form.get('action') === 'lock') {
      manager.switchMode(sid, false);
      log('[operator] a session went back to the simulator');
    } else {
      if (!tokenMatches(form.get('token') ?? '')) return operatorPage(req, res, 401, 'That token is not right.');
      manager.switchMode(sid, true);
      log('[operator] a session unlocked the live sandbox');
    }
    res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'content-length': 0 });
    res.end();
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    baseHeaders(res);
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return fail(res, 400, 'bad_request', 'Bad request.');
    }

    if (path === '/healthz') {
      return json(res, 200, {
        ok: true, version: VERSION, mode: config.paypal.mode, sandboxAccess: manager.sandboxAccess, paypalHost: PAYPAL_SANDBOX_HOST, planner: config.planner.kind,
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), workspaces: manager.liveCount, streams: streams.size, agentRuns: models.inFlight,
      });
    }

    if (path === '/operator') {
      operator(req, res).catch((e: unknown) => {
        if (res.headersSent) return void res.end();
        if (e instanceof Problem) return operatorPage(req, res, e.status, e.message);
        log(`[error] ${req.method} /operator: ${(e as Error).message}`);
        operatorPage(req, res, 500, 'Something went wrong on our side.');
      });
      return;
    }

    if (path.startsWith('/api/')) {
      api(req, res, path).catch((e: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (e instanceof Problem) return fail(res, e.status, e.code, e.message, e.details);
        if (e instanceof BusyError) return fail(res, 503, 'busy', 'The agent is busy with other visitors. Try again in a few seconds.', undefined, { 'retry-after': '5' });
        if (e instanceof PayPalError) return fail(res, 502, 'paypal_error', `PayPal did not accept the request: ${e.message}`, e.issues);
        log(`[error] ${req.method} ${path}: ${(e as Error).stack ?? e}`);
        fail(res, 500, 'internal', 'Something went wrong on our side.');
      });
      return;
    }

    if (deps.devMiddleware) return deps.devMiddleware(req, res, () => fail(res, 404, 'not_found', 'Not found.'));
    serveStatic(req, res, path);
  };

  return {
    handle,
    sseClients: () => streams.size,
    close: () => {
      clearInterval(heartbeat);
      for (const res of streams) res.end();
      streams.clear();
    },
  };
}
