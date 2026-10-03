/**
 * The model-backed planner: NVIDIA Nemotron on Nebius Token Factory
 * (OpenAI-compatible chat completions).
 *
 * What the model is allowed to do:
 *  - propose a plan by calling `propose_plan`; the arguments are validated
 *    against the JSON Schema and then grounded against the brief. Errors go
 *    back to the model, at most MAX_ATTEMPTS rounds;
 *  - rephrase an explanation or draft a reminder from a list of facts; the
 *    engine runs the no-invention guard on whatever comes back.
 * It has no tool that reads or writes PayPal.
 */
import type { ISODate, LedgerIntent } from '../../shared/contract.ts';
import { LIMITS } from '../../shared/contract.ts';
import { formatDate } from '../../shared/dates.ts';
import type { Facts } from '../../shared/guard.ts';
import { formatMoney } from '../../shared/money.ts';
import { PROPOSE_PLAN_SCHEMA, groundDraft, type PlanDraft } from '../../shared/plan.ts';
import { ModelUnavailable, PlannerError, type PlanProposal, type Planner, type ReminderDraft, type WriteTask } from '../../shared/planner/types.ts';
import { NEBIUS_BASE_URL } from '../config.ts';
import type { FetchLike } from '../paypal/sandbox.ts';
import { validateArgs, validateToolCall, type ToolCallIn, type ToolDef } from '../toolcall.ts';

const MAX_ATTEMPTS = 3;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: (ToolCallIn & { type?: string })[];
  tool_call_id?: string;
}

