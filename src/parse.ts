// Deterministic command grammar — the always-works fast path and the offline
// fallback. Conversational understanding lives in engine/brain.ts; this file
// stays zero-AI so the core loop never depends on model availability.

import type { AppEnv } from './env';
import { incrementSettingBelow } from './db';
import { extractDayWord, extractTrailingTime } from './time';

export type NagLevel = 'gentle' | 'standard' | 'relentless';

export type Command =
  | { op: 'done'; taskRef?: number }
  | { op: 'start'; taskRef?: number }
  | { op: 'snooze'; minutes: number; taskRef?: number }
  | { op: 'tomorrow'; taskRef?: number }
  | { op: 'notdone'; taskRef?: number }
  | { op: 'blocked'; reason: string; taskRef?: number }
  | { op: 'drop'; taskRef?: number; reason?: string }
  | { op: 'add'; title: string; time: string | null; daysAhead?: number }
  | { op: 'plan' }
  | { op: 'noplan' }
  | { op: 'status' }
  | { op: 'undo' }
  | { op: 'help' }
  | { op: 'settings' }
  | { op: 'resetmemory' }
  | { op: 'resync' }
  | { op: 'gmaildigest' }
  | { op: 'persona'; directive: string }
  | { op: 'personaclear' }
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
    const { rest, daysAhead } = extractDayWord(m[1] ?? '');
    const { title, time } = extractTrailingTime(rest);
    return { op: 'add', title, time, ...(daysAhead ? { daysAhead } : {}) };
  }
  if (/^plan[.!]*$/i.test(t)) return { op: 'plan' };
  if (/^no\s*plan(?:\s*today)?[.!]*$/i.test(t)) return { op: 'noplan' };
  if (/^(?:status|list|left|what'?s left)[?.!]*$/i.test(t)) return { op: 'status' };
  if (/^undo[.!]*$/i.test(t)) return { op: 'undo' };
  if (/^(?:help|\?|commands)[?.!]*$/i.test(t)) return { op: 'help' };
  if (/^settings[?.!]*$/i.test(t)) return { op: 'settings' };
  if (/^reset\s+(?:memory|brain)[.!]*$/i.test(t)) return { op: 'resetmemory' };
  if (/^(?:learn now|re-?learn( me)?|resync|study me|re-?read me)[.!]*$/i.test(t)) return { op: 'resync' };
  if (/^(?:check (?:my )?email|email digest|check (?:my )?inbox|check gmail)[?.!]*$/i.test(t)) return { op: 'gmaildigest' };
  if (/^(?:persona\s+off|be\s+yourself|reset\s+persona)[.!]*$/i.test(t)) return { op: 'personaclear' };
  if ((m = /^persona[:\s]\s*(.+)$/i.exec(text))) return { op: 'persona', directive: (m[1] ?? '').trim() };
  // "be a hardass with me" / "be my drill sergeant" — store the owner's whole
  // sentence verbatim; it already reads as an instruction to Donna. Bare
  // "be <adjective>" ("be chill") deliberately falls through to the brain,
  // which catches any phrasing via the set_persona action.
  if (/^be\s+(?:a|an|my)\s+.+$/i.test(t)) return { op: 'persona', directive: text.trim() };
  if ((m = /^nag\s+(gentle|standard|relentless)$/i.exec(t))) {
    return { op: 'naglevel', level: m[1] as NagLevel };
  }
  if (
    /^(?:ok|okay|k|kk|yes|yep|yup|ya|yeah|yah|sure|aight|ight|alright|alr|bet|word|sounds good|looks good|lgtm|approve[d]?|confirm(?:ed)?|👍)[.!]*$/i.test(
      t,
    )
  )
    return { op: 'ok' };

  return { op: 'freetext', text };
}

// Shared daily AI-call budget (used by engine/brain.ts).
export async function aiBudgetOk(env: AppEnv, localDate: string): Promise<boolean> {
  const cap = Number(env.AI_DAILY_CAP || '40');
  const key = `ai_calls_${localDate}`;
  return incrementSettingBelow(env.DB, key, cap);
}
