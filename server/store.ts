/**
 * File-backed persistence. One JSON file per workspace plus one index file
 * (invoice -> workspace routing and processed webhook ids).
 *
 * JSON rather than `node:sqlite`: on Node 22 `node:sqlite` is still marked
 * experimental, and a visitor workspace is a few kilobytes that is always read
 * and written whole. Writes are atomic (temp file + rename) and debounced.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceData } from '../shared/engine.ts';

const SID_RE = /^[a-f0-9]{32}$/;
const MAX_WEBHOOK_IDS = 5000;

interface IndexFile {
  v: 1;
  invoices: Record<string, string>;
  webhooks: string[];
}

export class Store {
  private readonly wsDir: string;
  private readonly indexPath: string;
  private index: IndexFile = { v: 1, invoices: {}, webhooks: [] };
  private webhookSet = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private indexTimer: NodeJS.Timeout | undefined;

  constructor(private readonly dir: string, private readonly debounceMs = 250) {
    this.wsDir = join(dir, 'workspaces');
    this.indexPath = join(dir, 'index.json');
    mkdirSync(this.wsDir, { recursive: true });
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8')) as IndexFile;
      if (raw?.v === 1) this.index = { v: 1, invoices: raw.invoices ?? {}, webhooks: raw.webhooks ?? [] };
    } catch {
      /* first run or unreadable index: start empty */
    }
    this.webhookSet = new Set(this.index.webhooks);
  }

  static validId(id: string): boolean {
    return SID_RE.test(id);
  }

  private writeAtomic(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, path);
  }

  loadWorkspace(id: string): WorkspaceData | undefined {
    if (!SID_RE.test(id)) return undefined;
    try {
      const data = JSON.parse(readFileSync(join(this.wsDir, `${id}.json`), 'utf8')) as WorkspaceData;
      return data?.v === 1 && data.id === id ? data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Schedule a write. `get` is called at write time so the latest state is saved. */
  saveWorkspace(id: string, get: () => WorkspaceData): void {
    if (!SID_RE.test(id) || this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      try {
        this.writeAtomic(join(this.wsDir, `${id}.json`), get());
      } catch (e) {
        console.error(`[store] could not save workspace: ${(e as Error).message}`);
      }
    }, this.debounceMs));
  }

  deleteWorkspace(id: string): void {
    if (!SID_RE.test(id)) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    rmSync(join(this.wsDir, `${id}.json`), { force: true });
    let touched = false;
    for (const [inv, ws] of Object.entries(this.index.invoices)) {
      if (ws === id) { delete this.index.invoices[inv]; touched = true; }
    }
    if (touched) this.saveIndex();
  }

  /** Workspace files not modified for `maxAgeMs`, oldest first. */
  staleWorkspaces(maxAgeMs: number, now = Date.now()): string[] {
    const out: { id: string; mtime: number }[] = [];
    for (const name of readdirSync(this.wsDir)) {
      const id = name.replace(/\.json$/, '');
      if (!SID_RE.test(id)) continue;
      const mtime = statSync(join(this.wsDir, name)).mtimeMs;
      if (now - mtime > maxAgeMs) out.push({ id, mtime });
    }
    return out.sort((a, b) => a.mtime - b.mtime).map((x) => x.id);
  }

  workspaceCount(): number {
    return readdirSync(this.wsDir).filter((n) => n.endsWith('.json')).length;
  }

  private saveIndex(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      try {
        this.writeAtomic(this.indexPath, this.index);
      } catch (e) {
        console.error(`[store] could not save index: ${(e as Error).message}`);
      }
    }, this.debounceMs);
  }

  registerInvoice(invoiceId: string, workspaceId: string): void {
    this.index.invoices[invoiceId] = workspaceId;
    this.saveIndex();
  }

  workspaceOfInvoice(invoiceId: string): string | undefined {
    return this.index.invoices[invoiceId];
  }

  /** Processed webhook event ids. */
  readonly seenWebhooks = {
    has: (id: string): boolean => this.webhookSet.has(id),
    add: (id: string): void => {
      if (this.webhookSet.has(id)) return;
      this.webhookSet.add(id);
      this.index.webhooks.push(id);
      if (this.index.webhooks.length > MAX_WEBHOOK_IDS) {
        for (const old of this.index.webhooks.splice(0, this.index.webhooks.length - MAX_WEBHOOK_IDS)) this.webhookSet.delete(old);
      }
      this.saveIndex();
    },
  };

  /** Write everything that is pending, synchronously (shutdown, tests). */
  flush(pending: Map<string, () => WorkspaceData> = new Map()): void {
    for (const [id, t] of this.timers) {
      clearTimeout(t);
      const get = pending.get(id);
      if (get) this.writeAtomic(join(this.wsDir, `${id}.json`), get());
    }
    this.timers.clear();
    if (this.indexTimer) {
      clearTimeout(this.indexTimer);
      this.indexTimer = undefined;
    }
    this.writeAtomic(this.indexPath, this.index);
  }
}
