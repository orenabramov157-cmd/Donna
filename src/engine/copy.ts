// Every text the bot sends. Short, direct, factual. No guilt, no diagnoses —
// the friction lives in what the bot asks for, not in how it talks.

import type { TaskRow } from '../db';
import type { LadderStage } from './ladder';

export function fmtLocalTime(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(
    new Date(utcMs),
  );
}

function taskLine(t: TaskRow, i: number, tz: string): string {
  const time = t.next_action_at_utc ? ` — ${fmtLocalTime(t.next_action_at_utc, tz)}` : '';
  return `${i + 1}) ${t.title}${time}`;
}

export const HELP = [
  'Commands (always work):',
  'done / done 2 · start · snooze 30 · tomorrow · not done · blocked <why>',
  'drop 2 <reason> · add: <task> [time] · plan · status · undo · nag gentle|standard|relentless · help',
  'Or just talk to me — I usually get it.',
].join('\n');

export function planPrompt(tasks: TaskRow[], proposed: Map<number, string>, tz: string): string {
  const lines = tasks.map((t, i) => {
    const hhmm = proposed.get(t.id);
    const at = t.next_action_at_utc
      ? fmtLocalTime(t.next_action_at_utc, tz)
      : hhmm
        ? hhmm
        : 'no time';
    return `${i + 1}) ${t.title} — ${at}`;
  });
  return [
    `🌅 Morning. Today's list:`,
    ...lines,
    '',
    `Reply "ok" to lock it in, "2 at 3pm" to change a time, "add: <task> <time>" to add, "no plan" to skip today.`,
  ].join('\n');
}

export const PLAN_NUDGE_1 = `Still need a plan for today. Reply "ok" to take the list as proposed, "plan" to redo it, or "no plan".`;
export const PLAN_NUDGE_FINAL = `Last call on today's plan — after this I'll stay quiet until you text "plan".`;
export const PLAN_CONFIRMED = (n: number): string => `Locked: ${n} task${n === 1 ? '' : 's'}. I'll check in on schedule. 🫡`;
export const NO_PLAN = `No plan today — noted. Text "plan" if you change your mind.`;

export function nagMsg(t: TaskRow, withHints: boolean): string {
  const base = `⏰ ${t.title} — time to move.`;
  return withHints ? `${base}\nReply: done / start / snooze 30 / tomorrow / blocked <why>` : base;
}

export function startedCheckin(t: TaskRow): string {
  return `10 minutes up — did "${t.title}" actually start? (done / still going / not done)`;
}

export function doneReceipt(t: TaskRow, next: TaskRow | null, tz: string): string {
  const nextPart = next
    ? next.next_action_at_utc
      ? ` Next: ${next.title}, ${fmtLocalTime(next.next_action_at_utc, tz)}.`
      : ` Next: ${next.title}.`
    : ' That was the last one — clear list. 🎉';
  return `✅ ${t.title} — done.${nextPart}`;
}

export function trelloDoneReceipt(t: TaskRow, openCount: number): string {
  return `Saw you moved "${t.title}" to Done ✅ — ${openCount} left today.`;
}

export function snoozeReceipt(t: TaskRow, minutes: number): string {
  return `😴 ${t.title} — back in ${minutes} min.`;
}

export function startReceipt(t: TaskRow): string {
  return `▶️ ${t.title} — go. I'll check in 10 minutes.`;
}

export function deferPrompt(stage: LadderStage, t: TaskRow, count: number): string {
  switch (stage) {
    case 'first':
      return `"${t.title}" moves to tomorrow (deferral #${count}). What's the smallest next action, and what time tomorrow? (e.g. "draft the first paragraph, 10am")`;
    case 'second':
      return `"${t.title}" — deferral #${count} in a row. Shrink it, split it, or drop it: reply with a smaller version + time, or "drop <reason>".`;
    case 'hard':
      return `"${t.title}" has slid ${count} days. Three options only: "start" (10 min on it right now), a rewritten smaller task + time, or "drop <reason>".`;
    case 'stuck':
      return `"${t.title}" is now parked after ${count} deferrals. No more nags — tomorrow morning we either rewrite it smaller or drop it.`;
  }
}

export function notDonePrompt(t: TaskRow): string {
  return `Noted — "${t.title}" not done yet. Smallest next action + a time today? (e.g. "email the draft, 4pm")`;
}

