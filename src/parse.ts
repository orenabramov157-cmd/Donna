// Reply understanding. Deterministic grammar first — it always works, costs
// nothing, and is the documented command set. Workers AI expands coverage to
// natural language but is capped per day and never trusted below a
// confidence floor; on any failure the engine asks for keywords.

import type { AppEnv } from './env';
import { getSetting, setSetting, type TaskRow } from './db';
import { extractTrailingTime } from './time';

export type NagLevel = 'gentle' | 'standard' | 'relentless';

export type Command =
  | { op: 'done'; taskRef?: number }
  | { op: 'start'; taskRef?: number }
  | { op: 'snooze'; minutes: number; taskRef?: number }
  | { op: 'tomorrow'; taskRef?: number }
  | { op: 'notdone'; taskRef?: number }
  | { op: 'blocked'; reason: string; taskRef?: number }
  | { op: 'drop'; taskRef?: number; reason?: string }
  | { op: 'add'; title: string; time: string | null }
  | { op: 'plan' }
  | { op: 'noplan' }
  | { op: 'status' }
  | { op: 'undo' }
  | { op: 'help' }
  | { op: 'settings' }
  | { op: 'naglevel'; level: NagLevel }
  | { op: 'ok' }
  | { op: 'freetext'; text: string };

const refNum = (s: string | undefined): number | undefined => (s ? Number(s) : undefined);

