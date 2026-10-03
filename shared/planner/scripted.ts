/**
 * The scripted planner: deterministic rules, no model, no network.
 *
 * It is what runs in tests, in `?mock=1`, and when no NEBIUS_API_KEY is set.
 * It reads a brief the way a careful intern with a checklist would: find the
 * total, the client, a deposit percentage, the listed deliverables with any
 * per-line amounts or durations, and the payment terms. Every figure it uses
 * is copied from the brief or derived by plain arithmetic from one.
 */
import { CURRENCIES, LIMITS } from '../contract.ts';
import type { CurrencyCode, ISODate, Minor } from '../contract.ts';
import { isISODate } from '../dates.ts';
import { parseHumanAmount } from '../money.ts';
import { EMAIL_RE, groundDraft, moneyMentions, type PlanDraft } from '../plan.ts';
import { PlannerError, type PlanProposal, type Planner, type ReminderDraft, type WriteTask } from './types.ts';

const MONEY_RE = /(?:[$€£]\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?([kK])?\b)|(?:\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?([kK])?\s?(?:USD|EUR|GBP|CAD|AUD)\b)/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function firstMoney(text: string): { minor: Minor; raw: string } | null {
  const m = MONEY_RE.exec(text);
  if (!m) return null;
  const raw = m[1] !== undefined ? `${m[1]}${m[2] ?? ''}${m[3] ?? ''}` : `${m[4]}${m[5] ?? ''}${m[6] ?? ''}`;
  const minor = parseHumanAmount(raw);
  return minor === null ? null : { minor, raw: m[0].trim() };
}

function detectCurrency(brief: string): CurrencyCode {
  for (const c of CURRENCIES) if (new RegExp(`\\b${c}\\b`).test(brief)) return c;
  if (brief.includes('€')) return 'EUR';
  if (brief.includes('£')) return 'GBP';
  return 'USD';
}

/** Working days in a phrase like "2 weeks", "10 days", "3 working days". */
function durationIn(text: string): number | null {
  const w = /(\d+(?:\.\d)?)\s*(?:-\s*)?(?:weeks?|wks?)\b/i.exec(text);
  if (w) return Math.max(1, Math.round(Number(w[1]) * 5));
  const d = /(\d+)\s*(?:-\s*)?(?:working |business )?days?\b/i.exec(text);
  if (d) return Math.max(1, Number(d[1]));
  return null;
}

function startDateIn(brief: string, today: ISODate): ISODate | null {
  const line = /\b(?:start(?:s|ing)?|kick(?:s|ing)?[- ]?off|begin(?:s|ning)?)\b(?:[^.\n]|\.(?=\s?\d))*/i.exec(brief)?.[0];
  if (!line) return null;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1];
  if (iso && isISODate(iso)) return iso;
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(line);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
  const pad = (n: number): string => String(n).padStart(2, '0');
  let year = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
  let date = `${year}-${pad(month)}-${pad(Number(m[2]))}`;
  if (!m[3] && date < today) date = `${++year}-${pad(month)}-${pad(Number(m[2]))}`;
  return isISODate(date) ? date : null;
}

