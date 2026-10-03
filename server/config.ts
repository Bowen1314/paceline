/**
 * Configuration. The ONLY file that reads the environment.
 *
 * Rule: read vendor-specific or project-prefixed names and nothing else:
 *   NEBIUS_API_KEY, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID,
 *   PACELINE_*, and PORT (the conventional name hosting platforms inject).
 * Generic names such as LLM_API_KEY, OPENAI_API_KEY or LLM_BASE_URL are never
 * read: some machines have unrelated values under those names and they must
 * not be used or sent anywhere. A test enforces both halves of this rule.
 */
import { createHash } from 'node:crypto';
import { isTimeZone } from '../shared/dates.ts';
import { PAYPAL_SANDBOX_HOST } from '../shared/paypal/gateway.ts';

export const NEBIUS_BASE_URL = 'https://api.tokenfactory.nebius.com/v1/';
export const DEFAULT_MODEL = 'nvidia/nemotron-3-super-120b-a12b';
/** West of every mainland-US merchant, so an invoice is never dated after the merchant's today (see shared/dates.ts). */
export const DEFAULT_TIME_ZONE = 'America/Los_Angeles';
/** Real PayPal webhook ids are uppercase letters and digits (e.g. 8PT597110X687430LKGECATA); verify-webhook-signature rejects anything else. */
const WEBHOOK_ID_RE = /^[A-Za-z0-9]{8,64}$/;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  dev: boolean;
  trustProxy: boolean;
  publicUrl?: string;
  paypal:
    | { mode: 'simulator' }
    | {
      mode: 'sandbox'; clientId: string; clientSecret: string; webhookId: string; buyerEmail?: string;
      /**
       * Who gets the live sandbox. `everyone`: every visitor's workspace calls
       * PayPal (one shared merchant account; fine on localhost). `operator`:
       * visitors get the simulator, and only a browser that unlocked /operator
       * with PACELINE_OPERATOR_TOKEN gets a live workspace.
       */
      access: 'everyone' | 'operator';
      /** SHA-256 (hex) of the operator token; the token itself is not kept. */
      operatorTokenSha256?: string;
    };
  planner: { kind: 'scripted' } | { kind: 'nebius'; apiKey: string; model: string };
  limits: { maxAgentRuns: number; maxWorkspaces: number; maxSseClients: number };
  /** Spend guard for the model (Nebius). Over a limit, the scripted planner and templates take over. */
  modelBudget: { dailyUsd: number; dailyCalls: number; perIpPerHour: number };
  /** IANA zone that defines "today" for invoice and due dates. */
  timeZone: string;
  agGridLicensed: boolean;
  /**
   * AG Grid Enterprise licence key, if the owner has one. AG Grid keys are
   * client-side by design (every AG Grid app ships its key to the browser), so
   * the server hands it to the page at request time. It is never committed and
   * never baked into the build or the image.
   */
  agGridLicenseKey?: string;
}

type Env = Record<string, string | undefined>;

const ALLOWED = /^(NEBIUS_API_KEY|PAYPAL_CLIENT_ID|PAYPAL_CLIENT_SECRET|PAYPAL_WEBHOOK_ID|PORT|PACELINE_[A-Z0-9_]+)$/;

/** A view of the environment that can only see allowed names. */
function allowed(env: Env): (name: string) => string | undefined {
  return (name) => {
    if (!ALLOWED.test(name)) throw new ConfigError(`Refusing to read environment variable ${name}: only vendor-specific and PACELINE_* names are allowed.`);
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
}

function int(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}.`);
  return n;
}

function num(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number between ${min} and ${max}.`);
  return n;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const isLocalUrl = (url: string | undefined): boolean => {
  if (!url) return true;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
};

