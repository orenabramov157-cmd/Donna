import { describe, expect, it } from 'vitest';
import { validateInterpretation } from '../src/engine/brain';

const TODAY = '2026-07-24';

describe('validateInterpretation', () => {
  it('parses a multi-task add from one message', () => {
    const raw = JSON.stringify({
      actions: [
        { type: 'add_task', title: 'team meeting', remind_time: '15:00' },
        { type: 'add_task', title: 'send invoice', due_time: '17:00' },
        { type: 'add_task', title: 'finish the deck', due_date: '2026-07-26' },
      ],
      reply: 'Got all three. Meeting at 3, invoice by 5, deck by Sunday.',
      question: null,
      confidence: 0.92,
    });
    const r = validateInterpretation(raw, 0, TODAY);
    expect(r).not.toBeNull();
    expect(r!.actions).toHaveLength(3);
    expect(r!.actions[0]).toMatchObject({ type: 'add_task', title: 'team meeting', remind_time: '15:00' });
    expect(r!.actions[1]).toMatchObject({ type: 'add_task', due_time: '17:00' });
    expect(r!.actions[2]).toMatchObject({ type: 'add_task', due_date: '2026-07-26' });
    expect(r!.reply).toContain('all three');
  });

  it('captures a relative reminder offset (the 24h→5min bug)', () => {
    const raw = JSON.stringify({
      actions: [{ type: 'add_task', title: 'renew registration', remind_in_minutes: 1440 }],
      reply: null,
      question: null,
      confidence: 0.9,
    });
    const r = validateInterpretation(raw, 0, TODAY);
    expect(r!.actions[0]).toMatchObject({ type: 'add_task', remind_in_minutes: 1440, remind_time: null });
  });

  it('rejects absurd offsets but keeps the task', () => {
    const raw = JSON.stringify({
      actions: [{ type: 'add_task', title: 'x', remind_in_minutes: 0, due_in_minutes: 9_999_999 }],
      reply: null,
      question: null,
      confidence: 0.9,
    });
    const r = validateInterpretation(raw, 0, TODAY);
    expect(r!.actions[0]).toMatchObject({ title: 'x', remind_in_minutes: null, due_in_minutes: null });
  });

  it('extracts JSON wrapped in prose', () => {
    const raw = `Sure! Here you go:\n{"actions":[{"type":"complete","task":2}],"reply":"done","question":null,"confidence":0.9}\nHope that helps!`;
    const r = validateInterpretation(raw, 3, TODAY);
    expect(r!.actions[0]).toEqual({ type: 'complete', task: 2 });
  });

  it('drops out-of-range task references instead of guessing', () => {
    const raw = JSON.stringify({
      actions: [
        { type: 'complete', task: 5 },
        { type: 'complete', task: 1 },
      ],
      reply: null,
      question: null,
      confidence: 0.9,
    });
    const r = validateInterpretation(raw, 2, TODAY);
    expect(r!.actions).toEqual([{ type: 'complete', task: 1 }]);
  });

  it('clamps past due dates to today', () => {
    const raw = JSON.stringify({
      actions: [{ type: 'add_task', title: 'x', due_date: '2026-07-20', due_time: null, remind_time: null }],
      reply: null,
      question: null,
      confidence: 0.8,
    });
    const r = validateInterpretation(raw, 0, TODAY);
    expect(r!.actions[0]).toMatchObject({ due_date: TODAY });
  });

  it('rejects malformed times and keeps the task', () => {
    const raw = JSON.stringify({
      actions: [{ type: 'add_task', title: 'call sam', due_time: '5pm', remind_time: '25:99' }],
      reply: null,
      question: null,
      confidence: 0.8,
    });
    const r = validateInterpretation(raw, 0, TODAY);
    expect(r!.actions[0]).toMatchObject({ title: 'call sam', due_time: null, remind_time: null });
  });

  it('passes through a pure-chat reply with no actions', () => {
    const raw = JSON.stringify({ actions: [], reply: 'lol you got this', question: null, confidence: 0.9 });
    const r = validateInterpretation(raw, 0, TODAY);
    expect(r!.actions).toHaveLength(0);
    expect(r!.reply).toBe('lol you got this');
  });

  it('passes through a clarifying question', () => {
    const raw = JSON.stringify({ actions: [], reply: null, question: 'Which one — the invoice or the deck?', confidence: 0.4 });
    const r = validateInterpretation(raw, 2, TODAY);
    expect(r!.question).toContain('Which one');
  });

  it('returns null on garbage', () => {
    expect(validateInterpretation('no json here at all', 0, TODAY)).toBeNull();
    expect(validateInterpretation('{"actions": "not an array"}', 0, TODAY)).toBeNull();
  });

  it('drops unknown action types', () => {
    const raw = JSON.stringify({
      actions: [{ type: 'launch_missiles' }, { type: 'status' }],
      reply: null,
      question: null,
      confidence: 0.9,
    });
    const r = validateInterpretation(raw, 0, TODAY);
    expect(r!.actions).toEqual([{ type: 'status' }]);
  });

  it('validates snooze minutes with sane clamping', () => {
    const raw = JSON.stringify({
      actions: [{ type: 'snooze', task: 1, minutes: 9999 }],
      reply: null,
      question: null,
      confidence: 0.9,
    });
    const r = validateInterpretation(raw, 1, TODAY);
    expect(r!.actions[0]).toEqual({ type: 'snooze', task: 1, minutes: 480 });
  });
});
