/**
 * Per-IP token buckets and a global cap on concurrent agent runs. In-memory:
 * the demo runs as one small process.
 */
export interface BucketSpec {
  /** Bucket size (burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

export const BUCKETS = {
  read: { capacity: 120, refillPerSec: 4 },
  write: { capacity: 40, refillPerSec: 1 },
  agent: { capacity: 6, refillPerSec: 0.1 },
  webhook: { capacity: 60, refillPerSec: 2 },
  /** Operator unlock attempts: 5, then one a minute. */
  operator: { capacity: 5, refillPerSec: 1 / 60 },
} as const satisfies Record<string, BucketSpec>;

export type BucketName = keyof typeof BUCKETS;

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = 20_000) {}

  /** Take one token. Returns 0 when allowed, otherwise seconds until a token is available. */
  take(ip: string, name: BucketName): number {
    const spec = BUCKETS[name];
    const key = `${name}|${ip}`;
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: spec.capacity, at: t };
    b.tokens = Math.min(spec.capacity, b.tokens + ((t - b.at) / 1000) * spec.refillPerSec);
    b.at = t;
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) this.sweep(t);
    this.buckets.set(key, b);
    if (b.tokens < 1) return Math.ceil((1 - b.tokens) / spec.refillPerSec);
    b.tokens -= 1;
    return 0;
  }

  private sweep(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.at > 600_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}

export class BusyError extends Error {
  constructor() {
    super('The agent is busy with other requests. Try again in a moment.');
    this.name = 'BusyError';
  }
}

/** At most `max` model calls at once, with a short bounded queue. */
export class Semaphore {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly max: number, private readonly maxQueue = 8) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      if (this.waiting.length >= this.maxQueue) throw new BusyError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  get inFlight(): number {
    return this.active;
  }
}