export function blockedPrompt(t: TaskRow, reason: string): string {
  return `🧱 "${t.title}" blocked: ${reason}. What's the workaround step, and when today do you take it?`;
}

export function recommitReceipt(t: TaskRow, whenLabel: string): string {
  return `📌 ${t.title} — recommitted for ${whenLabel}. I'll be back then.`;
}

export function rewriteReceipt(oldTitle: string, t: TaskRow): string {
  return `✂️ Rewrote "${oldTitle}" → "${t.title}". Fresh start, ladder reset.`;
}

export function dropReceipt(t: TaskRow, reason: string | undefined): string {
  return `🗑 ${t.title} — dropped${reason ? ` (${reason})` : ''}. On the record.`;
}

export function addReceipt(t: TaskRow, tz: string): string {
  return t.next_action_at_utc
    ? `➕ ${t.title} — on the list for ${fmtLocalTime(t.next_action_at_utc, tz)}.`
    : `➕ ${t.title} — added. What time should I come after you about it?`;
}

export function undoReceipt(title: string): string {
  return `↩️ Undone — "${title}" is back where it was.`;
}

export const NOTHING_TO_UNDO = `Nothing to undo (10-minute window).`;

export function clarifyWhich(tasks: TaskRow[], tz: string): string {
  return [`Which one?`, ...tasks.map((t, i) => taskLine(t, i, tz)), `Reply with the number (e.g. "done 2").`].join('\n');
}

export function statusList(tasks: TaskRow[], doneToday: number, tz: string): string {
  if (tasks.length === 0) return `Nothing open. ${doneToday} done today. 🎉`;
  return [`Open (${tasks.length}) · done today: ${doneToday}`, ...tasks.map((t, i) => taskLine(t, i, tz))].join('\n');
}

export function pulseMsg(tasks: TaskRow[], doneToday: number, tz: string): string {
  return [
    `📍 Pulse: ${doneToday} done, ${tasks.length} open.`,
    ...tasks.slice(0, 5).map((t, i) => taskLine(t, i, tz)),
    `Status? (done N / start / blocked N <why>)`,
  ].join('\n');
}

export interface RecapStats {
  done: string[];
  recommitted: string[];
  dropped: string[];
  stuck: string[];
  open: string[];
  deferPatterns: string[];
}

export function eveningRecap(s: RecapStats): string {
  const lines: string[] = ['🌙 Recap:'];
  if (s.done.length) lines.push(`✅ Done (${s.done.length}): ${s.done.join(' · ')}`);
  if (s.recommitted.length) lines.push(`📌 Recommitted: ${s.recommitted.join(' · ')}`);
  if (s.dropped.length) lines.push(`🗑 Dropped: ${s.dropped.join(' · ')}`);
  if (s.stuck.length) lines.push(`🅿️ Parked: ${s.stuck.join(' · ')}`);
  if (s.open.length)
    lines.push(`⏳ Still open: ${s.open.join(' · ')} — each needs a next action + time ("1 tomorrow 10am") or "drop N <reason>".`);
  if (!s.done.length && !s.open.length && !s.recommitted.length && !s.dropped.length && !s.stuck.length)
    lines.push(`Quiet day — nothing tracked.`);
  for (const p of s.deferPatterns) lines.push(`📊 ${p}`);
  return lines.join('\n');
}

export function weeklyRecap(completed: number, dropped: number, deferred: number, worst: string | null): string {
  const lines = [
    `📅 Week in numbers: ${completed} completed · ${dropped} dropped · ${deferred} deferrals.`,
  ];
  if (worst) lines.push(`Most-deferred: "${worst}".`);
  lines.push(`New week starts tomorrow. Same rules.`);
  return lines.join('\n');
}

export function stuckReview(tasks: TaskRow[]): string {
  return [
    `🅿️ Parked task${tasks.length === 1 ? '' : 's'} needing a decision before today's plan:`,
    ...tasks.map((t, i) => `${i + 1}) ${t.title} (${t.consecutive_deferrals} deferrals)`),
    `For each: rewrite smaller ("rewrite: <new version> <time>") or "drop <n> <reason>".`,
  ].join('\n');
}

export const SETUP_TEST = `🔧 Test message from your accountability bot — you're wired up. Text "help" to see commands.`;
export const KEYWORDS_FALLBACK = `Didn't catch that. ${'\n'}${HELP}`;
