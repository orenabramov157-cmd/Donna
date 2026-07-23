// The orchestrator: conversation routing, the daily lifecycle (plan → nag →
// pulse → recap), the escalation ladder, and Trello two-way sync. Everything
// stateful goes through db.ts; everything outbound goes through sendOwner().

import type { AppEnv } from '../env';
import {
  appendEvent,
  createTask,
  dueTasks,
  ensureSession,
  eventsInRange,
  failedOutbound,
  getSetting,
  getTask,
  getUser,
  lastInboundAt,
  lastOutboundAt,
  logOutbound,
  markInboundProcessed,
  openTasks,
  outboundByMessageId,
  pendingPromptTask,
  recentTrelloEcho,
  setOutboundStatus,
  setSetting,
  stuckTasks,
  taskByCard,
  tryInsertInbound,
  unprocessedInbound,
  updateSession,
  updateTask,
  updateUserField,
  upsertUser,
  type SessionRow,
  type TaskRow,
  type UserRow,
} from '../db';
import { ensureSchema } from '../schema';
import {
  addDaysLocal,
  extractTrailingTime,
  hhmmToMin,
  localParts,
  parseTimeToken,
  utcForLocalDateTime,
  type LocalParts,
} from '../time';
import { aiInterpret, parseDeterministic, type Command, type NagLevel } from '../parse';
import { ladderStage } from './ladder';
import { inQuietHours, nagPolicy, shouldPulse, shouldRenag } from './nag';
import * as copy from './copy';
import {
  archiveCard,
  createCard,
  getCards,
  getLists,
  getMemberName,
  moveCardToList,
  parseTrelloAction,
  registerWebhook,
  trelloConfigured,
} from '../trello';
import { getChannel, type Inbound } from '../channel';

const OUTBOUND_KINDS = ['nag', 'checkin', 'pulse', 'plan', 'recap', 'receipt', 'misc'];
const PLAN_SLOTS = ['10:00', '14:00', '16:30'];

interface Ctx {
  env: AppEnv;
  db: D1Database;
  user: UserRow;
  tz: string;
  now: number;
  parts: LocalParts;
  today: string;
}

async function buildCtx(env: AppEnv, now: number): Promise<Ctx | null> {
  await ensureSchema(env.DB);
  const user = await getUser(env.DB);
  if (!user) return null;
  const parts = localParts(now, user.timezone);
  return { env, db: env.DB, user, tz: user.timezone, now, parts, today: parts.localDate };
}

function normContact(s: string): string {
  return s.toLowerCase().replace(/[\s()\-.]/g, '');
}

async function sendOwner(
  c: Ctx,
  kind: string,
  body: string,
  taskId?: number | null,
  trelloCardId?: string | null,
): Promise<void> {
  const channel = getChannel(c.env);
  const res = await channel.send(c.env, c.user.contact, body, taskId ? { passthrough: `task:${taskId}` } : undefined);
  await logOutbound(c.db, {
    kind,
    task_id: taskId ?? null,
    channel_message_id: res?.messageId ?? null,
    trello_card_id: trelloCardId ?? null,
    body,
    status: res ? 'sent' : 'failed',
  });
}

// -- undo -------------------------------------------------------------------

interface UndoSnapshot {
  taskId: number;
  at: number;
  title: string;
  prev: Pick<
    TaskRow,
    'title' | 'status' | 'next_action_at_utc' | 'consecutive_deferrals' | 'source_local_date' | 'blocker' | 'pending_prompt'
  >;
}

async function saveUndo(c: Ctx, t: TaskRow): Promise<void> {
  const snap: UndoSnapshot = {
    taskId: t.id,
    at: c.now,
    title: t.title,
    prev: {
      title: t.title,
      status: t.status,
      next_action_at_utc: t.next_action_at_utc,
      consecutive_deferrals: t.consecutive_deferrals,
      source_local_date: t.source_local_date,
      blocker: t.blocker,
      pending_prompt: t.pending_prompt,
    },
  };
  await setSetting(c.db, 'last_undoable', JSON.stringify(snap));
}

async function tryUndo(c: Ctx): Promise<void> {
  const raw = await getSetting(c.db, 'last_undoable');
  if (!raw) {
    await sendOwner(c, 'receipt', copy.NOTHING_TO_UNDO);
    return;
  }
  const snap = JSON.parse(raw) as UndoSnapshot;
  if (c.now - snap.at > 10 * 60_000) {
    await sendOwner(c, 'receipt', copy.NOTHING_TO_UNDO);
    return;
  }
  await updateTask(c.db, snap.taskId, { ...snap.prev });
  await appendEvent(c.db, snap.taskId, 'undone');
  await setSetting(c.db, 'last_undoable', JSON.stringify({ ...snap, at: 0 }));
  await sendOwner(c, 'receipt', copy.undoReceipt(snap.title));
}

// -- task actions -----------------------------------------------------------

async function doneTodayCount(c: Ctx): Promise<number> {
  const dayStart = utcForLocalDateTime(c.tz, c.today, '00:00');
  const events = await eventsInRange(c.db, dayStart, c.now + 1);
  return events.filter((e) => e.kind === 'completed').length;
}