export function loadConfig(env: Env, argv: string[] = []): Config {
  const get = allowed(env);

  // Sandbox only. Any other PayPal host is a configuration error, not a setting.
  const host = get('PACELINE_PAYPAL_HOST');
  if (host !== undefined && host !== PAYPAL_SANDBOX_HOST) {
    throw new ConfigError(`PACELINE_PAYPAL_HOST is "${host}". Paceline only talks to the PayPal sandbox (${PAYPAL_SANDBOX_HOST}) and refuses to start with any other host.`);
  }
  const envName = get('PACELINE_PAYPAL_ENVIRONMENT');
  if (envName !== undefined && envName.toLowerCase() !== 'sandbox') {
    throw new ConfigError(`PACELINE_PAYPAL_ENVIRONMENT is "${envName}". Only "sandbox" is supported.`);
  }

  const mode = (get('PACELINE_PAYPAL_MODE') ?? 'simulator').toLowerCase();
  let paypal: Config['paypal'];
  if (mode === 'simulator') {
    paypal = { mode: 'simulator' };
  } else if (mode === 'sandbox') {
    const clientId = get('PAYPAL_CLIENT_ID');
    const clientSecret = get('PAYPAL_CLIENT_SECRET');
    const webhookId = get('PAYPAL_WEBHOOK_ID');
    const missing = [!clientId && 'PAYPAL_CLIENT_ID', !clientSecret && 'PAYPAL_CLIENT_SECRET', !webhookId && 'PAYPAL_WEBHOOK_ID'].filter(Boolean);
    if (missing.length) {
      // No silent fallback to the simulator: a visitor must never think they are on PayPal when they are not.
      throw new ConfigError(`PACELINE_PAYPAL_MODE=sandbox needs ${missing.join(', ')}. Refusing to start (set PACELINE_PAYPAL_MODE=simulator to run without PayPal).`);
    }
    if (!WEBHOOK_ID_RE.test(webhookId!)) throw new ConfigError('PAYPAL_WEBHOOK_ID does not look like a PayPal webhook id (letters and digits only, as the developer dashboard shows it).');
    const token = get('PACELINE_OPERATOR_TOKEN');
    if (token !== undefined && (token.length < 24 || !/^[\x21-\x7e]+$/.test(token))) throw new ConfigError('PACELINE_OPERATOR_TOKEN must be at least 24 printable characters with no spaces.');
    const accessRaw = get('PACELINE_SANDBOX_ACCESS')?.toLowerCase();
    if (accessRaw !== undefined && accessRaw !== 'operator' && accessRaw !== 'everyone') throw new ConfigError(`PACELINE_SANDBOX_ACCESS must be "operator" or "everyone", not "${accessRaw}".`);
    const access = accessRaw ?? (token ? 'operator' : 'everyone');
    if (access === 'operator' && !token) throw new ConfigError('PACELINE_SANDBOX_ACCESS=operator needs PACELINE_OPERATOR_TOKEN.');
    // A public live-sandbox deployment where every visitor can make the shared merchant send invoices
    // and emails must be chosen on purpose, never reached by forgetting a variable.
    if (access === 'everyone' && accessRaw === undefined && !isLocalUrl(get('PACELINE_PUBLIC_URL'))) {
      throw new ConfigError('PACELINE_PAYPAL_MODE=sandbox on a public URL needs PACELINE_OPERATOR_TOKEN (visitors get the simulator, the operator unlocks the live sandbox at /operator), or PACELINE_SANDBOX_ACCESS=everyone to share the sandbox merchant with every visitor.');
    }
    paypal = {
      mode: 'sandbox', clientId: clientId!, clientSecret: clientSecret!, webhookId: webhookId!, buyerEmail: get('PACELINE_SANDBOX_BUYER_EMAIL'),
      access, ...(token ? { operatorTokenSha256: sha256Hex(token) } : {}),
    };
  } else {
    throw new ConfigError(`PACELINE_PAYPAL_MODE must be "simulator" or "sandbox", not "${mode}".`);
  }

  const plannerPref = (get('PACELINE_PLANNER') ?? 'auto').toLowerCase();
  const apiKey = get('NEBIUS_API_KEY');
  let planner: Config['planner'];
  if (plannerPref === 'scripted' || (plannerPref === 'auto' && !apiKey)) planner = { kind: 'scripted' };
  else if (plannerPref === 'auto' || plannerPref === 'nebius') {
    if (!apiKey) throw new ConfigError('PACELINE_PLANNER=nebius needs NEBIUS_API_KEY.');
    planner = { kind: 'nebius', apiKey, model: get('PACELINE_MODEL') ?? DEFAULT_MODEL };
  } else throw new ConfigError(`PACELINE_PLANNER must be "auto", "nebius" or "scripted", not "${plannerPref}".`);

  const timeZone = get('PACELINE_TIMEZONE') ?? DEFAULT_TIME_ZONE;
  if (!isTimeZone(timeZone)) throw new ConfigError(`PACELINE_TIMEZONE "${timeZone}" is not an IANA time zone (e.g. America/Los_Angeles).`);

  return {
    port: int(get('PACELINE_PORT') ?? get('PORT'), 8791, 1, 65535, 'PORT'),
    host: get('PACELINE_HOST') ?? '127.0.0.1',
    dataDir: get('PACELINE_DATA_DIR') ?? 'data',
    dev: argv.includes('--dev'),
    trustProxy: get('PACELINE_TRUST_PROXY') === '1',
    publicUrl: get('PACELINE_PUBLIC_URL'),
    paypal,
    planner,
    limits: {
      maxAgentRuns: int(get('PACELINE_MAX_AGENT_RUNS'), 2, 1, 16, 'PACELINE_MAX_AGENT_RUNS'),
      maxWorkspaces: int(get('PACELINE_MAX_WORKSPACES'), 200, 1, 5000, 'PACELINE_MAX_WORKSPACES'),
      maxSseClients: int(get('PACELINE_MAX_SSE_CLIENTS'), 300, 1, 5000, 'PACELINE_MAX_SSE_CLIENTS'),
    },
    modelBudget: {
      dailyUsd: num(get('PACELINE_MODEL_DAILY_USD'), 0.25, 0, 100, 'PACELINE_MODEL_DAILY_USD'),
      dailyCalls: int(get('PACELINE_MODEL_DAILY_CALLS'), 300, 0, 100_000, 'PACELINE_MODEL_DAILY_CALLS'),
      perIpPerHour: int(get('PACELINE_MODEL_RUNS_PER_IP_HOUR'), 20, 0, 10_000, 'PACELINE_MODEL_RUNS_PER_IP_HOUR'),
    },
    timeZone,
    agGridLicensed: get('PACELINE_AG_GRID_LICENSE_KEY') !== undefined,
    agGridLicenseKey: get('PACELINE_AG_GRID_LICENSE_KEY'),
  };
}