export function parseDeterministic(raw: string): Command {
  const text = raw.trim();
  const t = text.toLowerCase();

  let m: RegExpExecArray | null;
  if ((m = /^(?:done|d|did it|finished|complete[d]?)\s*(\d+)?[.!]*$/i.exec(t)))
    return { op: 'done', taskRef: refNum(m[1]) };
  if ((m = /^(?:start|starting|on it|going)\s*(\d+)?[.!]*$/i.exec(t))) return { op: 'start', taskRef: refNum(m[1]) };
  if ((m = /^snooze\s*(\d+)?\s*m?(?:in(?:ute)?s?)?\s*(\d+)?$/i.exec(t))) {
    const minutes = m[1] ? Number(m[1]) : 30;
    return { op: 'snooze', minutes: Math.max(5, Math.min(minutes, 480)), taskRef: refNum(m[2]) };
  }
  if ((m = /^(?:tomorrow|tmrw|tmr)\s*(\d+)?[.!]*$/i.exec(t))) return { op: 'tomorrow', taskRef: refNum(m[1]) };
  if (/^(?:not\s*done|not\s*yet|nope|didn'?t|no)\s*(\d+)?[.!]*$/i.test(t)) {
    const n = /(\d+)/.exec(t);
    return { op: 'notdone', taskRef: refNum(n?.[1]) };
  }
  // Reason-capturing commands run against the original text to preserve case.
  if ((m = /^blocked\s*(\d+)?\s*[:,-]?\s*(.*)$/i.exec(text))) {
    return { op: 'blocked', taskRef: refNum(m[1]), reason: (m[2] ?? '').trim() || 'unspecified' };
  }
  if ((m = /^(?:skip|drop)\s*(\d+)?\s*[:,-]?\s*(.*)$/i.exec(text))) {
    const reason = (m[2] ?? '').trim();
    return { op: 'drop', taskRef: refNum(m[1]), ...(reason ? { reason } : {}) };
  }
  if ((m = /^add[:\s]\s*(.+)$/i.exec(text))) {
    const { title, time } = extractTrailingTime(m[1] ?? '');
    return { op: 'add', title, time };
  }
  if (/^plan[.!]*$/i.test(t)) return { op: 'plan' };
  if (/^no\s*plan(?:\s*today)?[.!]*$/i.test(t)) return { op: 'noplan' };
  if (/^(?:status|list|left|what'?s left)[?.!]*$/i.test(t)) return { op: 'status' };
  if (/^undo[.!]*$/i.test(t)) return { op: 'undo' };
  if (/^(?:help|\?|commands)[?.!]*$/i.test(t)) return { op: 'help' };
  if (/^settings[?.!]*$/i.test(t)) return { op: 'settings' };
  if ((m = /^nag\s+(gentle|standard|relentless)$/i.exec(t))) {
    return { op: 'naglevel', level: m[1] as NagLevel };
  }
  if (/^(?:ok|okay|yes|yep|yeah|approve[d]?|confirm(?:ed)?|looks good|lgtm|👍)[.!]*$/i.test(t)) return { op: 'ok' };

  return { op: 'freetext', text };
}

// -- Workers AI fallback ----------------------------------------------------

const AI_OPS = new Set([
  'done',
  'start',
  'snooze',
  'tomorrow',
  'notdone',
  'blocked',
  'drop',
  'add',
  'plan',
  'status',
  'undo',
  'help',
]);

export async function aiBudgetOk(env: AppEnv, localDate: string): Promise<boolean> {
  const cap = Number(env.AI_DAILY_CAP || '40');
  const key = `ai_calls_${localDate}`;
  const used = Number((await getSetting(env.DB, key)) ?? '0');
  if (used >= cap) return false;
  await setSetting(env.DB, key, String(used + 1));
  return true;
}

export async function aiInterpret(
  env: AppEnv,
  localDate: string,
  text: string,
  tasks: TaskRow[],
): Promise<Command | null> {
  if (!(await aiBudgetOk(env, localDate))) return null;
  const list = tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n') || '(no open tasks)';
  const system = [
    'You convert one incoming text message into ONE JSON command for a personal task-accountability bot.',
    'Open tasks:',
    list,
    'Output ONLY compact JSON, no prose:',
    '{"op":"done|start|snooze|tomorrow|notdone|blocked|drop|add|status|freetext","taskRef":<1-based task number or null>,"minutes":<int or null>,"reason":<string or null>,"title":<string or null>,"time":"HH:MM or null","confidence":<0..1>}',
    'op=done when the message reports finishing a task (match by meaning). op=add when it describes a new task.',
    'If you are not sure what the message means, use op="freetext" with low confidence.',
  ].join('\n');
  try {
    const out: unknown = await env.AI.run(
      (env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast') as Parameters<Ai['run']>[0],
      {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        max_tokens: 160,
      },
    );
    const response =
      out && typeof out === 'object' && 'response' in out && typeof (out as { response: unknown }).response === 'string'
        ? (out as { response: string }).response
        : null;
    if (!response) return null;
    const jsonMatch = /\{[\s\S]*\}/.exec(response);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const op = typeof parsed.op === 'string' ? parsed.op : '';
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
    if (!AI_OPS.has(op) || confidence < 0.7) return null;
    const taskRef =
      typeof parsed.taskRef === 'number' && parsed.taskRef >= 1 && parsed.taskRef <= tasks.length
        ? parsed.taskRef
        : undefined;
    switch (op) {
      case 'done':
        return { op: 'done', taskRef };
      case 'start':
        return { op: 'start', taskRef };
      case 'snooze':
        return {
          op: 'snooze',
          minutes: typeof parsed.minutes === 'number' && parsed.minutes >= 5 ? Math.min(parsed.minutes, 480) : 30,
          taskRef,
        };
      case 'tomorrow':
        return { op: 'tomorrow', taskRef };
      case 'notdone':
        return { op: 'notdone', taskRef };
      case 'blocked':
        return { op: 'blocked', reason: typeof parsed.reason === 'string' ? parsed.reason : 'unspecified', taskRef };
      case 'drop': {
        const reason = typeof parsed.reason === 'string' && parsed.reason ? parsed.reason : undefined;
        return { op: 'drop', taskRef, ...(reason ? { reason } : {}) };
      }
      case 'add': {
        const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null;
        if (!title) return null;
        const time = typeof parsed.time === 'string' && /^\d{2}:\d{2}$/.test(parsed.time) ? parsed.time : null;
        return { op: 'add', title, time };
      }
      case 'status':
        return { op: 'status' };
      default:
        return null;
    }
  } catch (err) {
    console.error(JSON.stringify({ evt: 'ai_interpret_failed', err: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