async function completeTask(c: Ctx, t: TaskRow, source: 'text' | 'reaction' | 'trello'): Promise<void> {
  await saveUndo(c, t);
  await updateTask(c.db, t.id, { status: 'done', pending_prompt: null });
  await appendEvent(c.db, t.id, 'completed', { source });
  if ((await getSetting(c.db, 'last_nagged_task')) === String(t.id)) await setSetting(c.db, 'last_nagged_task', '');

  let trelloCardId: string | null = null;
  if (source !== 'trello' && t.trello_card_id && trelloConfigured(c.env)) {
    const doneListId = await getSetting(c.db, 'trello_done_list_id');
    if (doneListId) {
      trelloCardId = t.trello_card_id;
      // Log before mutating so the webhook echo is suppressed.
      await logOutbound(c.db, { kind: 'trello_move', trello_card_id: t.trello_card_id, body: 'done' });
      await moveCardToList(c.env, t.trello_card_id, doneListId, true);
    }
  }
  const open = await openTasks(c.db, c.today);
  if (source === 'trello') {
    await sendOwner(c, 'receipt', copy.trelloDoneReceipt(t, open.length), t.id, trelloCardId);
  } else {
    await sendOwner(c, 'receipt', copy.doneReceipt(t, open[0] ?? null, c.tz), t.id, trelloCardId);
  }
}

async function startTask(c: Ctx, t: TaskRow): Promise<void> {
  await saveUndo(c, t);
  await updateTask(c.db, t.id, {
    status: 'started',
    source_local_date: c.today,
    next_action_at_utc: c.now + 10 * 60_000,
    pending_prompt: null,
  });
  await appendEvent(c.db, t.id, 'started');
  await setSetting(c.db, 'last_nagged_task', String(t.id));
  await sendOwner(c, 'receipt', copy.startReceipt(t), t.id);
}

async function snoozeTask(c: Ctx, t: TaskRow, minutes: number): Promise<void> {
  await saveUndo(c, t);
  await updateTask(c.db, t.id, { status: 'pending', next_action_at_utc: c.now + minutes * 60_000 });
  await appendEvent(c.db, t.id, 'snoozed', { minutes });
  await sendOwner(c, 'receipt', copy.snoozeReceipt(t, minutes), t.id);
}

async function deferTask(c: Ctx, t: TaskRow): Promise<void> {
  const count = t.consecutive_deferrals + 1;
  const stage = ladderStage(count);
  await saveUndo(c, t);
  if (stage === 'stuck') {
    await updateTask(c.db, t.id, {
      status: 'stuck',
      consecutive_deferrals: count,
      next_action_at_utc: null,
      pending_prompt: null,
    });
    await appendEvent(c.db, t.id, 'stuck', { count });
    await sendOwner(c, 'receipt', copy.deferPrompt('stuck', t, count), t.id);
    return;
  }
  await updateTask(c.db, t.id, {
    status: 'awaiting_recommitment',
    consecutive_deferrals: count,
    source_local_date: addDaysLocal(c.tz, c.today, 1),
    next_action_at_utc: null,
    pending_prompt: JSON.stringify({ type: stage }),
  });
  await appendEvent(c.db, t.id, 'deferred', { count });
  await sendOwner(c, 'receipt', copy.deferPrompt(stage, t, count), t.id);
}

async function notDoneTask(c: Ctx, t: TaskRow): Promise<void> {
  await saveUndo(c, t);
  await updateTask(c.db, t.id, {
    status: 'awaiting_recommitment',
    pending_prompt: JSON.stringify({ type: 'recommit_today' }),
  });
  await appendEvent(c.db, t.id, 'not_done');
  await sendOwner(c, 'receipt', copy.notDonePrompt(t), t.id);
}

async function blockTask(c: Ctx, t: TaskRow, reason: string): Promise<void> {
  await saveUndo(c, t);
  await updateTask(c.db, t.id, {
    status: 'awaiting_recommitment',
    blocker: reason,
    pending_prompt: JSON.stringify({ type: 'recommit_today', blocked: true }),
  });
  await appendEvent(c.db, t.id, 'blocked', { reason });
  await sendOwner(c, 'receipt', copy.blockedPrompt(t, reason), t.id);
}

async function dropTask(c: Ctx, t: TaskRow, reason?: string): Promise<void> {
  await saveUndo(c, t);
  await updateTask(c.db, t.id, { status: 'dropped', pending_prompt: null });
  await appendEvent(c.db, t.id, 'dropped', { reason: reason ?? null });
  if (t.trello_card_id && t.created_by !== 'trello' && trelloConfigured(c.env)) {
    await logOutbound(c.db, { kind: 'trello_archive', trello_card_id: t.trello_card_id, body: 'drop' });
    await archiveCard(c.env, t.trello_card_id);
  }
  await sendOwner(c, 'receipt', copy.dropReceipt(t, reason), t.id);
}