function clientIn(brief: string): { name: string; email: string | null } {
  const email = brief.match(/[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}/i)?.[0]?.replace(/[.,;]+$/, '') ?? null;
  const labelled = /^\s*(?:client|customer|for)\s*[:\-–]\s*(.+)$/im.exec(brief)?.[1];
  let name = labelled?.replace(/[<(].*$/, '').replace(email ?? '\u0000', '').replace(/[,;–-]\s*$/, '').trim();
  if (!name) name = /\bfor\s+([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,3})/.exec(brief)?.[1]?.replace(/[.,]$/, '');
  return { name: name || 'Client', email: email && EMAIL_RE.test(email) ? email : null };
}

function titleIn(brief: string, clientName: string): string {
  const labelled = /^\s*(?:project|title|re|subject)\s*[:\-–]\s*(.+)$/im.exec(brief)?.[1]?.trim();
  if (labelled) return labelled.slice(0, 120);
  const first = brief.split('\n').map((l) => l.trim()).find((l) => l.length > 3 && !/^[-*•\d]/.test(l) && !/^(client|customer|for|budget|total|terms?)\b/i.test(l));
  const t = (first ?? `Project for ${clientName}`).replace(/[.:]$/, '');
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
}

interface Line {
  title: string;
  deliverable: string;
  duration: number | null;
  amount: { minor: Minor; raw: string } | null;
}

function deliverableLines(brief: string): Line[] {
  const out: Line[] = [];
  for (const raw of brief.split('\n')) {
    const m = /^\s*(?:[-*•–]|\d+[.)])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const text = m[1]!.trim();
    if (/^(?:\d+\s?%|deposit|upfront|up front|net \d+|payment|terms?)\b/i.test(text)) continue;
    const amount = firstMoney(text);
    const duration = durationIn(text);
    // Title: text up to the first separator, bracket or figure.
    let title = text.split(/\s[-–—:]\s|[(:]/)[0]!.trim();
    title = title.replace(MONEY_RE, '').replace(/\b\d+(?:\.\d)?\s*(?:weeks?|wks?|(?:working |business )?days?)\b/i, '').replace(/[,;.\s-]+$/, '').trim();
    if (!title) continue;
    out.push({ title: title.slice(0, 80), deliverable: text.slice(0, 300), duration, amount });
    if (out.length >= LIMITS.maxMilestones - 1) break;
  }
  return out;
}

export function scriptedDraft(brief: string, today: ISODate): PlanDraft {
  const text = brief.trim();
  if (text.length < 20) throw new PlannerError('The brief is too short to plan from. Describe the work, the client and the fee.');

  const client = clientIn(text);
  const lines = deliverableLines(text);
  const lineTotal = lines.every((l) => l.amount) && lines.length > 0 ? lines.reduce((s, l) => s + l.amount!.minor, 0) : null;

  // The total: the amount next to "total/budget/fee/fixed", else the largest amount, else the sum of itemised lines.
  const labelled = /\b(?:total|budget|fee|fixed(?: price)?|price|quote|contract)\b(?:[^.\n]|\.(?=\d))*/i.exec(text)?.[0];
  const mentions = moneyMentions(text);
  const stated = (labelled && firstMoney(labelled)) || null;
  const total = stated?.minor ?? lineTotal ?? (mentions.length ? Math.max(...mentions) : null);
  if (total === null) {
    throw new PlannerError('I could not find a fee in the brief. State the total (for example "Total: $12,000") or give each deliverable an amount.');
  }

  const depositPct = Number(/(\d{1,2})\s?%\s*(?:deposit|upfront|up[- ]front|on signing|to start|at kick-?off|in advance)/i.exec(text)?.[1] ?? /(?:deposit|upfront|up[- ]front)[^.\n%]{0,24}?(\d{1,2})\s?%/i.exec(text)?.[1] ?? 0);
  const net = Number(/\bnet[- ]?(\d{1,2})\b/i.exec(text)?.[1] ?? 7);
  const netDays = Math.min(LIMITS.maxNetDays, Math.max(0, net));

  const phases: Line[] = lines.length > 0 ? lines : [{ title: 'Project delivery', deliverable: 'All work described in the brief.', duration: durationIn(text), amount: null }];
  const itemised = lineTotal !== null && lineTotal === total;
  const deposit = !itemised && depositPct > 0 && depositPct < 100 ? Math.round((total * depositPct) / 100) : 0;
  const remaining = total - deposit;
  const even = Math.floor(remaining / phases.length / 100) * 100;

  const fmt = (minor: Minor): string => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
  const milestones: PlanDraft['milestones'] = [];
  if (deposit > 0) {
    milestones.push({ id: 'm1', title: 'Deposit', deliverable: `${depositPct}% of the fee to reserve the start date.`, durationDays: 0, amount: fmt(deposit), netDays: Math.min(netDays, 7), dependsOn: [] });
  }
  phases.forEach((ph, i) => {
    const id = `m${milestones.length + 1}`;
    const prev = milestones.at(-1);
    const amount = itemised ? ph.amount!.minor : i === phases.length - 1 ? remaining - even * (phases.length - 1) : even;
    milestones.push({
      id,
      title: ph.title,
      deliverable: ph.deliverable,
      durationDays: Math.min(LIMITS.maxDurationDays, ph.duration ?? 5),
      amount: fmt(amount),
      netDays,
      dependsOn: prev ? [{ on: prev.id, gate: 'paid' }] : [],
    });
  });

  return {
    title: titleIn(text, client.name),
    client,
    currency: detectCurrency(text),
    statedTotal: stated?.raw ?? null,
    startDate: startDateIn(text, today),
    milestones,
  };
}

export class ScriptedPlanner implements Planner {
  readonly kind = 'scripted' as const;

  async proposePlan(brief: string, today: ISODate, onStep?: (label: string) => void): Promise<PlanProposal> {
    onStep?.('Reading the brief with the built-in rules');
    const draft = scriptedDraft(brief, today);
    onStep?.('Checking every figure against the brief');
    const grounded = groundDraft(draft, brief, today);
    if (!grounded.plan) throw new PlannerError('The drafted plan did not pass validation.', grounded.errors);
    return {
      plan: grounded.plan,
      warnings: [
        ...grounded.warnings,
        { code: 'scripted_planner', message: 'Drafted by the built-in rule-based planner (no model key is configured). Durations it could not find default to 5 working days.' },
      ],
    };
  }

  async write(_task: WriteTask): Promise<string | null> {
    return null;
  }

  async draftReminder(_task: WriteTask): Promise<ReminderDraft | null> {
    return null;
  }
}