/**
 * The one place the live process environment is touched: read the allowed
 * names, then scrub every key-like variable so nothing later in this process
 * (or anything it starts) can see a credential through the environment.
 */
export function bootConfig(argv: string[]): Config {
  const config = loadConfig(process.env, argv);
  scrubEnvironment(process.env);
  return config;
}

const KEY_LIKE = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/i;

/**
 * Remove every key-like variable from the live environment once the config has
 * been read, so nothing started later by this process (a tool, a child process,
 * a crash reporter) can inherit a credential. Returns the names removed.
 */
export function scrubEnvironment(env: Env): string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (KEY_LIKE.test(name) || name === 'PAYPAL_CLIENT_ID' || name === 'PAYPAL_WEBHOOK_ID') {
      delete env[name];
      removed.push(name);
    }
  }
  return removed;
}

/** One-line description for the startup log. Never includes secret values. */
export function describeConfig(c: Config): string {
  const paypal = c.paypal.mode === 'simulator'
    ? 'Simulated PayPal (no sandbox calls)'
    : `PayPal sandbox via ${PAYPAL_SANDBOX_HOST} (${c.paypal.access === 'operator' ? 'operator only; visitors get the simulator' : 'every visitor'})`;
  const planner = c.planner.kind === 'nebius'
    ? `Nebius ${c.planner.model} (budget $${c.modelBudget.dailyUsd}/day, ${c.modelBudget.dailyCalls} calls/day, ${c.modelBudget.perIpPerHour} runs/IP/hour)`
    : 'scripted planner (no model key)';
  return `${paypal}; ${planner}; today in ${c.timeZone}; data in ${c.dataDir}`;
}