async function addTask(c: Ctx, title: string, time: string | null): Promise<void> {
  let cardId: string | null = null;
  if (trelloConfigured(c.env)) {
    const todayListId = await getSetting(c.db, 'trello_today_list_id');
    if (todayListId) {
      const dueIso = time ? new Date(utcForLocalDateTime(c.tz, c.today, time)).toISOString() : undefined;
      const card = await createCard(c.env, todayListId, title, dueIso);
      if (card) {
        cardId = card.id;
        await logOutbound(c.db, { kind: 'trello_create', trello_card_id: cardId, body: title });
      }
    }
  }
  let nextAt: number | null = null;
  if (time) {
    nextAt = utcForLocalDateTime(c.tz, c.today, time);
    if (nextAt <= c.now) nextAt = utcForLocalDateTime(c.tz, addDaysLocal(c.tz, c.today, 1), time);
  }
  const id = await createTask(c.db, {
    trello_card_id: cardId,
    title,
    source_local_date: c.today,
    next_action_at_utc: nextAt,
    created_by: 'owner',
  });
  await appendEvent(c.db, id, 'created', { via: 'text' });
  if (!nextAt) await updateTask(c.db, id, { pending_prompt: JSON.stringify({ type: 'add_time' }) });
  const t = await getTask(c.db, id);
  if (t) await sendOwner(c, 'receipt', copy.addReceipt(t, c.tz), id, cardId);
}

async function rewriteTask(c: Ctx, t: TaskRow, text: string, backToToday: boolean): Promise<void> {
  const { title, time } = extractTrailingTime(text);
  const oldTitle = t.title;
  const date = backToToday ? c.today : t.source_local_date;
  const hhmm = time ?? '10:00';
  let nextAt = utcForLocalDateTime(c.tz, date, hhmm);
  if (nextAt <= c.now) nextAt = backToToday ? c.now + 30 * 60_000 : utcForLocalDateTime(c.tz, addDaysLocal(c.tz, c.today, 1), hhmm);
  await saveUndo(c, t);
  await updateTask(c.db, t.id, {
    title,
    status: 'pending',
    consecutive_deferrals: 0,
    source_local_date: date,
    next_action_at_utc: nextAt,
    pending_prompt: null,
    blocker: null,
    nags_sent_today: 0,
  });
  await appendEvent(c.db, t.id, 'rewritten', { old: oldTitle });
  const updated = await getTask(c.db, t.id);
  if (updated) await sendOwner(c, 'receipt', copy.rewriteReceipt(oldTitle, updated), t.id);
}

// -- pending-prompt resolution ----------------------------------------------

interface PendingPrompt {
  type: 'first' | 'second' | 'hard' | 'recommit_today' | 'add_time';
  blocked?: boolean;
}

async function resolvePending(c: Ctx, t: TaskRow, text: string): Promise<void> {
  const p = JSON.parse(t.pending_prompt ?? '{}') as PendingPrompt;
  const det = parseDeterministic(text);

  if (det.op === 'drop') {
    await dropTask(c, t, det.reason);
    return;
  }
  if ((p.type === 'hard' || p.type === 'second') && det.op === 'start') {
    await startTask(c, t);
    return;
  }
  if (p.type === 'second' || p.type === 'hard') {
    await rewriteTask(c, t, text, p.type === 'hard');
    return;
  }

  // first / recommit_today / add_time: expect "note/next action + time"
  const { title: note, time } = extractTrailingTime(text);
  const isToday = p.type === 'recommit_today' || p.type === 'add_time';
  const date = isToday ? c.today : t.source_local_date;
  const hhmm = time ?? (isToday ? null : '10:00');
  let nextAt: number;
  if (hhmm) {
    nextAt = utcForLocalDateTime(c.tz, date, hhmm);
    if (nextAt <= c.now && isToday) nextAt = utcForLocalDateTime(c.tz, addDaysLocal(c.tz, c.today, 1), hhmm);
  } else {
    nextAt = c.now + 60 * 60_000; // default: one hour from now
  }
  await updateTask(c.db, t.id, {
    status: 'pending',
    next_action_at_utc: nextAt,
    pending_prompt: null,
    blocker: null,
  });
  await appendEvent(c.db, t.id, 'recommitted', { note, time: hhmm });
  await sendOwner(c, 'receipt', copy.recommitReceipt(t, copy.fmtLocalTime(nextAt, c.tz)), t.id);
}

// -- reference resolution ---------------------------------------------------

async function resolveTask(c: Ctx, ref?: number): Promise<TaskRow | null> {
  if (ref !== undefined) {
    const raw = await getSetting(c.db, 'status_order');
    const order = raw ? (JSON.parse(raw) as number[]) : [];
    const id = order[ref - 1];
    if (id !== undefined) {
      const t = await getTask(c.db, id);
      if (t && !['done', 'dropped'].includes(t.status)) return t;
    }
    return null;
  }
  const lastRaw = await getSetting(c.db, 'last_nagged_task');
  if (lastRaw) {
    const t = await getTask(c.db, Number(lastRaw));
    if (t && !['done', 'dropped', 'stuck'].includes(t.status)) return t;
  }
  const open = await openTasks(c.db, c.today);
  return open.length === 1 ? (open[0] ?? null) : null;
}

async function saveStatusOrder(c: Ctx, tasks: TaskRow[]): Promise<void> {
  await setSetting(c.db, 'status_order', JSON.stringify(tasks.map((t) => t.id)));
}

async function clarify(c: Ctx): Promise<void> {
  const open = await openTasks(c.db, c.today);
  await saveStatusOrder(c, open);
  await sendOwner(c, 'receipt', copy.clarifyWhich(open, c.tz));
}

