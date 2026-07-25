// Donna's conversational brain (v1.1 "ears" + v1.2 "memory").
//
// One model call converts a free-text message into a validated list of typed
// actions plus an optional in-character reply. Context injected on every
// call: the numbered open-task list, recent conversation, plan state, local
// time, and the two learned profile cards (style + schedule insights) that
// the nightly reflection job maintains. The engine — not the model — mutates
// state; the model can only propose actions that survive validation here.

import type { AppEnv } from '../env';
import { aiBudgetOk } from '../parse';
import type { TaskRow } from '../db';
import type { LocalParts } from '../time';

export type BrainAction =
  | {
      type: 'add_task';
      title: string;
      start_date: string | null; // when Donna starts caring (default today)
      due_date: string | null; // hard deadline day
      due_time: string | null; // HH:MM on the deadline day
      remind_time: string | null; // HH:MM today to first nag
    }
  | { type: 'complete'; task: number }
  | { type: 'start'; task: number }
  | { type: 'notdone'; task: number }
  | { type: 'snooze'; task: number; minutes: number }
  | { type: 'defer'; task: number }
  | { type: 'drop'; task: number; reason: string | null }
  | { type: 'blocked'; task: number; reason: string }
  | { type: 'set_time'; task: number; time: string; date: string | null }
  | { type: 'status' }
  | { type: 'plan' }
  | { type: 'no_plan' }
  | { type: 'confirm_plan' }
  | { type: 'undo' }
  | { type: 'help' }
  | { type: 'set_nag'; level: 'gentle' | 'standard' | 'relentless' };

export interface Interpretation {
  actions: BrainAction[];
  reply: string | null;
  question: string | null;
  confidence: number;
}

const HHMM = /^\d{2}:\d{2}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function clampDate(date: string | null, todayLocal: string): string | null {
  if (!date || !YMD.test(date)) return null;
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return date < todayLocal ? todayLocal : date;
}

function validTime(v: unknown): string | null {
  const s = str(v);
  if (!s || !HHMM.test(s)) return null;
  const hh = Number(s.slice(0, 2));
  const mm = Number(s.slice(3, 5));
  return hh < 24 && mm < 60 ? s : null;
}

function taskRef(v: unknown, taskCount: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= taskCount ? v : null;
}

// Pure and unit-tested: tolerant JSON extraction + per-action validation.
// Invalid actions are dropped, never "fixed" into something the owner
// didn't say. Returns null only when nothing usable can be salvaged.
export function validateInterpretation(rawText: string, taskCount: number, todayLocal: string): Interpretation | null {
  const jsonMatch = /\{[\s\S]*\}/.exec(rawText);
  if (!jsonMatch) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: BrainAction[] = [];
  for (const raw of rawActions) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    switch (a.type) {
      case 'add_task': {
        const title = str(a.title);
        if (!title) break;
        actions.push({
          type: 'add_task',
          title: title.slice(0, 200),
          start_date: clampDate(str(a.start_date), todayLocal),
          due_date: clampDate(str(a.due_date), todayLocal),
          due_time: validTime(a.due_time),
          remind_time: validTime(a.remind_time),
        });
        break;
      }
      case 'complete':
      case 'start':
      case 'notdone':
      case 'defer': {
        const t = taskRef(a.task, taskCount);
        if (t !== null) actions.push({ type: a.type, task: t });
        break;
      }
      case 'snooze': {
        const t = taskRef(a.task, taskCount);
        const minutes =
          typeof a.minutes === 'number' && a.minutes >= 5 ? Math.min(Math.round(a.minutes), 480) : 30;
        if (t !== null) actions.push({ type: 'snooze', task: t, minutes });
        break;
      }
      case 'drop': {
        const t = taskRef(a.task, taskCount);
        if (t !== null) actions.push({ type: 'drop', task: t, reason: str(a.reason) });
        break;
      }
      case 'blocked': {
        const t = taskRef(a.task, taskCount);
        if (t !== null) actions.push({ type: 'blocked', task: t, reason: str(a.reason) ?? 'unspecified' });
        break;
      }
      case 'set_time': {
        const t = taskRef(a.task, taskCount);
        const time = validTime(a.time);
        if (t !== null && time) actions.push({ type: 'set_time', task: t, time, date: clampDate(str(a.date), todayLocal) });
        break;
      }
      case 'status':
      case 'plan':
      case 'no_plan':
      case 'confirm_plan':
      case 'undo':
      case 'help':
        actions.push({ type: a.type });
        break;
      case 'set_nag': {
        const level = str(a.level);
        if (level === 'gentle' || level === 'standard' || level === 'relentless') {
          actions.push({ type: 'set_nag', level });
        }
        break;
      }
      default:
        break;
    }
  }
  const reply = str(parsed.reply);
  const question = str(parsed.question);
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
  if (actions.length === 0 && !reply && !question) return null;
  return {
    actions,
    reply: reply ? reply.slice(0, 500) : null,
    question: question ? question.slice(0, 300) : null,
    confidence,
  };
}

