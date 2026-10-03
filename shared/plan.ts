/**
 * Plan validation and grounding.
 *
 * `validatePlan` checks structure and business rules. `groundDraft` checks a
 * model-proposed draft against the brief it was drafted from: a stated total
 * must literally appear in the brief and the milestone amounts must add up to
 * it; an email must literally appear in the brief. Anything the planner could
 * not ground becomes a warning the user sees before approving.
 */
import { CURRENCIES, LIMITS } from './contract.ts';
import type { CurrencyCode, GateKind, ISODate, Minor, Plan, PlanWarning } from './contract.ts';
import { isISODate } from './dates.ts';
import { formatMoney, parseHumanAmount } from './money.ts';
import { PlanCycleError, topoOrder } from './schedule.ts';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

/** Structural and business-rule errors. Empty array = valid. */
export function validatePlan(plan: Plan): string[] {
  const errs: string[] = [];
  const str = (v: unknown, name: string, min: number, max: number): void => {
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) errs.push(`${name} must be ${min}–${max} characters`);
  };
  if (!plan || typeof plan !== 'object') return ['plan must be an object'];
  str(plan.title, 'title', 1, 120);
  if (!plan.client || typeof plan.client !== 'object') errs.push('client is required');
  else {
    str(plan.client.name, 'client.name', 1, 80);
    if (typeof plan.client.email !== 'string') errs.push('client.email must be a string');
    else if (plan.client.email !== '' && !EMAIL_RE.test(plan.client.email)) errs.push('client.email is not a valid email address');
  }
  if (!CURRENCIES.includes(plan.currency)) errs.push(`currency must be one of ${CURRENCIES.join(', ')}`);
  if (!isISODate(plan.startDate)) errs.push('startDate must be a YYYY-MM-DD date');
  if (!Array.isArray(plan.milestones) || plan.milestones.length < 1) {
    errs.push('at least one milestone is required');
    return errs;
  }
  if (plan.milestones.length > LIMITS.maxMilestones) errs.push(`at most ${LIMITS.maxMilestones} milestones`);

  const ids = new Set<string>();
  for (const [i, m] of plan.milestones.entries()) {
    const at = `milestones[${i}]`;
    if (!m || typeof m !== 'object') { errs.push(`${at} must be an object`); continue; }
    if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errs.push(`${at}.id must match ${ID_RE.source}`);
    else if (ids.has(m.id)) errs.push(`${at}.id "${m.id}" is used twice`);
    else ids.add(m.id);
    str(m.title, `${at}.title`, 1, 80);
    if (typeof m.deliverable !== 'string' || m.deliverable.length > 300) errs.push(`${at}.deliverable must be at most 300 characters`);
    if (!Number.isInteger(m.durationDays) || m.durationDays < 0 || m.durationDays > LIMITS.maxDurationDays) errs.push(`${at}.durationDays must be an integer 0–${LIMITS.maxDurationDays}`);
    if (!Number.isInteger(m.amountMinor) || m.amountMinor <= 0 || m.amountMinor > LIMITS.maxAmountMinor) errs.push(`${at}.amount must be greater than 0 and at most ${LIMITS.maxAmountMinor / 100}. Every milestone is an invoice: merge a phase that has no payment of its own into the milestone that is billed`);
    if (!Number.isInteger(m.netDays) || m.netDays < 0 || m.netDays > LIMITS.maxNetDays) errs.push(`${at}.netDays must be an integer 0–${LIMITS.maxNetDays}`);
    if (!Array.isArray(m.dependsOn)) errs.push(`${at}.dependsOn must be an array`);
  }
  if (errs.length) return errs;

  for (const [i, m] of plan.milestones.entries()) {
    const seen = new Set<string>();
    for (const d of m.dependsOn) {
      const at = `milestones[${i}].dependsOn`;
      if (!d || typeof d.on !== 'string' || !ids.has(d.on)) errs.push(`${at} references unknown milestone "${String(d?.on)}"`);
      else if (d.on === m.id) errs.push(`${at} cannot reference itself`);
      else if (seen.has(d.on)) errs.push(`${at} lists "${d.on}" twice`);
      else seen.add(d.on);
      if (d && d.gate !== 'paid' && d.gate !== 'delivered') errs.push(`${at} gate must be "paid" or "delivered"`);
    }
  }
  if (errs.length) return errs;
  try {
    topoOrder(plan.milestones);
  } catch (e) {
    errs.push(e instanceof PlanCycleError ? e.message : String(e));
  }
  return errs;
}