// -- morning plan -----------------------------------------------------------

async function syncTrelloToday(c: Ctx): Promise<void> {
  if (!trelloConfigured(c.env)) return;
  const todayListId = await getSetting(c.db, 'trello_today_list_id');
  if (!todayListId) return;
  const cards = await getCards(c.env, todayListId);
  if (!cards) return;
  for (const card of cards) {
    if (card.closed) continue;
    const existing = await taskByCard(c.db, card.id);
    if (existing) continue;
    const due = card.due ? Date.parse(card.due) : null;
    const id = await createTask(c.db, {
      trello_card_id: card.id,
      title: card.name,
      source_local_date: c.today,
      due_at_utc: due && Number.isFinite(due) ? due : null,
      next_action_at_utc: null,
      created_by: 'trello',
    });
    await appendEvent(c.db, id, 'created', { via: 'trello_sync' });
  }
}

async function morningPrompt(c: Ctx, session: SessionRow): Promise<void> {
  const stuck = await stuckTasks(c.db);
  if (stuck.length > 0 && (await getSetting(c.db, 'stuck_review_date')) !== c.today) {
    await setSetting(c.db, 'stuck_review_date', c.today);
    await sendOwner(c, 'plan', copy.stuckReview(stuck));
  }
  await syncTrelloToday(c);
  const open = await openTasks(c.db, c.today);
  const proposal: Record<number, string> = {};
  let slot = 0;
  for (const t of open) {
    if (t.next_action_at_utc) continue;
    if (t.due_at_utc) {
      proposal[t.id] = localParts(t.due_at_utc, c.tz).hhmm;
    } else {
      proposal[t.id] = PLAN_SLOTS[slot % PLAN_SLOTS.length] ?? '10:00';
      slot++;
    }
  }
  await setSetting(c.db, 'plan_proposal', JSON.stringify(proposal));
  await saveStatusOrder(c, open);
  const map = new Map<number, string>(Object.entries(proposal).map(([k, v]) => [Number(k), v]));
  await sendOwner(c, 'plan', copy.planPrompt(open, map, c.tz));
  await updateSession(c.db, c.today, { plan_state: 'prompted', prompted_at_utc: c.now });
}

async function confirmPlan(c: Ctx): Promise<void> {
  const raw = await getSetting(c.db, 'plan_proposal');
  const proposal = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  for (const [idStr, hhmm] of Object.entries(proposal)) {
    const t = await getTask(c.db, Number(idStr));
    if (!t || t.next_action_at_utc || ['done', 'dropped', 'stuck'].includes(t.status)) continue;
    let at = utcForLocalDateTime(c.tz, c.today, hhmm);
    if (at <= c.now) at = c.now + 30 * 60_000;
    await updateTask(c.db, t.id, { next_action_at_utc: at, status: 'pending' });
  }
  await updateSession(c.db, c.today, { plan_state: 'confirmed' });
  const open = await openTasks(c.db, c.today);
  await sendOwner(c, 'plan', copy.PLAN_CONFIRMED(open.length));
}

async function planEdit(c: Ctx, text: string): Promise<boolean> {
  const m = /^(\d+)\s*(?:at|@|->|to)?\s*(.+)$/i.exec(text.trim());
  if (!m) return false;
  const time = parseTimeToken(m[2] ?? '');
  if (!time) return false;
  const raw = await getSetting(c.db, 'status_order');
  const order = raw ? (JSON.parse(raw) as number[]) : [];
  const id = order[Number(m[1]) - 1];
  if (id === undefined) return false;
  const t = await getTask(c.db, id);
  if (!t) return false;
  const propRaw = await getSetting(c.db, 'plan_proposal');
  const proposal = propRaw ? (JSON.parse(propRaw) as Record<string, string>) : {};
  proposal[String(id)] = time;
  await setSetting(c.db, 'plan_proposal', JSON.stringify(proposal));
  await updateTask(c.db, id, { next_action_at_utc: null });
  await updateSession(c.db, c.today, { plan_state: 'planning' });
  await sendOwner(c, 'plan', `${m[1]}) ${t.title} → ${time}. Reply "ok" to lock the plan.`);
  return true;
}

// -- inbound routing --------------------------------------------------------

