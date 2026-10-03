import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUCKETS, BusyError, RateLimiter, Semaphore } from '../server/rateLimit.ts';
import { Store } from '../server/store.ts';
import { newWorkspaceData } from '../shared/engine.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'paceline-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ID = 'ab'.repeat(16);

describe('Store', () => {
  it('round-trips a workspace and the webhook/invoice index across instances', () => {
    const dir = tmp();
    const a = new Store(dir, 1);
    const data = newWorkspaceData(ID, new Date('2026-10-05T12:00:00Z'));
    a.saveWorkspace(ID, () => data);
    a.registerInvoice('INV2-AAAA', ID);
    a.seenWebhooks.add('WH-1');
    a.flush(new Map([[ID, () => data]]));

    const b = new Store(dir, 1);
    expect(b.loadWorkspace(ID)).toEqual(data);
    expect(b.workspaceOfInvoice('INV2-AAAA')).toBe(ID);
    expect(b.seenWebhooks.has('WH-1')).toBe(true);
    expect(b.seenWebhooks.has('WH-2')).toBe(false);
    expect(b.workspaceCount()).toBe(1);
    expect(readdirSync(join(dir, 'workspaces')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('only accepts 32-hex ids, so a session id can never address another file', () => {
    const s = new Store(tmp(), 1);
    for (const bad of ['', '../x', 'index', `${ID}/..`, ID.toUpperCase(), `${ID}0`, 'a'.repeat(31)]) {
      expect(Store.validId(bad)).toBe(false);
      expect(s.loadWorkspace(bad)).toBeUndefined();
    }
    expect(Store.validId(ID)).toBe(true);
  });

  it('treats a corrupt or mismatched file as absent, and deletes cleanly', () => {
    const dir = tmp();
    const s = new Store(dir, 1);
    writeFileSync(join(dir, 'workspaces', `${ID}.json`), '{not json');
    expect(s.loadWorkspace(ID)).toBeUndefined();
    writeFileSync(join(dir, 'workspaces', `${ID}.json`), JSON.stringify({ ...newWorkspaceData('cd'.repeat(16), new Date()) }));
    expect(s.loadWorkspace(ID)).toBeUndefined();
    s.registerInvoice('INV2-BBBB', ID);
    s.deleteWorkspace(ID);
    expect(s.workspaceOfInvoice('INV2-BBBB')).toBeUndefined();
    expect(s.workspaceCount()).toBe(0);
  });
});

describe('RateLimiter and Semaphore', () => {
  it('allows the burst, then asks the caller to wait, then refills', () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    const burst = BUCKETS.agent.capacity;
    for (let i = 0; i < burst; i++) expect(rl.take('1.1.1.1', 'agent')).toBe(0);
    expect(rl.take('1.1.1.1', 'agent')).toBeGreaterThan(0);
    expect(rl.take('2.2.2.2', 'agent')).toBe(0); // another IP is unaffected
    t += 60_000;
    expect(rl.take('1.1.1.1', 'agent')).toBe(0);
  });

  it('caps concurrent agent runs and sheds load when the queue is full', async () => {
    const sem = new Semaphore(2, 1);
    let running = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const job = (): Promise<void> => sem.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => gates.push(r));
      running -= 1;
    });
    const a = job();
    const b = job();
    const c = job(); // queued
    await expect(job()).rejects.toBeInstanceOf(BusyError); // queue full
    await Promise.resolve();
    expect(sem.inFlight).toBe(2);
    gates.shift()!();
    await a;
    await new Promise((r) => setTimeout(r, 0));
    gates.shift()!();
    gates.shift()!();
    await Promise.all([b, c]);
    expect(peak).toBe(2);
    expect(sem.inFlight).toBe(0);
  });
});