interface ChatResponse {
  choices?: { message?: ChatMessage; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface NebiusOptions {
  apiKey: string;
  model: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const PLAN_TOOL: ToolDef = {
  name: 'propose_plan',
  description: 'Propose a milestone billing plan for the brief. Call exactly once.',
  parameters: PROPOSE_PLAN_SCHEMA,
};

const PLAN_SYSTEM = `You are the planning agent of Paceline, a tool for freelancers who bill by milestone.
Read the client brief and propose a milestone plan by calling the propose_plan tool. Reply only with that tool call.

Rules:
- Never invent figures. statedTotal must be the project total exactly as written in the brief, or null if the brief states none. The milestone amounts must add up to statedTotal exactly.
- client.name and client.email must be copied from the brief. Use null for the email if the brief has none.
- startDate is null unless the brief states a start date.
- Every milestone is one invoice, so every amount is greater than 0. Follow the payment schedule in the brief: if it lists a price per item, use exactly those prices; if it says something like "half up front, the rest on launch", create exactly those payments and merge phases that have no payment of their own into the milestone that is billed.
- When the brief gives only a total, split what remains after any deposit across the deliverables in proportion to their effort, in round amounts (multiples of 50), and put any remainder on the last milestone.
- 3 to 6 milestones is typical. If the brief mentions a deposit or an upfront percentage, make the first milestone a billing-only milestone with durationDays 0.
- durationDays are working days (1 week = 5). Use the durations in the brief when given; otherwise estimate sensibly.
- netDays is the payment term in calendar days: use the brief's terms (e.g. "net 14" = 14), otherwise 7.
- Each milestone normally depends on the previous one with gate "paid": its work starts only after the previous invoice is paid. Use gate "delivered" only when the brief says work may continue before payment. The first milestone has no dependencies.
- ids are m1, m2, m3… in order. Use only the arguments defined in the tool schema.`;

const WRITE_SYSTEM = `You write short status notes for Paceline, a milestone-billing tool. You will be given the facts of what just happened and a plain draft.
Rewrite the draft in a clear, warm, professional voice: 2 to 4 sentences, plain text, no markdown, no lists, no greeting.

Hard rules:
- Use only figures that appear in the FACTS: amounts, dates, invoice numbers, day counts. Copy them exactly as written. Do not compute, round, convert or add any number, date, percentage or id.
- Write dates in the short form (for example "Sep 3"), never the ISO form shown in brackets.
- Do not state an invoice status other than the ones listed as allowed status words.
- Keep the meaning of the draft exactly: what happened, in which order, and which date moved to which. "Slips from A to B" means the date was A and is now B.
- Do not promise actions. Nothing is sent to PayPal or to the client without the user's approval.`;

const REMINDER_SYSTEM = `You draft payment reminders that a freelancer will review before sending through PayPal.
Return a JSON object {"subject": string, "note": string} and nothing else. The note is 2 to 4 friendly, firm sentences addressed to the client by name. No markdown.

Hard rules:
- Use only figures that appear in the FACTS (amounts, dates, invoice numbers), copied exactly. Do not add any other number, date or id, and do not mention how many days late the invoice is unless that count is in the FACTS.
- Write dates in the short form (for example "Sep 28"), never the ISO form shown in brackets. The date the invoice was due is its due date, not its issue date.
- Do not use the words "paid", "sent", "cancelled", "refunded" or "pending". You may say "overdue" or "unpaid".
- Do not threaten, add late fees, or mention anything not in the FACTS.`;

/** The facts as the model sees them: explicit, formatted lists. */
export function renderFacts(f: Facts): string {
  const dates = [...f.dates].sort().map((d) => `${formatDate(d)} (${d})`);
  return [
    `Names: ${[...f.names].join('; ') || '(none)'}`,
    `Amounts: ${[...f.amountsMinor].sort((a, b) => a - b).map((a) => formatMoney(a)).join(', ') || '(none)'}`,
    `Dates: ${dates.join(', ') || '(none)'}`,
    `Invoice numbers and ids: ${[...f.ids].join(', ') || '(none)'}`,
    `Counts you may use: ${[...f.numbers].sort((a, b) => a - b).join(', ') || '(none)'}`,
    `Allowed status words: ${[...f.statuses].join(', ') || '(none)'}`,
  ].join('\n');
}

export class NebiusPlanner implements Planner {
  readonly kind = 'nebius' as const;
  readonly model: string;
  readonly usage: Usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly opts: NebiusOptions) {
    this.model = opts.model;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async chat(body: Record<string, unknown>): Promise<ChatMessage> {
    let res: Response;
    try {
      res = await this.fetch(new URL('chat/completions', NEBIUS_BASE_URL).toString(), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, temperature: 0.2, ...body }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof PlannerError) throw e; // the spend guard's own refusal passes through unchanged
      throw new ModelUnavailable(`The planning model could not be reached (${(e as Error).name || 'network error'}).`);
    }
    const json = (await res.json().catch(() => ({}))) as ChatResponse;
    if (!res.ok) throw new ModelUnavailable(`The planning model returned HTTP ${res.status}${json.error?.message ? `: ${json.error.message.slice(0, 200)}` : ''}.`);
    this.usage.calls += 1;
    this.usage.promptTokens += json.usage?.prompt_tokens ?? 0;
    this.usage.completionTokens += json.usage?.completion_tokens ?? 0;
    const message = json.choices?.[0]?.message;
    if (!message) throw new PlannerError('The planning model returned an empty response.');
    return message;
  }

  async proposePlan(brief: string, today: ISODate, onStep?: (label: string) => void): Promise<PlanProposal> {
    const tools = [PLAN_TOOL];
    const messages: ChatMessage[] = [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: `Today is ${today}.\n\nBRIEF:\n${brief.slice(0, LIMITS.briefMaxChars)}` },
    ];
    let lastErrors: string[] = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      onStep?.(attempt === 1 ? `Asking ${this.model.split('/').pop()} for a plan` : `Plan rejected by validation; asking the model to correct it (attempt ${attempt})`);
      const reply = await this.chat({
        messages,
        tools: tools.map((t) => ({ type: 'function', function: t })),
        tool_choice: { type: 'function', function: { name: PLAN_TOOL.name } },
        max_tokens: 4000,
      });
      const call = reply.tool_calls?.[0];
      const callId = call?.id ?? `call_${attempt}`;
      messages.push({ role: 'assistant', content: reply.content ?? null, tool_calls: call ? [{ ...call, id: callId, type: 'function' }] : undefined });
      const feedback = (error: string): void => {
        lastErrors = [error];
        if (call) messages.push({ role: 'tool', tool_call_id: callId, content: JSON.stringify({ error }) });
        else messages.push({ role: 'user', content: `${error} Call the propose_plan tool.` });
      };
      if (!call) {
        feedback('You did not call a tool.');
        continue;
      }
      const checked = validateToolCall<PlanDraft>(call, tools);
      if (!checked.ok) {
        feedback(checked.error);
        continue;
      }
      onStep?.('Checking every figure against the brief');
      const grounded = groundDraft(checked.args, brief, today);
      if (grounded.plan) return { plan: grounded.plan, warnings: grounded.warnings };
      feedback(`The plan was rejected: ${grounded.errors.slice(0, 8).join(' ')} Call propose_plan again with corrected arguments.`);
      lastErrors = grounded.errors;
    }
    throw new PlannerError(`The model could not produce a valid plan in ${MAX_ATTEMPTS} attempts.`, lastErrors);
  }

  async write(task: WriteTask): Promise<string | null> {
    const reply = await this.chat({
      messages: [
        { role: 'system', content: WRITE_SYSTEM },
        {
          role: 'user',
          content: `FACTS\n${renderFacts(task.facts)}\n\nDRAFT\n${task.template}${task.rejected ? `\n\nYour previous version was rejected because it contained figures that are not in the FACTS: ${task.rejected}. Remove them.` : ''}`,
        },
      ],
      max_tokens: 1500,
    });
    const text = (reply.content ?? '').trim();
    return text.length > 0 && text.length < 1200 ? text : null;
  }