async function routeText(c: Ctx, text: string): Promise<void> {
  const session = await ensureSession(c.db, c.today);

  // Stuck-task rewrites: "rewrite: <new version> <time>" / "rewrite 2: ..."
  const rw = /^rewrite:?\s*(\d+)?\s*[:,-]?\s*(.+)$/i.exec(text.trim());
  if (rw) {
    const stuck = await stuckTasks(c.db);
    const target = rw[1] ? stuck[Number(rw[1]) - 1] : stuck.length === 1 ? stuck[0] : undefined;
    if (target) {
      await rewriteTask(c, target, rw[2] ?? '', true);
      return;
    }
  }

  const cmd = parseDeterministic(text);

  // A pending question owns the next free-text reply.
  const pending = await pendingPromptTask(c.db);
  if (pending && (cmd.op === 'freetext' || cmd.op === 'drop' || cmd.op === 'start' || cmd.op === 'ok')) {
    if (cmd.op === 'ok') {
      // "ok" is not an answer to "what's the next action + time" — re-ask.
      await sendOwner(c, 'receipt', copy.notDonePrompt(pending), pending.id);
      return;
    }
    await resolvePending(c, pending, text);
    return;
  }

  const planning = session.plan_state === 'prompted' || session.plan_state === 'planning';
  if (planning && cmd.op === 'freetext' && (await planEdit(c, text))) return;

  let effective: Command = cmd;
  if (cmd.op === 'freetext') {
    const open = await openTasks(c.db, c.today);
    const ai = await aiInterpret(c.env, c.today, text, open);
    if (!ai) {
      await sendOwner(c, 'receipt', copy.KEYWORDS_FALLBACK);
      return;
    }
    effective = ai;
  }

  switch (effective.op) {
    case 'ok':
      if (planning) await confirmPlan(c);
      else await sendOwner(c, 'receipt', '👍');
      return;
    case 'plan':
      await morningPrompt(c, session);
      return;
    case 'noplan':
      await updateSession(c.db, c.today, { plan_state: 'no_plan' });
      await sendOwner(c, 'plan', copy.NO_PLAN);
      return;
    case 'status': {
      const open = await openTasks(c.db, c.today);
      await saveStatusOrder(c, open);
      await sendOwner(c, 'receipt', copy.statusList(open, await doneTodayCount(c), c.tz));
      return;
    }
    case 'undo':
      await tryUndo(c);
      return;
    case 'help':
      await sendOwner(c, 'receipt', copy.HELP);
      return;
    case 'settings':
      await sendOwner(
        c,
        'receipt',
        `TZ ${c.user.timezone} · morning ${c.user.morning_time} · evening ${c.user.evening_time} · work ${c.user.work_start}-${c.user.work_end} · quiet ${c.user.quiet_start}-${c.user.quiet_end} · nag ${c.user.nag_level} · pulse ${c.user.pulse_every_min}m`,
      );
      return;
    case 'naglevel':
      await updateUserField(c.db, 'nag_level', effective.level as NagLevel);
      await sendOwner(c, 'receipt', `Nag level: ${effective.level}. 🫡`);
      return;
    case 'add':
      await addTask(c, effective.title, effective.time);
      return;
    case 'freetext':
      await sendOwner(c, 'receipt', copy.KEYWORDS_FALLBACK);
      return;
    default:
      break;
  }

  // Task-targeted ops
  const t = await resolveTask(c, 'taskRef' in effective ? effective.taskRef : undefined);
  if (!t) {
    await clarify(c);
    return;
  }
  switch (effective.op) {
    case 'done':
      await completeTask(c, t, 'text');
      return;
    case 'start':
      await startTask(c, t);
      return;
    case 'snooze':
      await snoozeTask(c, t, effective.minutes);
      return;
    case 'tomorrow':
      await deferTask(c, t);
      return;
    case 'notdone':
      await notDoneTask(c, t);
      return;
    case 'blocked':
      await blockTask(c, t, effective.reason);
      return;
    case 'drop':
      await dropTask(c, t, effective.reason);
      return;
    default:
      await sendOwner(c, 'receipt', copy.KEYWORDS_FALLBACK);
  }
}

const POSITIVE_REACTIONS = ['love', 'like', 'heart', 'thumbsup', '👍', '❤', '♥', '🩶', '🤍', '💯'];
const NEGATIVE_REACTIONS = ['dislike', 'thumbsdown', '👎'];

async function handleReaction(c: Ctx, reaction: string, refMessageId: string | null): Promise<void> {
  if (!refMessageId) return;
  const out = await outboundByMessageId(c.db, refMessageId);
  if (!out?.task_id) return;
  const t = await getTask(c.db, out.task_id);
  if (!t || ['done', 'dropped', 'stuck'].includes(t.status)) return;
  const r = reaction.toLowerCase();
  if (POSITIVE_REACTIONS.some((p) => r.includes(p))) {
    await completeTask(c, t, 'reaction');
  } else if (NEGATIVE_REACTIONS.some((n) => r.includes(n))) {
    await notDoneTask(c, t);
  }
}

async function handleInboundCore(env: AppEnv, inbound: Inbound, now: number): Promise<string | undefined> {
  const c = await buildCtx(env, now);
  if (inbound.kind === 'ignored') return undefined;
  if (!c) return 'no user configured (run /setup)';

  if (inbound.kind === 'status') {
    if (inbound.refMessageId) {
      const out = await outboundByMessageId(c.db, inbound.refMessageId);
      if (out) await setOutboundStatus(c.db, out.id, inbound.status === 'failed' ? 'failed' : 'delivered');
    }
    return undefined;
  }

  const owner = env.OWNER_CONTACT ?? c.user.contact;
  if (normContact(inbound.from) !== normContact(owner)) {
    console.error(JSON.stringify({ evt: 'inbound_not_owner' }));
    return 'not owner';
  }
  if (inbound.kind === 'text') await routeText(c, inbound.text);
  else await handleReaction(c, inbound.reaction, inbound.refMessageId);
  return undefined;
}