export function planTotal(plan: Plan): Minor {
  return plan.milestones.reduce((s, m) => s + m.amountMinor, 0);
}

/** Every currency-marked amount written in a piece of text, in minor units. */
export function moneyMentions(text: string): Minor[] {
  const out: Minor[] = [];
  const re = /(?:(?:[$€£]|\b(?:USD|EUR|GBP|CAD|AUD)\s?)\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?([kK])?\b)|(?:\b(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s?([kK])?\s?(?:USD|EUR|GBP|CAD|AUD|dollars|euros|pounds)\b)|(?:\b(\d+(?:\.\d{1,2})?)[kK]\b)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[1] !== undefined ? `${m[1]}${m[2] ?? ''}${m[3] ?? ''}`
      : m[4] !== undefined ? `${m[4]}${m[5] ?? ''}${m[6] ?? ''}`
      : `${m[7]}k`;
    const v = parseHumanAmount(raw);
    if (v !== null) out.push(v);
  }
  return out;
}

/** The planner's raw proposal (tool-call arguments), before it becomes a `Plan`. */
export interface PlanDraft {
  title: string;
  client: { name: string; email: string | null };
  currency: CurrencyCode;
  /** The project total exactly as written in the brief, or null when the brief gives none. */
  statedTotal: string | null;
  /** Only when the brief states a start date. */
  startDate: string | null;
  milestones: {
    id: string;
    title: string;
    deliverable: string;
    durationDays: number;
    /** Decimal string in major units, e.g. "3600.00". */
    amount: string;
    netDays: number;
    dependsOn: { on: string; gate: GateKind }[];
  }[];
}