  async draftReminder(task: WriteTask): Promise<ReminderDraft | null> {
    const reply = await this.chat({
      messages: [
        { role: 'system', content: REMINDER_SYSTEM },
        { role: 'user', content: `FACTS\n${renderFacts(task.facts)}\n\nSITUATION\n${task.situation}${task.rejected ? `\n\nYour previous draft was rejected for: ${task.rejected}.` : ''}` },
      ],
      max_tokens: 1500,
    });
    const raw = (reply.content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    try {
      const parsed: unknown = JSON.parse(raw);
      const ok = validateArgs<ReminderDraft>(
        { type: 'object', additionalProperties: false, required: ['subject', 'note'], properties: { subject: { type: 'string', minLength: 5, maxLength: 200 }, note: { type: 'string', minLength: 20, maxLength: 1200 } } },
        parsed,
      );
      return ok.ok ? ok.value : null;
    } catch {
      return null;
    }
  }

  /** Natural-language ledger request -> typed intent, validated against the schema. Null = use the rules. */
  async ledgerIntent(query: string, ctx: { today: ISODate; clients: string[]; projects: string[] }): Promise<{ intent: LedgerIntent; explanation: string } | null> {
    const tools = [LEDGER_TOOL];
    const messages: ChatMessage[] = [
      { role: 'system', content: `You translate a request about an invoice ledger into a call to set_ledger_view. Today is ${ctx.today}. Amounts are integers in cents (e.g. $500 = 50000). Known clients: ${ctx.clients.join('; ') || 'none'}. Known projects: ${ctx.projects.join('; ') || 'none'}. "unpaid"/"outstanding" means statuses awaiting and overdue. Use only the arguments defined in the schema. The view cannot limit the number of rows: for "top 3" or "the biggest", sort and describe it as sorted, without promising a count. If the request is not about the ledger, call the tool with understood=false.` },
      { role: 'user', content: query.slice(0, LIMITS.ledgerQueryMaxChars) },
    ];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const reply = await this.chat({ messages, tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: { type: 'function', function: { name: LEDGER_TOOL.name } }, max_tokens: 1500 });
      const call = reply.tool_calls?.[0];
      const checked = validateToolCall<{ understood: boolean; reset: boolean; filters: LedgerIntent['filters']; groupBy: LedgerIntent['groupBy']; sort: LedgerIntent['sort']; summary: string }>(call, tools);
      if (checked.ok) {
        if (!checked.args.understood) return null;
        const { filters, groupBy, sort, reset, summary } = checked.args;
        return { intent: { filters, groupBy, sort, reset }, explanation: summary };
      }
      const id = call?.id ?? `call_${attempt}`;
      messages.push({ role: 'assistant', content: null, tool_calls: call ? [{ ...call, id, type: 'function' }] : undefined });
      messages.push(call ? { role: 'tool', tool_call_id: id, content: JSON.stringify({ error: checked.error }) } : { role: 'user', content: checked.error });
    }
    return null;
  }
}

const COLS = ['number', 'client', 'project', 'milestone', 'status', 'amountMinor', 'balanceMinor', 'paidMinor', 'issuedOn', 'dueOn', 'paidOn', 'daysPastDue'];
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

const LEDGER_TOOL: ToolDef = {
  name: 'set_ledger_view',
  description: 'Set the filters, grouping and sorting of the invoice ledger grid.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['understood', 'reset', 'filters', 'groupBy', 'sort', 'summary'],
    properties: {
      understood: { type: 'boolean', description: 'false if the request cannot be expressed as a ledger view' },
      reset: { type: 'boolean', description: 'true to clear existing filters, grouping and sorting first (normally true)' },
      summary: { type: 'string', maxLength: 160, description: 'One short sentence describing the view in words. Do not include numbers that are not in the request.' },
      groupBy: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['client', 'project', 'status', 'milestone'] } },
      sort: {
        type: 'array', maxItems: 3,
        items: { type: 'object', additionalProperties: false, required: ['column', 'dir'], properties: { column: { type: 'string', enum: COLS }, dir: { type: 'string', enum: ['asc', 'desc'] } } },
      },
      filters: {
        type: 'array', maxItems: 6,
        items: {
          oneOf: [
            { type: 'object', additionalProperties: false, required: ['column', 'op', 'values'], properties: { column: { const: 'status' }, op: { const: 'in' }, values: { type: 'array', minItems: 1, items: { type: 'string', enum: ['planned', 'draft', 'awaiting', 'overdue', 'paid', 'cancelled', 'refunded'] } } } },
            { type: 'object', additionalProperties: false, required: ['column', 'op', 'value'], properties: { column: { type: 'string', enum: ['client', 'project', 'milestone', 'number'] }, op: { const: 'contains' }, value: { type: 'string', minLength: 1, maxLength: 80 } } },
            { type: 'object', additionalProperties: false, required: ['column', 'op', 'value'], properties: { column: { type: 'string', enum: ['amountMinor', 'balanceMinor', 'paidMinor', 'daysPastDue'] }, op: { type: 'string', enum: ['gt', 'lt', 'gte', 'lte', 'eq'] }, value: { type: 'integer' } } },
            { type: 'object', additionalProperties: false, required: ['column', 'op'], properties: { column: { type: 'string', enum: ['issuedOn', 'dueOn', 'paidOn'] }, op: { type: 'string', enum: ['before', 'after', 'between'] }, from: DATE, to: DATE } },
          ],
        },
      },
    },
  },
};
