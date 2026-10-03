import { describe, expect, it } from 'vitest';
import { checkProse, emptyFacts, mergeFacts, type Facts } from '../shared/guard.ts';
import { cancelTemplate, explainDelivery, explainOverdue, explainPayment, explainPlan, factsFor, issueRationale, reminderRationale, reminderTemplate } from '../shared/prose.ts';
import { activeProject, harness } from './helpers.ts';

const facts = (over: Partial<Facts> = {}): Facts =>
  mergeFacts(
    {
      amountsMinor: new Set([360_000, 1_200_000]),
      dates: new Set(['2026-10-14', '2026-11-09', '2026-11-12']),
      ids: new Set(['PL-AB12-003', 'INV2-SIM0-AAAA-BBBB-CCCC']),
      numbers: new Set([1, 2, 3, 7]),
      statuses: new Set(['paid']),
      emails: new Set(['ops@juniperandrye.example']),
      names: new Set(['Phase 2 build', 'Juniper & Rye']),
    },
    over,
  );

const kinds = (text: string, f: Facts = facts()): string[] => checkProse(text, f).map((v) => `${v.kind}:${v.text}`);

describe('no-invention guard: accepts text made only of known facts', () => {
  it.each([
    'PL-AB12-003 ($3,600) was paid on Oct 14.',
    'Invoice PL-AB12-003 for $3,600.00 was paid on October 14, 2026.',
    'Delivery moves from Nov 9 to Nov 12, 3 days later.',
    'The total is $12k across 3 milestones, due 2026-10-14.',
    'USD 3,600 arrived; 3600 USD is the full amount.',
    'Work on "Phase 2 build" starts now.', // the 2 belongs to a known name
    'Emailed to ops@juniperandrye.example.',
    'It was paid 7 days early. Two milestones remain.',
    'Paid on 10/14 and delivered by 11/12/2026.',
    'No figures here at all, just a friendly sentence.',
    'INV2-SIM0-AAAA-BBBB-CCCC is the PayPal id.',
  ])('%s', (text) => expect(kinds(text)).toEqual([]));
});

describe('no-invention guard: rejects every kind of invented figure', () => {
  it.each([
    ['an amount', 'PL-AB12-003 ($3,650) was paid.', ['amount:$3,650']],
    ['an amount off by a cent', 'It was $3,600.01.', ['amount:$3,600.01']],
    ['a rounded amount', 'Roughly $4k was paid.', ['amount:$4k']],
    ['an amount with a currency word', 'They paid 500 dollars.', ['amount:500 dollars']],
    ['a date', 'It was paid on Oct 15.', ['date:Oct 15']],
    ['an ISO date', 'Delivery is 2026-11-10.', ['date:2026-11-10']],
    ['a right day in the wrong year', 'Paid on October 14, 2027.', ['date:October 14, 2027']],
    ['a numeric date', 'Paid on 10/16.', ['date:10/16']],
    ['a day-first date', 'Paid on 15 October.', ['date:15 October']],
    ['an impossible date', 'Due 2026-02-30.', ['date:2026-02-30']],
    ['an invoice number', 'PL-AB12-004 was paid.', ['id:PL-AB12-004']],
    ['a PayPal id', 'See INV2-ZZZZ-YYYY-XXXX-WWWW.', ['id:INV2-ZZZZ-YYYY-XXXX-WWWW']],
    ['a hash number', 'Invoice #0042 was paid.', ['id:#0042']],
    ['a day count', 'Delivery slips 5 days.', ['number:5']],
    ['a spelled-out count', 'Delivery slips five days.', ['number:five']],
    ['a percentage', 'That is 40% of the fee.', ['number:40']],
    ['an ordinal', 'This is the 4th reminder.', ['number:4th']],
    ['a status', 'The invoice is overdue.', ['status:overdue']],
    ['a status in another spelling', 'The invoice was canceled.', ['status:canceled']],
    ['an email address', 'Emailed to cfo@elsewhere.example.', ['email:cfo@elsewhere.example']],
  ])('%s', (_n, text, want) => expect(kinds(text)).toEqual(want));

  it('checks everyday words (sent, draft, scheduled, pending) only where they are stated as a status', () => {
    // Stated as a status: flagged unless PayPal reported it.
    expect(kinds('The invoice is still pending.')).toEqual(['status:pending']);
    expect(kinds('It was sent.')).toEqual(['status:sent']);
    expect(kinds('PL-AB12-003 is a draft.').filter((k) => k.startsWith('status'))).toEqual(['status:draft']);
    expect(kinds('It is marked as scheduled.')).toEqual(['status:scheduled']);
    // Ordinary English: not a status claim (seen in real model output and wrongly rejected before).
    expect(kinds('A reminder draft has been prepared for your review; nothing will be sent until you approve it.')).toEqual([]);
    expect(kinds('Delivery is now scheduled for a later date.')).toEqual([]);
    expect(kinds('The reminder will be sent to the client once you approve it.')).toEqual([]);
    // A date after "scheduled for" is still checked like any other date.
    expect(kinds('Delivery is now scheduled for Dec 25.')).toEqual(['date:Dec 25']);
  });

  it('reports every violation, not just the first', () => {
    expect(kinds('PL-ZZ99-001 for $99 is overdue since Dec 25, 12 days.')).toEqual(['id:PL-ZZ99-001', 'date:Dec 25', 'amount:$99', 'number:12', 'status:overdue']);
  });

  it('with no facts at all, any figure is a violation', () => {
    expect(checkProse('We agreed on $10 by Jan 1.', emptyFacts())).toHaveLength(2);
    expect(checkProse('We agreed on a price.', emptyFacts())).toEqual([]);
  });

  it('a number inside a known name is not a claim, but the same number elsewhere is', () => {
    const f = facts({ numbers: new Set() });
    f.numbers.clear();
    expect(kinds('"Phase 2 build" is next.', f)).toEqual([]);
    expect(kinds('"Phase 2 build" is next, in 2 days.', f)).toEqual(['number:2']);
  });
});