export interface GroundResult {
  plan?: Plan;
  /** Hard failures; fed back to the planner so it can correct itself. */
  errors: string[];
  warnings: PlanWarning[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Turn a planner draft into a Plan, refusing figures that are not grounded in the brief. */
export function groundDraft(draft: PlanDraft, brief: string, today: ISODate): GroundResult {
  const errors: string[] = [];
  const warnings: PlanWarning[] = [];
  const briefAmounts = new Set(moneyMentions(brief));
  const briefNorm = norm(brief);

  const amounts: (Minor | null)[] = draft.milestones.map((m) => parseHumanAmount(String(m.amount)));
  amounts.forEach((a, i) => {
    if (a === null) errors.push(`milestones[${i}].amount "${draft.milestones[i]!.amount}" is not a decimal amount like "3600.00"`);
  });

  let email = (draft.client.email ?? '').trim();
  if (email && !briefNorm.includes(email.toLowerCase())) {
    errors.push(`client.email "${email}" does not appear in the brief. Use null when the brief gives no email address.`);
    email = '';
  }

  let statedTotal: Minor | null = null;
  if (draft.statedTotal !== null && draft.statedTotal !== undefined && String(draft.statedTotal).trim() !== '') {
    statedTotal = parseHumanAmount(String(draft.statedTotal));
    if (statedTotal === null) errors.push(`statedTotal "${draft.statedTotal}" is not an amount`);
    else if (!briefAmounts.has(statedTotal)) {
      errors.push(`statedTotal ${draft.statedTotal} does not appear in the brief. Use null when the brief states no total.`);
      statedTotal = null;
    }
  }

  let startDate = today;
  if (draft.startDate) {
    if (!isISODate(draft.startDate)) errors.push(`startDate "${draft.startDate}" must be YYYY-MM-DD or null`);
    else if (draft.startDate < today) {
      warnings.push({ code: 'start_in_past', message: `The proposed start date ${draft.startDate} is in the past, so the plan starts today instead.` });
    } else startDate = draft.startDate;
  }

  if (errors.length) return { errors, warnings };

  const plan: Plan = {
    title: draft.title.trim(),
    client: { name: draft.client.name.trim(), email },
    currency: draft.currency,
    startDate,
    milestones: draft.milestones.map((m, i) => ({
      id: m.id,
      title: m.title.trim(),
      deliverable: (m.deliverable ?? '').trim(),
      durationDays: m.durationDays,
      amountMinor: amounts[i]!,
      netDays: m.netDays,
      dependsOn: m.dependsOn ?? [],
    })),
  };

  errors.push(...validatePlan(plan));
  const total = planTotal(plan);
  if (statedTotal !== null && total !== statedTotal) {
    errors.push(`Milestone amounts add up to ${formatMoney(total, plan.currency, { cents: true })} but statedTotal is ${formatMoney(statedTotal, plan.currency, { cents: true })}. They must be equal.`);
  }
  if (errors.length) return { errors, warnings };

  warnings.push(...planWarnings(plan, brief));
  return { plan, errors, warnings };
}

/** Warnings for a (possibly user-edited) plan against its brief. Recomputed on every edit. */
export function planWarnings(plan: Plan, brief: string): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const briefAmounts = new Set(moneyMentions(brief));
  const briefNorm = norm(brief);
  const total = planTotal(plan);
  const itemised = plan.milestones.every((m) => briefAmounts.has(m.amountMinor));
  if (!briefAmounts.has(total) && !itemised) {
    warnings.push({
      code: 'total_not_in_brief',
      message: `The plan totals ${formatMoney(total, plan.currency)}, a figure that does not appear in the brief. Check every amount before approving.`,
    });
  }
  if (!plan.client.email) {
    warnings.push({ code: 'email_missing', message: 'The brief gives no client email. Add one before approving; invoices need a recipient.' });
  } else if (!briefNorm.includes(plan.client.email.toLowerCase())) {
    warnings.push({ code: 'email_not_in_brief', message: `The client email ${plan.client.email} does not appear in the brief.` });
  }
  if (plan.client.name && !briefNorm.includes(norm(plan.client.name))) {
    warnings.push({ code: 'client_not_in_brief', message: `The client name "${plan.client.name}" does not appear in the brief.` });
  }
  return warnings;
}

/** What still stops a draft from being approved. Empty = approvable. */
export function approvalBlockers(plan: Plan): string[] {
  const errs = validatePlan(plan);
  if (!plan.client?.email) errs.push('Add the client email before approving.');
  return errs;
}

/** JSON Schema for the planner's `propose_plan` tool. `additionalProperties: false` everywhere. */
export const PROPOSE_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'client', 'currency', 'statedTotal', 'startDate', 'milestones'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 120, description: 'Short project title.' },
    client: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'email'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 80, description: 'Client name exactly as written in the brief.' },
        email: { type: ['string', 'null'], description: 'Client email exactly as written in the brief, or null if the brief has none.' },
      },
    },
    currency: { type: 'string', enum: [...CURRENCIES] },
    statedTotal: { type: ['string', 'null'], description: 'The project total exactly as written in the brief (e.g. "$12,000"), or null if the brief states none.' },
    startDate: { type: ['string', 'null'], description: 'YYYY-MM-DD, only if the brief states a start date; otherwise null.' },
    milestones: {
      type: 'array',
      minItems: 1,
      maxItems: LIMITS.maxMilestones,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'deliverable', 'durationDays', 'amount', 'netDays', 'dependsOn'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,23}$', description: 'm1, m2, …' },
          title: { type: 'string', minLength: 1, maxLength: 80 },
          deliverable: { type: 'string', maxLength: 300, description: 'What the client receives.' },
          durationDays: { type: 'integer', minimum: 0, maximum: LIMITS.maxDurationDays, description: 'Working days of effort. 0 for a billing-only milestone such as a deposit.' },
          amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,2})?$', description: 'Invoice amount in major units as a decimal string, e.g. "3600.00".' },
          netDays: { type: 'integer', minimum: 0, maximum: LIMITS.maxNetDays, description: 'Payment term in calendar days.' },
          dependsOn: {
            type: 'array',
            maxItems: LIMITS.maxMilestones,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['on', 'gate'],
              properties: {
                on: { type: 'string', description: 'id of the upstream milestone' },
                gate: { type: 'string', enum: ['paid', 'delivered'], description: '"paid": start only after the upstream invoice is paid. "delivered": start after the upstream work is delivered.' },
              },
            },
          },
        },
      },
    },
  },
} as const;