// Workers AI models are not consistent about output shape: some return
// { response }, some { result: { response } }, some OpenAI-style choices.
function extractModelText(out: unknown): string | null {
  if (!out || typeof out !== 'object') return typeof out === 'string' && out.length > 0 ? out : null;
  const o = out as Record<string, unknown>;
  if (typeof o.response === 'string' && o.response.length > 0) return o.response;
  const result = o.result;
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.response === 'string' && r.response.length > 0) return r.response;
  }
  const choices = o.choices;
  if (Array.isArray(choices) && choices[0] && typeof choices[0] === 'object') {
    const msg = (choices[0] as Record<string, unknown>).message;
    if (msg && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>).content;
      if (typeof content === 'string' && content.length > 0) return content;
    }
  }
  return null;
}

export interface BrainInput {
  text: string;
  tasks: TaskRow[];
  transcript: string;
  parts: LocalParts;
  planState: string;
  styleCard: string | null;
  schedInsights: string | null;
  todayLocal: string;
  tz: string;
}

function taskListForPrompt(tasks: TaskRow[], tz: string): string {
  if (tasks.length === 0) return '(none)';
  return tasks
    .map((t, i) => {
      const bits: string[] = [`${i + 1}) ${t.title}`];
      if (t.next_action_at_utc) {
        bits.push(
          `nag at ${new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(t.next_action_at_utc))}`,
        );
      }
      if (t.due_at_utc) {
        bits.push(
          `due ${new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(t.due_at_utc))}`,
        );
      }
      if (t.status === 'started') bits.push('in progress');
      if (t.status === 'awaiting_recommitment') bits.push('awaiting recommitment');
      return bits.join(' — ');
    })
    .join('\n');
}

