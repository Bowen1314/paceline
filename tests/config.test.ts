import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_MODEL, describeConfig, loadConfig, scrubEnvironment, sha256Hex } from '../server/config.ts';

const ROOT = join(import.meta.dirname, '..');
/** The shape of a real PayPal webhook id (uppercase letters and digits). */
const WEBHOOK_ID = '8PT597110X687430LKGECATA';

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('environment variable rule', () => {
  it('a process with only generic LLM variables ends up with no key and the scripted planner', () => {
    const c = loadConfig({
      LLM_API_KEY: 'sk-generic-should-never-be-used',
      OPENAI_API_KEY: 'sk-openai-should-never-be-used',
      LLM_BASE_URL: 'https://example.invalid/v1',
      OPENAI_BASE_URL: 'https://example.invalid/v1',
      ANTHROPIC_API_KEY: 'sk-ant-should-never-be-used',
    });
    expect(c.planner).toEqual({ kind: 'scripted' });
    expect(JSON.stringify(c)).not.toContain('should-never-be-used');
    expect(JSON.stringify(c)).not.toContain('example.invalid');
  });

  it('generic variables never override the vendor-specific key or the base URL', () => {
    const c = loadConfig({ NEBIUS_API_KEY: 'neb-1', LLM_API_KEY: 'generic', OPENAI_API_KEY: 'generic2', LLM_BASE_URL: 'https://example.invalid/v1', LLM_MODEL: 'other' });
    expect(c.planner).toEqual({ kind: 'nebius', apiKey: 'neb-1', model: DEFAULT_MODEL });
  });

  it('PACELINE_PLANNER=nebius without NEBIUS_API_KEY refuses, even when a generic key is present', () => {
    expect(() => loadConfig({ PACELINE_PLANNER: 'nebius', LLM_API_KEY: 'generic' })).toThrow(ConfigError);
  });

  it('PACELINE_PLANNER=scripted ignores a present key', () => {
    expect(loadConfig({ PACELINE_PLANNER: 'scripted', NEBIUS_API_KEY: 'neb-1' }).planner).toEqual({ kind: 'scripted' });
  });

  it('only server/config.ts touches process.env, and nothing spawns child processes', () => {
    const offenders: string[] = [];
    for (const file of [...sources('server'), ...sources('shared'), ...sources('web')]) {
      // Comments may explain the rule; code may not break it.
      const text = readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/process\s*\.\s*env|process\[['"]env['"]\]|import\.meta\.env\.(?!DEV|PROD|MODE|BASE_URL)/.test(text) && file !== 'server/config.ts') offenders.push(`${file}: reads the environment`);
      if (/child_process|\bexecSync\b|\bspawn\(|\bfork\(|new Worker\(/.test(text)) offenders.push(`${file}: starts a process`);
      if (/\b(LLM_API_KEY|OPENAI_API_KEY|LLM_BASE_URL|OPENAI_BASE_URL)\b/.test(text)) offenders.push(`${file}: names a generic variable`);
    }
    expect(offenders).toEqual([]);
  });

  it('config.ts reads the environment only through the allow-list', () => {
    const text = readFileSync(join(ROOT, 'server/config.ts'), 'utf8');
    const names = [...text.matchAll(/get\('([A-Z0-9_]+)'\)/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(n).toMatch(/^(NEBIUS_API_KEY|PAYPAL_CLIENT_ID|PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID|PORT|PACELINE_[A-Z0-9_]+)$/);
    // No direct property reads such as env.FOO or env['FOO'] outside the allow-listed getter.
    expect(text.match(/\benv\.[A-Z_]{3,}/g)).toBeNull();
  });

  it('scrubEnvironment removes every key-like variable so nothing can inherit one', () => {
    const env: Record<string, string | undefined> = {
      PATH: '/usr/bin', HOME: '/home/x', LLM_API_KEY: 'a', OPENAI_API_KEY: 'b', NEBIUS_API_KEY: 'c', PAYPAL_CLIENT_ID: 'd', PAYPAL_CLIENT_SECRET: 'e',
      PAYPAL_WEBHOOK_ID: 'f', PACELINE_AG_GRID_LICENSE_KEY: 'g', GITHUB_TOKEN: 'h', DB_PASSWORD: 'i', PACELINE_PAYPAL_MODE: 'simulator',
    };
    const removed = scrubEnvironment(env);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PACELINE_PAYPAL_MODE', 'PATH']);
    expect(removed).toHaveLength(9);
  });
});

describe('sandbox-only configuration', () => {
  it('defaults to the simulator on port 8791, bound to loopback', () => {
    const c = loadConfig({});
    expect(c.paypal).toEqual({ mode: 'simulator' });
    expect(c.port).toBe(8791);
    expect(c.host).toBe('127.0.0.1');
    expect(describeConfig(c)).toContain('Simulated PayPal');
  });

  it('refuses any PayPal host other than the sandbox', () => {
    expect(() => loadConfig({ PACELINE_PAYPAL_HOST: 'api-m.paypal.com' })).toThrow(/refuses to start/);
    expect(() => loadConfig({ PACELINE_PAYPAL_HOST: 'api.paypal.com' })).toThrow(ConfigError);
    expect(() => loadConfig({ PACELINE_PAYPAL_ENVIRONMENT: 'live' })).toThrow(ConfigError);
    expect(() => loadConfig({ PACELINE_PAYPAL_ENVIRONMENT: 'production' })).toThrow(ConfigError);
    expect(loadConfig({ PACELINE_PAYPAL_HOST: 'api-m.sandbox.paypal.com', PACELINE_PAYPAL_ENVIRONMENT: 'sandbox' }).paypal.mode).toBe('simulator');
  });

  it('sandbox mode without credentials refuses to run instead of falling back to the simulator', () => {
    expect(() => loadConfig({ PACELINE_PAYPAL_MODE: 'sandbox' })).toThrow(/PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID/);
    expect(() => loadConfig({ PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' })).toThrow(/PAYPAL_WEBHOOK_ID/);
    expect(() => loadConfig({ PACELINE_PAYPAL_MODE: 'live', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_WEBHOOK_ID: 'w' })).toThrow(ConfigError);
    const ok = loadConfig({ PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_WEBHOOK_ID: WEBHOOK_ID, PACELINE_SANDBOX_BUYER_EMAIL: 'buyer@example.com' });
    expect(ok.paypal).toEqual({ mode: 'sandbox', clientId: 'id', clientSecret: 's', webhookId: WEBHOOK_ID, buyerEmail: 'buyer@example.com', access: 'everyone' });
    expect(describeConfig(ok)).not.toContain('secret');
  });

  it('refuses a webhook id PayPal would reject (verify-webhook-signature wants letters and digits only)', () => {
    const base = { PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's' };
    for (const bad of ['WH-1AB23456CD789012E', 'w', 'id with spaces', '8PT597110X68743/../']) expect(() => loadConfig({ ...base, PAYPAL_WEBHOOK_ID: bad })).toThrow(/webhook id/);
    expect(loadConfig({ ...base, PAYPAL_WEBHOOK_ID: WEBHOOK_ID }).paypal.mode).toBe('sandbox');
  });

  it('operator mode: visitors get the simulator, the token is kept only as a hash', () => {
    const base = { PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_WEBHOOK_ID: WEBHOOK_ID };
    const token = 'tok-0123456789abcdefghijklmnopqrstuv';
    const c = loadConfig({ ...base, PACELINE_OPERATOR_TOKEN: token, PACELINE_PUBLIC_URL: 'https://paceline.example.com' });
    expect(c.paypal).toMatchObject({ mode: 'sandbox', access: 'operator', operatorTokenSha256: sha256Hex(token) });
    expect(JSON.stringify(c)).not.toContain(token);
    expect(describeConfig(c)).toContain('operator only');
    expect(() => loadConfig({ ...base, PACELINE_OPERATOR_TOKEN: 'short' })).toThrow(/at least 24/);
    expect(() => loadConfig({ ...base, PACELINE_OPERATOR_TOKEN: 'has spaces in it but is long enough' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PACELINE_SANDBOX_ACCESS: 'operator' })).toThrow(/needs PACELINE_OPERATOR_TOKEN/);
    expect(() => loadConfig({ ...base, PACELINE_SANDBOX_ACCESS: 'anyone' })).toThrow(ConfigError);
  });

  it('a public live-sandbox deployment open to every visitor must be chosen explicitly', () => {
    const base = { PACELINE_PAYPAL_MODE: 'sandbox', PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 's', PAYPAL_WEBHOOK_ID: WEBHOOK_ID };
    expect(() => loadConfig({ ...base, PACELINE_PUBLIC_URL: 'https://paceline.example.com' })).toThrow(/PACELINE_OPERATOR_TOKEN/);
    expect(loadConfig({ ...base, PACELINE_PUBLIC_URL: 'https://paceline.example.com', PACELINE_SANDBOX_ACCESS: 'everyone' }).paypal).toMatchObject({ access: 'everyone' });
    expect(loadConfig({ ...base, PACELINE_PUBLIC_URL: 'http://localhost:8791' }).paypal).toMatchObject({ access: 'everyone' });
    expect(loadConfig(base).paypal).toMatchObject({ access: 'everyone' });
  });

  it('time zone for "today" defaults to US Pacific and must be a real IANA zone', () => {
    expect(loadConfig({}).timeZone).toBe('America/Los_Angeles');
    expect(loadConfig({ PACELINE_TIMEZONE: 'America/New_York' }).timeZone).toBe('America/New_York');
    expect(() => loadConfig({ PACELINE_TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA/);
  });

  it('model budget defaults and limits', () => {
    expect(loadConfig({}).modelBudget).toEqual({ dailyUsd: 0.25, dailyCalls: 300, perIpPerHour: 20 });
    expect(loadConfig({ PACELINE_MODEL_DAILY_USD: '0.1', PACELINE_MODEL_DAILY_CALLS: '50', PACELINE_MODEL_RUNS_PER_IP_HOUR: '5' }).modelBudget).toEqual({ dailyUsd: 0.1, dailyCalls: 50, perIpPerHour: 5 });
    expect(() => loadConfig({ PACELINE_MODEL_DAILY_USD: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ PACELINE_MODEL_DAILY_USD: 'lots' })).toThrow(ConfigError);
  });

  it('validates numeric settings', () => {
    expect(loadConfig({ PORT: '9000' }).port).toBe(9000);
    expect(loadConfig({ PORT: '9000', PACELINE_PORT: '9100' }).port).toBe(9100);
    expect(() => loadConfig({ PACELINE_PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ PACELINE_MAX_AGENT_RUNS: '0' })).toThrow(ConfigError);
  });
});