describe('deterministic prose passes its own guard', () => {
  it('plan, delivery, payment, overdue, reminder, cancel and proposal rationales', async () => {
    const { h, projectId } = await activeProject(harness());
    const ws = h.ws;
    const project = () => ws.data.projects.find((p) => p.id === projectId)!;
    const invoices = () => ws.data.invoices;
    const today = () => ws.today();
    const ok = (kind: Parameters<typeof factsFor>[0], text: string, change?: Parameters<typeof factsFor>[4]): void => {
      expect(checkProse(text, factsFor(kind, project(), invoices(), today(), change)), text).toEqual([]);
    };

    ok('plan', explainPlan(project()));
    for (const p of ws.data.proposals) ok('delivery', p.rationale);

    // deposit issued and paid -> payment explanation
    await h.approveNext('issue_invoice');
    const deposit = invoices()[0]!;
    await h.pay(deposit.id);
    const payRun = ws.data.runs.find((r) => r.kind === 'payment')!;
    expect(payRun.messageBy).toBe('template');
    ok('payment', payRun.message!, ws.data.lastChange);
    ok('payment', explainPayment(project(), invoices()[0]!, ws.data.lastChange!), ws.data.lastChange);

    // deliver m2, issue, let it go overdue -> overdue explanation + reminder
    h.clock.now = new Date('2026-10-12T15:00:00Z');
    await ws.tick();
    await ws.markDelivered(projectId, 'm2');
    const m2 = project().plan.milestones[1]!;
    ok('delivery', explainDelivery(project(), m2, project().schedule.items[1]!.dueOn));
    ok('delivery', issueRationale(project(), m2, project().schedule.items[1]!.dueOn, false));
    ok('cancel', issueRationale(project(), m2, project().schedule.items[1]!.dueOn, true));
    await h.approveNext('issue_invoice');
    h.clock.now = new Date('2026-10-23T15:00:00Z');
    await ws.tick();
    const inv2 = invoices().find((i) => i.milestoneId === 'm2')!;
    expect(inv2.overdue).toBe(true);
    const overdueRun = ws.data.runs.find((r) => r.kind === 'overdue')!;
    ok('overdue', overdueRun.message!, ws.data.lastChange);
    ok('overdue', explainOverdue(project(), inv2, ws.data.lastChange!), ws.data.lastChange);
    ok('overdue', reminderRationale(project(), inv2));
    const r = reminderTemplate(project(), inv2);
    ok('reminder', `${r.subject}\n${r.note}`);
    const c = cancelTemplate(project(), inv2);
    ok('cancel', `${c.subject}\n${c.note}`);
  });

  it('the same sentences fail the guard the moment one figure is changed', async () => {
    const { h, projectId } = await activeProject(harness());
    const project = h.ws.data.projects.find((p) => p.id === projectId)!;
    const f = factsFor('plan', project, [], h.ws.today());
    const text = explainPlan(project);
    expect(checkProse(text, f)).toEqual([]);
    expect(checkProse(text.replace('$12,000', '$12,500'), f).map((v) => v.kind)).toEqual(['amount']);
    expect(checkProse(text.replace('Nov 9', 'Nov 6'), f).map((v) => v.kind)).toEqual(['date']);
    expect(checkProse(text.replace('3 milestones', '4 milestones'), f).map((v) => v.kind)).toEqual(['number']);
  });
});