export async function interpret(env: AppEnv, input: BrainInput): Promise<Interpretation | null> {
  if (!(await aiBudgetOk(env, input.todayLocal))) return null;

  const system = [
    `You are Donna, a personal accountability agent who texts with her owner. Voice: brief, direct, warm but blunt — never corporate, never listy unless asked. Mirror how the owner texts.`,
    input.styleCard ? `WHAT YOU KNOW ABOUT HOW THE OWNER TALKS:\n${input.styleCard}` : '',
    input.schedInsights ? `WHAT YOU KNOW ABOUT THE OWNER'S PATTERNS:\n${input.schedInsights}` : '',
    `Now: ${input.parts.weekday} ${input.todayLocal}, ${input.parts.hhmm} local. Plan state today: ${input.planState}.`,
    `Open tasks (always reference by number):\n${taskListForPrompt(input.tasks, input.tz)}`,
    `Recent conversation:\n${input.transcript || '(none)'}`,
    ``,
    `Convert the owner's NEW message into JSON ONLY (no prose outside JSON):`,
    `{"actions":[...],"reply":"..." or null,"question":"..." or null,"confidence":0.0-1.0}`,
    `Action types:`,
    `{"type":"add_task","title":str,"start_date":"YYYY-MM-DD"|null,"due_date":"YYYY-MM-DD"|null,"due_time":"HH:MM"|null,"remind_time":"HH:MM"|null} — extract EVERY task mentioned, one action each. Compute concrete dates from today's date ("this week"→this Friday, "tonight"→today). "by 5pm" means due_time "17:00" today. remind_time = when to first nag if they named a time to do it.`,
    `{"type":"complete","task":n} {"type":"start","task":n} {"type":"notdone","task":n} {"type":"snooze","task":n,"minutes":m} {"type":"defer","task":n} {"type":"drop","task":n,"reason":str|null} {"type":"blocked","task":n,"reason":str} {"type":"set_time","task":n,"time":"HH:MM","date":"YYYY-MM-DD"|null}`,
    `{"type":"status"} {"type":"plan"} {"type":"no_plan"} {"type":"confirm_plan"} {"type":"undo"} {"type":"help"} {"type":"set_nag","level":"gentle|standard|relentless"}`,
    `Rules:`,
    `- Relative times: "in 5 minutes" / "in an hour" → add to the current local time (${input.parts.hhmm}) and output the resulting HH:MM as remind_time.`,
    `- Match tasks by meaning ("the deck" = whichever open task is about the deck).`,
    `- If the message is conversation with no task operation, actions=[] and write "reply" in the owner's style (<=300 chars).`,
    `- If you genuinely can't tell which task or what time, actions=[] and ask ONE short specific "question". Never dump a command list.`,
    `- When actions exist, "reply" should be one short confirmation in the owner's style; the system may use it instead of its own receipt.`,
    `- Low confidence (<0.5) if you're guessing.`,
  ]
    .filter(Boolean)
    .join('\n');

  // Two attempts: models whiff stochastically, and a fresh roll usually
  // lands. Each attempt consumes AI budget honestly.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && !(await aiBudgetOk(env, input.todayLocal))) break;
    try {
      const out: unknown = await env.AI.run(
        (env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast') as Parameters<Ai['run']>[0],
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: input.text },
          ],
          max_tokens: 500,
        },
      );
      const response = extractModelText(out);
      if (!response) {
        console.error(
          JSON.stringify({ evt: 'brain_empty', attempt, shape: JSON.stringify(out).slice(0, 240) }),
        );
        continue;
      }
      const result = validateInterpretation(response, input.tasks.length, input.todayLocal);
      if (!result) {
        console.error(JSON.stringify({ evt: 'brain_unparsed', attempt, sample: response.slice(0, 240) }));
        continue;
      }
      if (result.actions.length > 0 && result.confidence < 0.5) {
        // Never execute uncertain actions — but a question or reply is safe.
        if (result.question || result.reply) return { ...result, actions: [] };
        console.error(JSON.stringify({ evt: 'brain_low_confidence', attempt, confidence: result.confidence }));
        continue;
      }
      return result;
    } catch (err) {
      console.error(JSON.stringify({ evt: 'brain_failed', attempt, err: err instanceof Error ? err.message : String(err) }));
    }
  }
  return null;
}

// -- nightly reflection (v1.2) ----------------------------------------------

export interface ReflectionInput {
  transcript: string;
  stats: string;
  currentStyle: string | null;
  currentInsights: string | null;
}

export async function reflect(
  env: AppEnv,
  todayLocal: string,
  input: ReflectionInput,
): Promise<{ style: string; insights: string } | null> {
  if (!(await aiBudgetOk(env, todayLocal))) return null;
  const system = [
    `You maintain two short memory cards about the owner of an accountability bot. Rewrite both, merging what was already known with today's new evidence. Be concrete and factual; no psychoanalysis.`,
    `Card 1 STYLE (<=300 chars): how the owner texts (length, slang, punctuation, emoji) and what tone gets responses from them.`,
    `Card 2 INSIGHTS (<=300 chars): schedule/behavior patterns with numbers when possible (when they actually do work, what they defer, response lag).`,
    `Existing STYLE: ${input.currentStyle ?? '(none yet)'}`,
    `Existing INSIGHTS: ${input.currentInsights ?? '(none yet)'}`,
    `New evidence — stats: ${input.stats}`,
    `New evidence — recent messages:\n${input.transcript}`,
    `Output JSON ONLY: {"style":"...","insights":"..."}`,
  ].join('\n');
  try {
    const out: unknown = await env.AI.run(
      (env.AI_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast') as Parameters<Ai['run']>[0],
      { messages: [{ role: 'system', content: system }, { role: 'user', content: 'Update the cards.' }], max_tokens: 400 },
    );
    const response = extractModelText(out);
    if (!response) return null;
    const m = /\{[\s\S]*\}/.exec(response);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as Record<string, unknown>;
    const style = str(parsed.style);
    const insights = str(parsed.insights);
    if (!style && !insights) return null;
    return { style: (style ?? '').slice(0, 400), insights: (insights ?? '').slice(0, 400) };
  } catch (err) {
    console.error(JSON.stringify({ evt: 'reflect_failed', err: err instanceof Error ? err.message : String(err) }));
    return null;
  }
}
