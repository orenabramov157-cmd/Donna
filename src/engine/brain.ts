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
      // Deadline — absolute (date + optional time) or relative offset.
      due_date: string | null;
      due_time: string | null;
      due_in_minutes: number | null;
      // First nag — absolute (date + time) or relative offset from now.
      remind_date: string | null;
      remind_time: string | null;
      remind_in_minutes: number | null;
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
  | { type: 'set_nag'; level: 'gentle' | 'standard' | 'relentless' }
  | { type: 'set_persona'; directive: string };

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

// Relative offset in minutes, 1 min .. 60 days. Guards against the model
// emitting nonsense like 0 or a year of minutes.
function validOffset(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n >= 1 && n <= 86_400 ? n : null;
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
          due_date: clampDate(str(a.due_date), todayLocal),
          due_time: validTime(a.due_time),
          due_in_minutes: validOffset(a.due_in_minutes),
          remind_date: clampDate(str(a.remind_date), todayLocal),
          remind_time: validTime(a.remind_time),
          remind_in_minutes: validOffset(a.remind_in_minutes),
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
      case 'set_persona': {
        const directive = str(a.directive);
        if (directive) actions.push({ type: 'set_persona', directive: directive.slice(0, 240) });
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
  persona: string | null;
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
    input.persona
      ? `OWNER'S STANDING ORDER — they explicitly told you how to treat them. This OUTRANKS everything you've learned; obey it in every reply:\n"${input.persona}"`
      : '',
    input.styleCard ? `WHO YOU'RE TALKING TO (mirror this — how they talk and how they want you to talk back):\n${input.styleCard}` : '',
    input.schedInsights ? `WHAT YOU KNOW ABOUT THEIR PATTERNS:\n${input.schedInsights}` : '',
    `Timezone: ${input.tz}. ALL times are in this local zone — "5pm" means 17:00 ${input.tz}, never UTC.`,
    `Now: ${input.parts.weekday} ${input.todayLocal}, ${input.parts.hhmm} local. Plan state today: ${input.planState}.`,
    `Open tasks (always reference by number):\n${taskListForPrompt(input.tasks, input.tz)}`,
    `Recent conversation:\n${input.transcript || '(none)'}`,
    ``,
    `Convert the owner's NEW message into JSON ONLY (no prose outside JSON):`,
    `{"actions":[...],"reply":"..." or null,"question":"..." or null,"confidence":0.0-1.0}`,
    `Action types:`,
    `{"type":"add_task","title":str,"due_date":"YYYY-MM-DD"|null,"due_time":"HH:MM"|null,"due_in_minutes":int|null,"remind_date":"YYYY-MM-DD"|null,"remind_time":"HH:MM"|null,"remind_in_minutes":int|null} — extract EVERY task mentioned, one action each.`,
    `{"type":"complete","task":n} {"type":"start","task":n} {"type":"notdone","task":n} {"type":"snooze","task":n,"minutes":m} {"type":"defer","task":n} {"type":"drop","task":n,"reason":str|null} {"type":"blocked","task":n,"reason":str} {"type":"set_time","task":n,"time":"HH:MM","date":"YYYY-MM-DD"|null}`,
    `{"type":"status"} {"type":"plan"} {"type":"no_plan"} {"type":"confirm_plan"} {"type":"undo"} {"type":"help"} {"type":"set_nag","level":"gentle|standard|relentless"}`,
    `{"type":"set_persona","directive":str} — when the owner tells you HOW to behave or talk to them (not a task): "be tougher on me", "stop being soft", "talk to me like a coach", "push me harder", "chill out with the nagging tone". Capture their intent as a concise standing instruction to yourself (e.g. "Be a blunt drill sergeant — push hard, no coddling."). Also obey it immediately in this very "reply".`,
    `TIME RULES (critical — get these exactly right):`,
    `- "remind me in X" / "in X minutes|hours|days" → use remind_in_minutes ONLY (minutes=5, hours×60, days×1440). Example: "in 24 hours"→remind_in_minutes:1440. "in 3 days"→4320. NEVER convert a relative offset into a clock time.`,
    `- A clock time to be nagged ("nag me at 3pm", "remind me at 10am tomorrow") → remind_time (+remind_date if a day is named). "tomorrow 10am"→remind_date=tomorrow's date, remind_time:"10:00".`,
    `- A deadline ("by 5pm", "due Friday", "by end of week") → due_time/due_date (or due_in_minutes for "due in 2 hours"). "by 5pm"→due_time:"17:00". "this week"→due_date=this Friday.`,
    `- If they give a do-it time but no separate nag time, set remind_time to that time. If only a deadline, leave remind fields null (the system warns before it).`,
    `Rules:`,
    `- Texting shorthand is normal English — read it naturally, never as a task title: u=you, ur/yr=your, r=are, rn=right now, tn=tonight, tmrw/tmr=tomorrow, td=today, lmk=let me know, alr/aight/ight=alright, k/kk=ok, w/e=whatever, b4=before, ngl/idk/imo as usual.`,
    `- Match tasks by meaning ("the deck" = whichever open task is about the deck).`,
    `- NEVER ask the owner a clarifying question. If unsure which task, pick the most likely one. If unsure of a time, make a sensible assumption and just state it in "reply". Act, don't interrogate.`,
    `- Pure conversation with no task operation → actions=[] and a short "reply" in their style.`,
    `- "question" must always be null. Use "reply" instead.`,
    `- confidence <0.5 only if you truly cannot act at all.`,
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
  persona: string | null;
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
    `You maintain two short memory cards about the owner of an accountability bot named Donna. Rewrite both, merging what was already known with today's new evidence. Be concrete and factual; no psychoanalysis.`,
    input.persona
      ? `The owner has issued an explicit STANDING ORDER on how Donna must treat them: "${input.persona}". This is locked and lives outside your cards — do NOT restate, soften, or contradict it in Card 1; Card 1 only adds observations that complement it.`
      : '',
    `Card 1 STYLE (<=300 chars): (a) how the owner texts — length, slang, punctuation, emoji, capitalization; AND (b) the DYNAMIC they want from Donna, inferred from how they talk to her and what they respond to: do they want a boss / drill-sergeant who pushes hard, or a chill helper? Blunt or gentle? Hype or deadpan? Write it as a directive Donna can follow (e.g. "Texts lowercase, short, casual/profane; wants a blunt hype drill-sergeant, not a soft assistant. Match his energy, don't be corporate.").`,
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
