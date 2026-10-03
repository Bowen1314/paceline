import type { ISODate, Plan, PlanWarning, PlannerKind } from '../contract.ts';
import type { Facts } from '../guard.ts';
import type { ProseKind } from '../prose.ts';

export interface PlanProposal {
  plan: Plan;
  warnings: PlanWarning[];
  /** Who actually drafted it, when that differs from the planner's kind (a model planner that fell back to the rules). */
  by?: PlannerKind;
}

/** A request for prose. The planner never receives anything but facts, and its output is checked against them. */
export interface WriteTask {
  kind: ProseKind;
  /** Plain-language description of what happened, built from facts only. */
  situation: string;
  /** The deterministic text; the model may rephrase it but may not add figures. */
  template: string;
  facts: Facts;
  /** Set on a retry: what the guard rejected last time. */
  rejected?: string;
}

export interface ReminderDraft {
  subject: string;
  note: string;
}

export class PlannerError extends Error {
  constructor(message: string, public readonly details: string[] = []) {
    super(message);
    this.name = 'PlannerError';
  }
}

/**
 * The model could not be used at all (an HTTP error such as 402 or 503, a network failure, a timeout).
 * That is not a bad plan, so a caller that has a fallback may use it; the message says what happened.
 */
export class ModelUnavailable extends PlannerError {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailable';
  }
}

export interface Planner {
  readonly kind: PlannerKind;
  readonly model?: string;
  /** Draft a milestone plan from a brief. Must return a plan that passed `groundDraft`. */
  proposePlan(brief: string, today: ISODate, onStep?: (label: string) => void): Promise<PlanProposal>;
  /** Write an explanation, or return null to use the template. Output is guarded by the caller. */
  write(task: WriteTask): Promise<string | null>;
  /** Draft a payment reminder, or return null to use the template. Output is guarded by the caller. */
  draftReminder(task: WriteTask): Promise<ReminderDraft | null>;
}
