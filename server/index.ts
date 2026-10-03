/**
 * Entry point. One process: API + SSE + webhook endpoint + the built frontend.
 *
 *   npm run dev      tsx server/index.ts --dev   (Vite runs inside this process)
 *   npm start        node dist/server/index.js   (serves dist/client)
 */
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAYPAL_SANDBOX_HOST, type PayPalGateway } from '../shared/paypal/gateway.ts';
import { ScriptedPlanner } from '../shared/planner/scripted.ts';
import type { Planner } from '../shared/planner/types.ts';
import { ModelBudget, meteredFetch } from './budget.ts';
import { ConfigError, bootConfig, describeConfig, type Config } from './config.ts';
import { createApp, fillPlaceholders } from './http.ts';
import { SandboxGateway } from './paypal/sandbox.ts';
import { NebiusPlanner } from './planner/nebius.ts';
import { RateLimiter, Semaphore } from './rateLimit.ts';
import { Store } from './store.ts';
import { WorkspaceManager } from './workspaces.ts';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = bootConfig(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`\nPaceline refuses to start: ${e.message}\n`);
      process.exit(78);
    }
    throw e;
  }

  const store = new Store(resolve(config.dataDir));
  const models = new Semaphore(config.limits.maxAgentRuns);
  // The model's spend guard: a daily budget kept on disk, per-IP run allowances, metered calls.
  const budget = config.planner.kind === 'nebius' ? new ModelBudget(config.modelBudget, resolve(config.dataDir, 'model-budget.json')) : undefined;
  const planner: Planner = config.planner.kind === 'nebius'
    ? new NebiusPlanner({ apiKey: config.planner.apiKey, model: config.planner.model, fetch: meteredFetch(budget!) })
    : new ScriptedPlanner();
  const sandbox: PayPalGateway | undefined =
    config.paypal.mode === 'sandbox'
      ? new SandboxGateway({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, webhookId: config.paypal.webhookId })
      : undefined;
  const manager = new WorkspaceManager(config, store, planner, models, sandbox, { budget });

  const here = dirname(fileURLToPath(import.meta.url));
  let devMiddleware: Parameters<typeof createApp>[0]['devMiddleware'];
  let closeDev: (() => Promise<void>) | undefined;
  const server = createServer();
  if (config.dev) {
    const vite = await (await import('vite')).createServer({
      configFile: resolve(here, '../vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
      plugins: [{
        name: 'paceline-html-placeholders',
        transformIndexHtml: (html: string) => fillPlaceholders(html, '', config.agGridLicenseKey),
      }],
    });
    devMiddleware = vite.middlewares;
    closeDev = () => vite.close();
  }

  const app = createApp({
    config, manager, store, models, planner,
    limiter: new RateLimiter(),
    staticRoot: config.dev ? undefined : resolve(here, '../client'),
    devMiddleware,
    log: (line) => console.log(line),
  });
  server.on('request', app.handle);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  manager.start();

  server.listen(config.port, config.host, () => {
    console.log(describeConfig(config));
    console.log(`PayPal host is pinned to ${PAYPAL_SANDBOX_HOST}.`);
    console.log(`Paceline listening on http://${config.host}:${config.port}${config.dev ? '  (dev: Vite middleware)' : ''}`);
  });

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    app.close();
    manager.stop();
    void closeDev?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