export async function processInbound(env: AppEnv, inbound: Inbound): Promise<void> {
  await ensureSchema(env.DB);
  const fresh = await tryInsertInbound(env.DB, inbound.dedupeId, JSON.stringify(inbound));
  if (!fresh) return;
  try {
    const note = await handleInboundCore(env, inbound, Date.now());
    await markInboundProcessed(env.DB, inbound.dedupeId, note);
  } catch (err) {
    // Leave unprocessed only on crash-before-this-line; here we record the error.
    await markInboundProcessed(env.DB, inbound.dedupeId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

// -- Trello webhook ---------------------------------------------------------

export async function handleTrelloWebhook(env: AppEnv, body: unknown): Promise<void> {
  const c = await buildCtx(env, Date.now());
  if (!c) return;
  const action = parseTrelloAction(body);
  if (!action) return;
  if (await recentTrelloEcho(c.db, action.cardId, c.now - 10 * 60_000)) return;

  const todayListId = await getSetting(c.db, 'trello_today_list_id');
  const doneListId = await getSetting(c.db, 'trello_done_list_id');
  const session = await ensureSession(c.db, c.today);

  if (action.t === 'created') {
    if (!todayListId || action.listId !== todayListId) return;
    if (await taskByCard(c.db, action.cardId)) return;
    const id = await createTask(c.db, {
      trello_card_id: action.cardId,
      title: action.name,
      source_local_date: c.today,
      due_at_utc: action.due ? Date.parse(action.due) || null : null,
      created_by: 'trello',
    });
    await appendEvent(c.db, id, 'created', { via: 'trello' });
    if (session.plan_state === 'confirmed') {
      await updateTask(c.db, id, { pending_prompt: JSON.stringify({ type: 'add_time' }) });
      const t = await getTask(c.db, id);
      if (t) await sendOwner(c, 'receipt', `Saw "${t.title}" land on Trello — what time today should I chase it?`, id);
    }
    return;
  }

  const t = await taskByCard(c.db, action.cardId);
  if (action.t === 'moved') {
    if (doneListId && action.toListId === doneListId) {
      if (t && !['done', 'dropped'].includes(t.status)) await completeTask(c, t, 'trello');
      return;
    }
    if (todayListId && action.toListId === todayListId && !t) {
      const id = await createTask(c.db, {
        trello_card_id: action.cardId,
        title: action.name,
        source_local_date: c.today,
        created_by: 'trello',
      });
      await appendEvent(c.db, id, 'created', { via: 'trello_move' });
      return;
    }
    if (t && !['done', 'dropped', 'stuck'].includes(t.status) && action.toListId !== todayListId) {
      await updateTask(c.db, t.id, { status: 'dropped', pending_prompt: null });
      await appendEvent(c.db, t.id, 'dropped', { reason: 'moved out of Today in Trello' });
    }
    return;
  }
  if (action.t === 'renamed' && t) {
    await updateTask(c.db, t.id, { title: action.name });
    return;
  }
  if (action.t === 'archived' && t && !['done', 'dropped'].includes(t.status)) {
    await updateTask(c.db, t.id, { status: 'dropped', pending_prompt: null });
    await appendEvent(c.db, t.id, 'dropped', { reason: 'archived in Trello' });
  }
}

// -- scheduled tick ---------------------------------------------------------

async function buildRecap(c: Ctx): Promise<copy.RecapStats> {
  const dayStart = utcForLocalDateTime(c.tz, c.today, '00:00');
  const events = await eventsInRange(c.db, dayStart, c.now + 1);
  const titles = new Map<number, string>();
  const titleOf = async (taskId: number): Promise<string> => {
    const cached = titles.get(taskId);
    if (cached) return cached;
    const t = await getTask(c.db, taskId);
    const name = t?.title ?? `task ${taskId}`;
    titles.set(taskId, name);
    return name;
  };
  const pick = async (kind: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of events.filter((e) => e.kind === kind)) out.push(await titleOf(e.task_id));
    return [...new Set(out)];
  };
  const open = await openTasks(c.db, c.today);
  const deferPatterns = open
    .filter((t) => t.consecutive_deferrals >= 2)
    .map((t) => `"${t.title}" has been deferred ${t.consecutive_deferrals} days running.`);
  return {
    done: await pick('completed'),
    recommitted: await pick('recommitted'),
    dropped: await pick('dropped'),
    stuck: await pick('stuck'),
    open: open.map((t) => t.title),
    deferPatterns,
  };
}

async function weeklyIfDue(c: Ctx, session: SessionRow): Promise<void> {
  if (c.parts.weekday !== 'Sun' || session.weekly_sent) return;
  const events = await eventsInRange(c.db, c.now - 7 * 86_400_000, c.now + 1);
  const completed = events.filter((e) => e.kind === 'completed').length;
  const dropped = events.filter((e) => e.kind === 'dropped').length;
  const deferred = events.filter((e) => e.kind === 'deferred');
  const byTask = new Map<number, number>();
  for (const e of deferred) byTask.set(e.task_id, (byTask.get(e.task_id) ?? 0) + 1);
  let worst: string | null = null;
  let worstCount = 1;
  for (const [taskId, count] of byTask) {
    if (count > worstCount) {
      worstCount = count;
      worst = (await getTask(c.db, taskId))?.title ?? null;
    }
  }
  await sendOwner(c, 'recap', copy.weeklyRecap(completed, dropped, deferred.length, worst));
  await updateSession(c.db, c.today, { weekly_sent: 1 });
}

export async function tick(env: AppEnv, nowMs: number): Promise<void> {
  await ensureSchema(env.DB);
  await setSetting(env.DB, 'last_cron_at', String(nowMs));
  const c = await buildCtx(env, nowMs);
  if (!c) return;
  const session = await ensureSession(c.db, c.today);
  const quiet = inQuietHours(c.user, c.parts);
  const morningMin = hhmmToMin(c.user.morning_time);
  const eveningMin = hhmmToMin(c.user.evening_time);

  // Morning planning
  if (!quiet && session.plan_state === 'unplanned' && c.parts.minOfDay >= morningMin) {
    if (c.parts.minOfDay >= eveningMin) {
      await updateSession(c.db, c.today, { plan_state: 'no_plan' }); // day already over; stay quiet
    } else {
      await morningPrompt(c, session);
    }
  } else if (session.plan_state === 'prompted' && session.prompted_at_utc) {
    const elapsed = c.now - session.prompted_at_utc;
    if (elapsed > 4 * 3_600_000 && session.nudges_sent >= 2) {
      await updateSession(c.db, c.today, { plan_state: 'no_plan' });
    } else if (elapsed > 3 * 3_600_000 && session.nudges_sent === 1 && !quiet) {
      await sendOwner(c, 'plan', copy.PLAN_NUDGE_FINAL);
      await updateSession(c.db, c.today, { nudges_sent: 2 });
    } else if (elapsed > 45 * 60_000 && session.nudges_sent === 0 && !quiet) {
      await sendOwner(c, 'plan', copy.PLAN_NUDGE_1);
      await updateSession(c.db, c.today, { nudges_sent: 1 });
    }
  }

  // Nags + started check-ins
  if (!quiet) {
    const due = await dueTasks(c.db, c.now, c.today);
    const policy = nagPolicy(c.user.nag_level);
    for (const t of due) {
      if (!shouldRenag(policy, t.nags_sent_today, t.last_nag_at_utc, c.now)) {
        if (policy.maxPerTask !== null && t.nags_sent_today >= policy.maxPerTask) {
          await updateTask(c.db, t.id, { next_action_at_utc: null }); // capped; recap picks it up
          await appendEvent(c.db, t.id, 'nag_capped');
        }
        continue;
      }
      const body = t.status === 'started' ? copy.startedCheckin(t) : copy.nagMsg(t, t.nags_sent_today === 0);
      await sendOwner(c, t.status === 'started' ? 'checkin' : 'nag', body, t.id);
      await updateTask(c.db, t.id, {
        status: t.status === 'started' ? 'started' : 'nagging',
        nags_sent_today: t.nags_sent_today + 1,
        last_nag_at_utc: c.now,
        next_action_at_utc: c.now + policy.intervalMin * 60_000,
      });
      await appendEvent(c.db, t.id, 'reminded');
      await setSetting(c.db, 'last_nagged_task', String(t.id));
    }

    // Pulse
    const open = await openTasks(c.db, c.today);
    const pulseOk = shouldPulse(c.user, {
      parts: c.parts,
      nowUtc: c.now,
      lastPulseAtUtc: await lastOutboundAt(c.db, ['pulse']),
      lastExchangeAtUtc: Math.max((await lastInboundAt(c.db)) ?? 0, (await lastOutboundAt(c.db, OUTBOUND_KINDS)) ?? 0) || null,
      openCount: open.length,
    });
    if (pulseOk && session.plan_state === 'confirmed') {
      await saveStatusOrder(c, open);
      await sendOwner(c, 'pulse', copy.pulseMsg(open, await doneTodayCount(c), c.tz));
    }
  }

  // Evening recap
  if (c.parts.minOfDay >= eveningMin && !session.recap_sent_at_utc && session.plan_state !== 'unplanned') {
    await sendOwner(c, 'recap', copy.eveningRecap(await buildRecap(c)));
    await updateSession(c.db, c.today, { recap_sent_at_utc: c.now });
    await weeklyIfDue(c, session);
  }

  // Durable-inbox sweep: rows the worker crashed on before marking processed
  const stale = await unprocessedInbound(c.db, c.now - 90_000);
  for (const row of stale) {
    try {
      const note = await handleInboundCore(env, JSON.parse(row.raw) as Inbound, c.now);
      await markInboundProcessed(c.db, row.dedupe_id, note);
    } catch (err) {
      await markInboundProcessed(c.db, row.dedupe_id, `sweep: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Outbound retries
  for (const row of await failedOutbound(c.db)) {
    const res = await getChannel(env).send(env, c.user.contact, row.body);
    await setOutboundStatus(c.db, row.id, res ? 'sent' : 'failed', row.retry_count + 1);
  }
}

// -- setup ------------------------------------------------------------------

interface SetupStep {
  name: string;
  ok: boolean;
  note: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function runSetup(env: AppEnv, requestUrl: URL): Promise<string> {
  const steps: SetupStep[] = [];
  const origin = requestUrl.origin;
  const sendTest = requestUrl.searchParams.get('test') === '1';

  await ensureSchema(env.DB);
  steps.push({ name: 'Database schema', ok: true, note: 'migrations applied' });

  let user = await getUser(env.DB);
  if (!user && env.OWNER_CONTACT) {
    await upsertUser(env.DB, {
      contact: env.OWNER_CONTACT,
      timezone: env.TIMEZONE || 'America/Los_Angeles',
      morning_time: env.MORNING_TIME || '08:00',
      evening_time: env.EVENING_TIME || '20:30',
      work_start: env.WORK_START || '09:00',
      work_end: env.WORK_END || '18:00',
      quiet_start: env.QUIET_START || '22:00',
      quiet_end: env.QUIET_END || '07:30',
      nag_level: env.NAG_LEVEL || 'standard',
      pulse_every_min: Number(env.PULSE_EVERY_MIN || '150'),
    });
    user = await getUser(env.DB);
  }
  const contactNote = user ? `owner ···${user.contact.slice(-4)}, tz ${user.timezone}` : 'set the OWNER_CONTACT secret, then reload';
  steps.push({ name: 'Owner profile', ok: Boolean(user), note: contactNote });

  steps.push({
    name: 'iMessage credentials (LOOP_AUTH_KEY)',
    ok: Boolean(env.LOOP_AUTH_KEY),
    note: env.LOOP_AUTH_KEY ? 'present' : 'missing — add the secret in the dashboard',
  });
  steps.push({
    name: 'Webhook guards (LOOP_WEBHOOK_AUTH + WEBHOOK_TOKEN)',
    ok: Boolean(env.LOOP_WEBHOOK_AUTH && env.WEBHOOK_TOKEN),
    note: env.LOOP_WEBHOOK_AUTH && env.WEBHOOK_TOKEN ? 'present' : 'missing — add both secrets',
  });

  if (trelloConfigured(env)) {
    const member = await getMemberName(env);
    steps.push({ name: 'Trello auth', ok: Boolean(member), note: member ? `authed as ${member}` : 'key/token rejected' });
    const lists = await getLists(env);
    if (lists) {
      const wantToday = (env.TRELLO_TODAY_LIST || 'Today').toLowerCase();
      const wantDone = (env.TRELLO_DONE_LIST || 'Done').toLowerCase();
      const today = lists.find((l) => l.name.toLowerCase() === wantToday);
      const done = lists.find((l) => l.name.toLowerCase() === wantDone);
      if (today) await setSetting(env.DB, 'trello_today_list_id', today.id);
      if (done) await setSetting(env.DB, 'trello_done_list_id', done.id);
      steps.push({
        name: 'Trello lists',
        ok: Boolean(today && done),
        note:
          today && done
            ? `"${today.name}" and "${done.name}" resolved`
            : `board needs lists named "${env.TRELLO_TODAY_LIST || 'Today'}" and "${env.TRELLO_DONE_LIST || 'Done'}"`,
      });
      if (env.WEBHOOK_TOKEN) {
        const cb = `${origin}/webhook/trello/${env.WEBHOOK_TOKEN}`;
        const wh = await registerWebhook(env, cb);
        steps.push({ name: 'Trello webhook', ok: wh !== 'failed', note: wh });
      }
    } else {
      steps.push({ name: 'Trello lists', ok: false, note: 'could not load board lists' });
    }
  } else {
    steps.push({ name: 'Trello (optional)', ok: true, note: 'not configured — bot runs standalone' });
  }

  const coreReady = Boolean(user && env.LOOP_AUTH_KEY && env.LOOP_WEBHOOK_AUTH && env.WEBHOOK_TOKEN);
  if (sendTest && coreReady && user) {
    const res = await getChannel(env).send(env, user.contact, copy.SETUP_TEST);
    steps.push({ name: 'Test message', ok: Boolean(res), note: res ? 'sent — check your phone' : 'send failed (see logs)' });
  }
  if (coreReady) await setSetting(env.DB, 'setup_complete', '1');

  const loopWebhookUrl = env.WEBHOOK_TOKEN ? `${origin}/webhook/loop/${env.WEBHOOK_TOKEN}` : '(set WEBHOOK_TOKEN first)';
  const rows = steps
    .map(
      (s) =>
        `<tr><td>${s.ok ? '✅' : '❌'}</td><td>${esc(s.name)}</td><td>${esc(s.note)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><title>Accountability Bot — Setup</title>
<body style="font-family:-apple-system,system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;line-height:1.5">
<h1>🤖 Accountability Bot — Setup</h1>
<table cellpadding="6">${rows}</table>
<h2>Wire up LoopMessage</h2>
<p>In the LoopMessage dashboard → Webhooks, set the callback URL to:</p>
<pre style="background:#f4f4f4;padding:10px;overflow-x:auto">${esc(loopWebhookUrl)}</pre>
<p>…and set its <b>Authorization</b> header to the same value as your <code>LOOP_WEBHOOK_AUTH</code> secret.</p>
<p><a href="?key=${esc(requestUrl.searchParams.get('key') ?? '')}&test=1">Send a test iMessage →</a></p>
<p>${coreReady ? 'Core is ready. Text the bot "help" to begin. 🫡' : 'Fix the ❌ rows above, then reload this page.'}</p>
</body>`;
}
