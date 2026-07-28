// The orchestrator: conversation routing, the daily lifecycle (plan → nag →
// pulse → recap), the escalation ladder, and Trello two-way sync. Everything
// stateful goes through db.ts; everything outbound goes through sendOwner().

import type { AppEnv } from '../env';
import {
  appendEvent,
  claimInbound,
  claimOutboundRetry,
  claimSessionOutbound,
  claimSessionFields,
  claimSettingLease,
  claimTaskNagOutbound,
  completeOutboundAttempt,
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
  recentInboundTexts,
  recentOutboundBodies,
  recentTrelloEcho,
  recordInboundFailure,
  renewInboundClaim,
  renewOutboundAttempt,
  setOutboundStatusByMessageId,
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
import { parseDeterministic, type Command, type NagLevel } from '../parse';
import { interpret, reflect, type BrainAction } from './brain';
import { ladderStage } from './ladder';
import { inQuietHours, nagPolicy, nagsSentToday, shouldPulse, shouldRenag } from './nag';
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
import { encodeDeliveryAttemptMetadata, getChannel, type Inbound, type SendOpts } from '../channel';

const OUTBOUND_KINDS = ['nag', 'checkin', 'pulse', 'plan', 'recap', 'receipt', 'chat', 'misc'];
const PLAN_SLOTS = ['10:00', '14:00', '16:30'];
const MAX_INBOUND_ATTEMPTS = 5;
const INBOUND_LEASE_MS = 5 * 60_000;
const SCHEDULER_LEASE_MS = 5 * 60_000;

interface InboundLeaseHeartbeat {
  stop(): Promise<boolean>;
}

interface OutboundLeaseHeartbeat {
  stop(): Promise<boolean>;
}

function startOutboundLeaseHeartbeat(
  db: D1Database,
  id: number,
  claimToken: string,
  leaseMs: number,
): OutboundLeaseHeartbeat {
  let stopped = false;
  let ownershipLost = false;
  let renewal: Promise<void> | null = null;
  let stopPromise: Promise<boolean> | null = null;
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const renew = (): void => {
    if (stopped || ownershipLost || renewal) return;
    const active = renewOutboundAttempt(db, id, claimToken, Date.now(), leaseMs)
      .then((owned) => {
        if (!owned) ownershipLost = true;
      })
      .catch(() => {
        ownershipLost = true;
      })
      .finally(() => {
        if (renewal === active) renewal = null;
      });
    renewal = active;
  };
  const timer = setInterval(renew, intervalMs);
  return {
    stop(): Promise<boolean> {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(timer);
      stopPromise = (async () => {
        if (renewal) await renewal;
        if (ownershipLost) return false;
        const owned = await renewOutboundAttempt(db, id, claimToken, Date.now(), leaseMs);
        if (!owned) ownershipLost = true;
        return owned;
      })();
      return stopPromise;
    },
  };
}

function startInboundLeaseHeartbeat(
  db: D1Database,
  dedupeId: string,
  claimToken: string,
  leaseMs: number,
): InboundLeaseHeartbeat {
  let stopped = false;
  let ownershipLost = false;
  let renewal: Promise<void> | null = null;
  let stopPromise: Promise<boolean> | null = null;
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));

  const logRenewalFailure = (err: unknown): void => {
    console.error(
      JSON.stringify({
        evt: 'inbound_lease_renew_failed',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  };

  const renew = (): void => {
    if (stopped || ownershipLost || renewal) return;
    const active = renewInboundClaim(db, dedupeId, claimToken, Date.now(), leaseMs)
      .then(
        (owned) => {
          if (!owned) ownershipLost = true;
        },
        (err: unknown) => {
          ownershipLost = true;
          logRenewalFailure(err);
        },
      )
      .finally(() => {
        if (renewal === active) renewal = null;
      });
    renewal = active;
  };

  const timer = setInterval(renew, intervalMs);
  return {
    stop(): Promise<boolean> {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(timer);
      stopPromise = (async () => {
        if (renewal) await renewal;
        if (ownershipLost) return false;
        try {
          const owned = await renewInboundClaim(db, dedupeId, claimToken, Date.now(), leaseMs);
          if (!owned) ownershipLost = true;
          return owned;
        } catch (err) {
          ownershipLost = true;
          logRenewalFailure(err);
          return false;
        }
      })();
      return stopPromise;
    },
  };
}

interface Ctx {
  env: AppEnv;
  db: D1Database;
  user: UserRow;
  tz: string;
  now: number;
  parts: LocalParts;
  today: string;
}

async function deliverySendOpts(
  env: AppEnv,
  db: D1Database,
  outboundId: number,
  attemptToken: string,
  taskId?: number | null,
): Promise<SendOpts> {
  const origin = await getSetting(db, 'public_origin');
  let statusCallbackUrl: string | undefined;
  if (origin && env.WEBHOOK_TOKEN) {
    const callback = new URL(`${origin}/webhook/loop/${env.WEBHOOK_TOKEN}`);
    callback.searchParams.set('outbound_id', String(outboundId));
    callback.searchParams.set('attempt_token', attemptToken);
    statusCallbackUrl = callback.toString();
  }
  return {
    passthrough: encodeDeliveryAttemptMetadata(outboundId, attemptToken, taskId ?? null),
    ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
  };
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
  const claimToken = crypto.randomUUID();
  const id = await logOutbound(c.db, {
    kind,
    task_id: taskId ?? null,
    trello_card_id: trelloCardId ?? null,
    body,
    status: 'retrying',
    attempt_token: claimToken,
    lease_until_utc: Date.now() + SCHEDULER_LEASE_MS,
  });
  await dispatchOutboundAttempt(c, id, claimToken, body, taskId ?? null, 0);
}

async function dispatchOutboundAttempt(
  c: Ctx,
  id: number,
  claimToken: string,
  body: string,
  taskId: number | null,
  retryCount: number,
): Promise<void> {
  let owned = false;
  try {
    owned = await renewOutboundAttempt(c.db, id, claimToken, Date.now(), SCHEDULER_LEASE_MS);
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: 'outbound_preflight_failed',
        outboundId: id,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }
  if (!owned) return;
  const heartbeat = startOutboundLeaseHeartbeat(c.db, id, claimToken, SCHEDULER_LEASE_MS);
  try {
    const res = await getChannel(c.env).send(
      c.env,
      c.user.contact,
      body,
      await deliverySendOpts(c.env, c.db, id, claimToken, taskId),
    );
    if (await heartbeat.stop()) {
      await completeOutboundAttempt(c.db, id, claimToken, res ? 'sent' : 'failed', retryCount, res?.messageId);
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: 'owner_send_failed',
        outboundId: id,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    if (await heartbeat.stop()) await completeOutboundAttempt(c.db, id, claimToken, 'failed', retryCount);
  } finally {
    await heartbeat.stop();
  }
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

type AddSpec = Extract<BrainAction, { type: 'add_task' }>;

// Resolve a deadline to a concrete UTC instant. Relative offset wins; then an
// absolute date (+time, default 5pm); then a bare time today.
function resolveDue(c: Ctx, spec: AddSpec): number | null {
  if (spec.due_in_minutes !== null) return c.now + spec.due_in_minutes * 60_000;
  if (spec.due_date) return utcForLocalDateTime(c.tz, spec.due_date, spec.due_time ?? '17:00');
  if (spec.due_time) {
    let at = utcForLocalDateTime(c.tz, c.today, spec.due_time);
    if (at <= c.now) at = utcForLocalDateTime(c.tz, addDaysLocal(c.tz, c.today, 1), spec.due_time); // 5pm already gone → tomorrow 5pm
    return at;
  }
  return null;
}

// Resolve the first-nag time. Relative offset is trusted as-is (this is the
// fix for "in 24 hours" — 1440 min from now, NOT a clock time that collapses
// to the past). Absolute date/time rolls to tomorrow if already past today.
function resolveRemind(c: Ctx, spec: AddSpec, dueUtc: number | null): number | null {
  if (spec.remind_in_minutes !== null) return c.now + spec.remind_in_minutes * 60_000;
  if (spec.remind_date) return utcForLocalDateTime(c.tz, spec.remind_date, spec.remind_time ?? '09:00');
  if (spec.remind_time) {
    let at = utcForLocalDateTime(c.tz, c.today, spec.remind_time);
    if (at <= c.now) at = utcForLocalDateTime(c.tz, addDaysLocal(c.tz, c.today, 1), spec.remind_time);
    return at;
  }
  if (dueUtc && dueUtc - c.now < 24 * 3_600_000) return Math.max(c.now + 60_000, dueUtc - 60 * 60_000); // due soon → warn an hour out
  return null;
}

async function createTaskFromSpec(c: Ctx, spec: AddSpec): Promise<TaskRow | null> {
  const dueUtc = resolveDue(c, spec);
  let remindAt = resolveRemind(c, spec, dueUtc);
  // Only a tiny guard against processing lag — never the old 5-minute snap.
  if (remindAt !== null && remindAt <= c.now) remindAt = c.now + 60_000;
  const startDate = remindAt ? localParts(remindAt, c.tz).localDate : c.today;

  let cardId: string | null = null;
  if (trelloConfigured(c.env)) {
    const todayListId = await getSetting(c.db, 'trello_today_list_id');
    if (todayListId) {
      const card = await createCard(c.env, todayListId, spec.title, dueUtc ? new Date(dueUtc).toISOString() : undefined);
      if (card) {
        cardId = card.id;
        await logOutbound(c.db, { kind: 'trello_create', trello_card_id: cardId, body: spec.title });
      }
    }
  }
  const id = await createTask(c.db, {
    trello_card_id: cardId,
    title: spec.title,
    source_local_date: startDate,
    due_at_utc: dueUtc,
    next_action_at_utc: remindAt,
    created_by: 'owner',
  });
  await appendEvent(c.db, id, 'created', { via: 'text' });
  return getTask(c.db, id);
}

// Always sends a short, deterministic confirmation of exactly what was
// logged (tasks + times) — never the model's terse "reply" — so a success is
// unmistakable and correctable at a glance.
async function addTasksBatch(c: Ctx, specs: AddSpec[]): Promise<void> {
  const created: TaskRow[] = [];
  for (const spec of specs) {
    const t = await createTaskFromSpec(c, spec);
    if (t) created.push(t);
  }
  if (created.length === 0) return;
  await sendOwner(c, 'receipt', copy.multiAddReceipt(created, c.today, c.tz), created.length === 1 ? (created[0]?.id ?? null) : null);
}

// Deterministic `add: <task> [today|tomorrow] [time]` path.
async function addTask(c: Ctx, title: string, time: string | null, daysAhead = 0): Promise<void> {
  const remind_date = daysAhead > 0 ? addDaysLocal(c.tz, c.today, daysAhead) : null;
  await addTasksBatch(c, [
    { type: 'add_task', title, due_date: null, due_time: null, due_in_minutes: null, remind_date, remind_time: time, remind_in_minutes: null },
  ]);
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

// -- conversational brain routing (v1.1) ------------------------------------

function buildTranscript(
  inbound: Array<{ at: number; body: string }>,
  outbound: Array<{ at: number; body: string }>,
  limit = 12,
): string {
  const merged = [
    ...inbound.map((m) => ({ ...m, who: 'Owner' })),
    ...outbound.map((m) => ({ ...m, who: 'Donna' })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(-limit);
  return merged.map((m) => `${m.who}: ${m.body.slice(0, 160)}`).join('\n');
}

async function setTaskTime(c: Ctx, t: TaskRow, time: string, date: string | null): Promise<void> {
  const d = date ?? c.today;
  let at = utcForLocalDateTime(c.tz, d, time);
  if (at <= c.now && !date) at = utcForLocalDateTime(c.tz, addDaysLocal(c.tz, c.today, 1), time);
  await saveUndo(c, t);
  const fields: Record<string, string | number | null> = { next_action_at_utc: at, status: 'pending' };
  if (date && date > c.today) fields.source_local_date = date;
  await updateTask(c.db, t.id, fields);
  await appendEvent(c.db, t.id, 'recommitted', { time, date: date ?? null });
  await sendOwner(c, 'receipt', copy.recommitReceipt(t, copy.fmtLocalTime(at, c.tz)), t.id);
}

async function runBrainAction(c: Ctx, session: SessionRow, action: BrainAction, open: TaskRow[]): Promise<void> {
  const byRef = (n: number): TaskRow | null => open[n - 1] ?? null;
  switch (action.type) {
    case 'complete': {
      const t = byRef(action.task);
      if (t) await completeTask(c, t, 'text');
      else await clarify(c);
      return;
    }
    case 'start': {
      const t = byRef(action.task);
      if (t) await startTask(c, t);
      return;
    }
    case 'notdone': {
      const t = byRef(action.task);
      if (t) await notDoneTask(c, t);
      return;
    }
    case 'snooze': {
      const t = byRef(action.task);
      if (t) await snoozeTask(c, t, action.minutes);
      return;
    }
    case 'defer': {
      const t = byRef(action.task);
      if (t) await deferTask(c, t);
      return;
    }
    case 'drop': {
      const t = byRef(action.task);
      if (t) await dropTask(c, t, action.reason ?? undefined);
      return;
    }
    case 'blocked': {
      const t = byRef(action.task);
      if (t) await blockTask(c, t, action.reason);
      return;
    }
    case 'set_time': {
      const t = byRef(action.task);
      if (t) await setTaskTime(c, t, action.time, action.date);
      else await clarify(c);
      return;
    }
    case 'status': {
      const fresh = await openTasks(c.db, c.today);
      await saveStatusOrder(c, fresh);
      await sendOwner(c, 'receipt', copy.statusList(fresh, await doneTodayCount(c), c.tz));
      return;
    }
    case 'plan':
      await morningPrompt(c, session);
      return;
    case 'no_plan':
      await updateSession(c.db, c.today, { plan_state: 'no_plan' });
      await sendOwner(c, 'plan', copy.NO_PLAN);
      return;
    case 'confirm_plan':
      await confirmPlan(c);
      return;
    case 'undo':
      await tryUndo(c);
      return;
    case 'help':
      await sendOwner(c, 'receipt', copy.HELP);
      return;
    case 'set_nag':
      await updateUserField(c.db, 'nag_level', action.level);
      await sendOwner(c, 'receipt', `Nag level: ${action.level}. 🫡`);
      return;
    case 'set_persona':
      await setSetting(c.db, 'persona_directive', action.directive.slice(0, 240));
      await sendOwner(c, 'receipt', copy.personaReceipt(action.directive.slice(0, 240)));
      return;
    default:
      return;
  }
}

async function brainRoute(c: Ctx, session: SessionRow, text: string): Promise<void> {
  const open = await openTasks(c.db, c.today);
  await saveStatusOrder(c, open);
  const transcript = buildTranscript(await recentInboundTexts(c.db, 10), await recentOutboundBodies(c.db, 10));
  const styleCard = await getSetting(c.db, 'style_card');
  const schedInsights = await getSetting(c.db, 'sched_insights');
  const persona = await getSetting(c.db, 'persona_directive');
  const result = await interpret(c.env, {
    text,
    tasks: open,
    transcript,
    parts: c.parts,
    planState: session.plan_state,
    persona: persona || null,
    styleCard: styleCard || null,
    schedInsights: schedInsights || null,
    todayLocal: c.today,
    tz: c.tz,
  });
  if (!result) {
    // Rare now (parsing is retried + shape-tolerant). Never interrogate —
    // acknowledge and move on; the reflection loop still sees the message.
    await sendOwner(c, 'chat', copy.SOFT_ACK);
    return;
  }
  if (result.actions.length === 0) {
    // Pure conversation. Reply in her learned voice; never ask a question.
    await sendOwner(c, 'chat', result.reply ?? copy.SOFT_ACK);
    return;
  }
  const adds: AddSpec[] = [];
  for (const action of result.actions) {
    if (action.type === 'add_task') adds.push(action);
    else await runBrainAction(c, session, action, open);
  }
  if (adds.length > 0) await addTasksBatch(c, adds);
}

// -- nightly reflection (v1.2) ----------------------------------------------

async function buildReflectionStats(c: Ctx): Promise<string> {
  const events = await eventsInRange(c.db, c.now - 7 * 86_400_000, c.now + 1);
  const completed = events.filter((e) => e.kind === 'completed');
  const deferred = events.filter((e) => e.kind === 'deferred');
  const dropped = events.filter((e) => e.kind === 'dropped');
  const hourTally = new Map<number, number>();
  for (const e of completed) {
    const hh = localParts(e.at_utc, c.tz).hh;
    hourTally.set(hh, (hourTally.get(hh) ?? 0) + 1);
  }
  const topHours = [...hourTally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([hh]) => `${hh}:00`);
  const deferTally = new Map<number, number>();
  for (const e of deferred) deferTally.set(e.task_id, (deferTally.get(e.task_id) ?? 0) + 1);
  const worst = [...deferTally.entries()].sort((a, b) => b[1] - a[1])[0];
  const worstTitle = worst ? ((await getTask(c.db, worst[0]))?.title ?? null) : null;
  const bits = [
    `last 7d: ${completed.length} completed, ${deferred.length} deferrals, ${dropped.length} dropped`,
    topHours.length ? `completions cluster around ${topHours.join(' and ')}` : '',
    worstTitle ? `most deferred: "${worstTitle}" (${worst?.[1]}x)` : '',
  ];
  return bits.filter(Boolean).join('; ');
}

// Same-day first learning: once she has a little material, run one reflection
// before the first evening so adaptation is visible on day one instead of
// after a full night.
async function maybeEarlySeed(c: Ctx): Promise<void> {
  if (await getSetting(c.db, 'seed_done')) return;
  if (await getSetting(c.db, 'style_card')) {
    await setSetting(c.db, 'seed_done', '1');
    return;
  }
  const inbound = await recentInboundTexts(c.db, 8);
  if (inbound.length < 6) return;
  await setSetting(c.db, 'seed_done', '1');
  await nightlyReflection(c);
}

async function nightlyReflection(c: Ctx): Promise<void> {
  if ((await getSetting(c.db, 'reflect_date')) === c.today) return;
  await setSetting(c.db, 'reflect_date', c.today); // one attempt per day, even on failure
  const transcript = buildTranscript(await recentInboundTexts(c.db, 15), await recentOutboundBodies(c.db, 15), 20);
  if (!transcript) return; // nothing to learn from yet
  const stats = await buildReflectionStats(c);
  const r = await reflect(c.env, c.today, {
    transcript,
    stats,
    persona: (await getSetting(c.db, 'persona_directive')) || null,
    currentStyle: (await getSetting(c.db, 'style_card')) || null,
    currentInsights: (await getSetting(c.db, 'sched_insights')) || null,
  });
  if (r) {
    if (r.style) await setSetting(c.db, 'style_card', r.style);
    if (r.insights) await setSetting(c.db, 'sched_insights', r.insights);
    console.error(JSON.stringify({ evt: 'reflection_updated' }));
  }
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

interface PreparedMorningPrompt {
  planBody: string;
  stuckReviewBody: string | null;
}

async function prepareMorningPrompt(c: Ctx): Promise<PreparedMorningPrompt> {
  const stuck = await stuckTasks(c.db);
  let stuckReviewBody: string | null = null;
  if (stuck.length > 0 && (await getSetting(c.db, 'stuck_review_date')) !== c.today) {
    stuckReviewBody = copy.stuckReview(stuck);
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
  return { planBody: copy.planPrompt(open, map, c.tz), stuckReviewBody };
}

async function morningPrompt(c: Ctx, session: SessionRow): Promise<void> {
  const prepared = await prepareMorningPrompt(c);
  if (prepared.stuckReviewBody) {
    await sendOwner(c, 'plan', prepared.stuckReviewBody);
    await setSetting(c.db, 'stuck_review_date', c.today);
  }
  await sendOwner(c, 'plan', prepared.planBody);
  await claimSessionFields(
    c.db,
    c.today,
    { plan_state: session.plan_state, prompted_at_utc: session.prompted_at_utc },
    { plan_state: 'prompted', prompted_at_utc: c.now },
  );
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

  if (cmd.op === 'freetext') {
    await brainRoute(c, session, text);
    return;
  }
  const effective: Command = cmd;

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
    case 'resetmemory':
      await setSetting(c.db, 'style_card', '');
      await setSetting(c.db, 'sched_insights', '');
      await sendOwner(c, 'receipt', copy.MEMORY_RESET);
      return;
    case 'persona':
      await setSetting(c.db, 'persona_directive', effective.directive.slice(0, 240));
      await sendOwner(c, 'receipt', copy.personaReceipt(effective.directive.slice(0, 240)));
      return;
    case 'personaclear':
      await setSetting(c.db, 'persona_directive', '');
      await sendOwner(c, 'receipt', copy.PERSONA_CLEARED);
      return;
    case 'resync': {
      const beforeStyle = (await getSetting(c.db, 'style_card')) || '(nothing yet)';
      await setSetting(c.db, 'reflect_date', ''); // bypass the once-a-day guard for an on-demand re-learn
      await nightlyReflection(c);
      const afterStyle = (await getSetting(c.db, 'style_card')) || '(nothing yet)';
      const afterInsights = (await getSetting(c.db, 'sched_insights')) || '(nothing yet)';
      const order = await getSetting(c.db, 'persona_directive');
      const orderLine = order ? `\n\n🎭 Your standing order (locked): "${order}"` : '';
      const body =
        beforeStyle === afterStyle
          ? `🧠 Re-read you just now. My read on your style:\n${afterStyle}\n\nYour patterns:\n${afterInsights}${orderLine}`
          : `🧠 Just re-studied you. Updated my read:\n\nBEFORE: ${beforeStyle}\n\nNOW: ${afterStyle}${orderLine}`;
      await sendOwner(c, 'receipt', body);
      return;
    }
    case 'add':
      await addTask(c, effective.title, effective.time, 'daysAhead' in effective ? (effective.daysAhead ?? 0) : 0);
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
    if (inbound.refMessageId || (inbound.outboundId && inbound.attemptToken)) {
      await setOutboundStatusByMessageId(
        c.db,
        inbound.refMessageId,
        inbound.status === 'failed' ? 'failed' : 'delivered',
        inbound.outboundId,
        inbound.attemptToken,
      );
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
  const now = Date.now();
  const claimToken = crypto.randomUUID();
  if (!(await claimInbound(env.DB, inbound.dedupeId, claimToken, now, INBOUND_LEASE_MS, MAX_INBOUND_ATTEMPTS))) return;
  const heartbeat = startInboundLeaseHeartbeat(env.DB, inbound.dedupeId, claimToken, INBOUND_LEASE_MS);
  try {
    const note = await handleInboundCore(env, inbound, now);
    if (await heartbeat.stop()) await markInboundProcessed(env.DB, inbound.dedupeId, note, claimToken);
  } catch (err) {
    if (await heartbeat.stop()) {
      await recordInboundFailure(
        env.DB,
        inbound.dedupeId,
        err instanceof Error ? err.message : String(err),
        MAX_INBOUND_ATTEMPTS,
        claimToken,
      );
    }
    throw err;
  } finally {
    await heartbeat.stop();
  }
}

// -- Trello webhook ---------------------------------------------------------

export async function handleTrelloWebhook(env: AppEnv, body: unknown): Promise<void> {
  const c = await buildCtx(env, Date.now());
  if (!c) return;
  const action = parseTrelloAction(body);
  if (!action) return;
  const todayListId = await getSetting(c.db, 'trello_today_list_id');
  const doneListId = await getSetting(c.db, 'trello_done_list_id');
  const expectedEcho =
    action.t === 'created'
      ? { kind: 'trello_create', detail: action.name }
      : action.t === 'moved' && doneListId !== null && action.toListId === doneListId
        ? { kind: 'trello_move', detail: 'done' }
        : action.t === 'archived'
          ? { kind: 'trello_archive', detail: 'drop' }
          : null;
  if (
    expectedEcho &&
    (await recentTrelloEcho(c.db, action.cardId, c.now - 10 * 60_000, expectedEcho.kind, expectedEcho.detail))
  ) {
    return;
  }

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
  const body = copy.weeklyRecap(completed, dropped, deferred.length, worst);
  const token = crypto.randomUUID();
  const claimed = await claimSessionOutbound(
    c.db,
    c.today,
    { weekly_sent: 0 },
    { weekly_sent: 1 },
    { kind: 'recap', body },
    token,
    Date.now(),
    SCHEDULER_LEASE_MS,
    `session:${c.today}:weekly`,
  );
  if (claimed) await dispatchOutboundAttempt(c, claimed.id, token, body, null, 0);
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
      const prepared = await prepareMorningPrompt(c);
      const token = crypto.randomUUID();
      const claimed = await claimSessionOutbound(
        c.db,
        c.today,
        { plan_state: 'unplanned' },
        { plan_state: 'prompted', prompted_at_utc: c.now },
        { kind: 'plan', body: prepared.planBody },
        token,
        Date.now(),
        SCHEDULER_LEASE_MS,
        `session:${c.today}:morning`,
      );
      if (claimed) {
        if (prepared.stuckReviewBody) {
          await sendOwner(c, 'plan', prepared.stuckReviewBody);
          await setSetting(c.db, 'stuck_review_date', c.today);
        }
        await dispatchOutboundAttempt(c, claimed.id, token, prepared.planBody, null, 0);
      }
    }
  } else if (session.plan_state === 'prompted' && session.prompted_at_utc) {
    const elapsed = c.now - session.prompted_at_utc;
    if (elapsed > 4 * 3_600_000 && session.nudges_sent >= 2) {
      await updateSession(c.db, c.today, { plan_state: 'no_plan' });
    } else if (elapsed > 3 * 3_600_000 && session.nudges_sent === 1 && !quiet) {
      const token = crypto.randomUUID();
      const claimed = await claimSessionOutbound(
        c.db,
        c.today,
        { plan_state: 'prompted', prompted_at_utc: session.prompted_at_utc, nudges_sent: 1 },
        { nudges_sent: 2 },
        { kind: 'plan', body: copy.PLAN_NUDGE_FINAL },
        token,
        Date.now(),
        SCHEDULER_LEASE_MS,
        `session:${c.today}:nudge:2`,
      );
      if (claimed) await dispatchOutboundAttempt(c, claimed.id, token, copy.PLAN_NUDGE_FINAL, null, 0);
    } else if (elapsed > 45 * 60_000 && session.nudges_sent === 0 && !quiet) {
      const token = crypto.randomUUID();
      const claimed = await claimSessionOutbound(
        c.db,
        c.today,
        { plan_state: 'prompted', prompted_at_utc: session.prompted_at_utc, nudges_sent: 0 },
        { nudges_sent: 1 },
        { kind: 'plan', body: copy.PLAN_NUDGE_1 },
        token,
        Date.now(),
        SCHEDULER_LEASE_MS,
        `session:${c.today}:nudge:1`,
      );
      if (claimed) await dispatchOutboundAttempt(c, claimed.id, token, copy.PLAN_NUDGE_1, null, 0);
    }
  }

  // Nags + started check-ins
  if (!quiet) {
    const due = await dueTasks(c.db, c.now, c.today);
    const policy = nagPolicy(c.user.nag_level);
    for (const t of due) {
      const sentToday = nagsSentToday(t, c.today, c.tz);
      if (!shouldRenag(policy, sentToday, t.last_nag_at_utc, c.now)) {
        if (policy.maxPerTask !== null && sentToday >= policy.maxPerTask) {
          await updateTask(c.db, t.id, { next_action_at_utc: null }); // capped; recap picks it up
          await appendEvent(c.db, t.id, 'nag_capped');
        }
        continue;
      }
      const body = t.status === 'started' ? copy.startedCheckin(t) : copy.nagMsg(t, sentToday === 0);
      const nextStatus = t.status === 'started' ? 'started' : 'nagging';
      const token = crypto.randomUUID();
      const claimed = await claimTaskNagOutbound(
        c.db,
        t.id,
        {
          status: t.status,
          next_action_at_utc: t.next_action_at_utc,
          nags_sent_today: t.nags_sent_today,
          last_nag_at_utc: t.last_nag_at_utc,
        },
        {
          status: nextStatus,
          nags_sent_today: sentToday + 1,
          last_nag_at_utc: c.now,
          next_action_at_utc: c.now + policy.intervalMin * 60_000,
        },
        { kind: t.status === 'started' ? 'checkin' : 'nag', task_id: t.id, body },
        token,
        Date.now(),
        SCHEDULER_LEASE_MS,
        `task:${t.id}:nag:${t.next_action_at_utc}`,
      );
      if (!claimed) continue;
      await dispatchOutboundAttempt(c, claimed.id, token, body, t.id, 0);
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
      if (await claimSettingLease(c.db, 'scheduler:pulse', Date.now(), SCHEDULER_LEASE_MS)) {
        await saveStatusOrder(c, open);
        await sendOwner(c, 'pulse', copy.pulseMsg(open, await doneTodayCount(c), c.tz));
      }
    }
  }

  // Evening recap
  let eveningRecapClaimed = false;
  if (c.parts.minOfDay >= eveningMin && !session.recap_sent_at_utc && session.plan_state !== 'unplanned') {
    const body = copy.eveningRecap(await buildRecap(c));
    const token = crypto.randomUUID();
    const claimed = await claimSessionOutbound(
        c.db,
        c.today,
        { plan_state: session.plan_state, recap_sent_at_utc: null },
        { recap_sent_at_utc: c.now },
        { kind: 'recap', body },
        token,
        Date.now(),
        SCHEDULER_LEASE_MS,
        `session:${c.today}:recap`,
      );
    if (claimed) {
      await dispatchOutboundAttempt(c, claimed.id, token, body, null, 0);
      eveningRecapClaimed = true;
      await nightlyReflection(c);
    }
  } else if (!quiet) {
    await maybeEarlySeed(c);
  }
  if (
    c.parts.minOfDay >= eveningMin &&
    session.plan_state !== 'unplanned' &&
    (session.recap_sent_at_utc !== null || eveningRecapClaimed)
  ) {
    await weeklyIfDue(c, session);
  }

  // Durable-inbox sweep: rows the worker crashed on before marking processed
  const stale = await unprocessedInbound(c.db, c.now - 90_000);
  for (const row of stale) {
    const claimToken = crypto.randomUUID();
    const claimNow = Date.now();
    if (!(await claimInbound(c.db, row.dedupe_id, claimToken, claimNow, INBOUND_LEASE_MS, MAX_INBOUND_ATTEMPTS))) continue;
    const heartbeat = startInboundLeaseHeartbeat(c.db, row.dedupe_id, claimToken, INBOUND_LEASE_MS);
    try {
      const note = await handleInboundCore(env, JSON.parse(row.raw) as Inbound, c.now);
      if (await heartbeat.stop()) await markInboundProcessed(c.db, row.dedupe_id, note, claimToken);
    } catch (err) {
      if (await heartbeat.stop()) {
        await recordInboundFailure(
          c.db,
          row.dedupe_id,
          `sweep: ${err instanceof Error ? err.message : String(err)}`,
          MAX_INBOUND_ATTEMPTS,
          claimToken,
        );
      }
    } finally {
      await heartbeat.stop();
    }
  }

  // Outbound retries
  const outboundClaimNow = Date.now();
  for (const row of await failedOutbound(c.db, outboundClaimNow)) {
    const token = crypto.randomUUID();
    const claimNow = Date.now();
    if (!(await claimOutboundRetry(c.db, row.id, row.retry_count, token, claimNow, SCHEDULER_LEASE_MS))) continue;
    await dispatchOutboundAttempt(c, row.id, token, row.body, row.task_id, row.retry_count + 1);
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

interface ProfileConfig {
  value: Omit<UserRow, 'id'>;
  errors: string[];
}

function profileConfigFromEnv(env: AppEnv): ProfileConfig {
  const timezone = env.TIMEZONE ?? 'America/Los_Angeles';
  const morningTime = env.MORNING_TIME ?? '08:00';
  const eveningTime = env.EVENING_TIME ?? '20:30';
  const workStart = env.WORK_START ?? '09:00';
  const workEnd = env.WORK_END ?? '18:00';
  const quietStart = env.QUIET_START ?? '22:00';
  const quietEnd = env.QUIET_END ?? '07:30';
  const nagLevel = env.NAG_LEVEL ?? 'standard';
  const pulseEveryMin = Number(env.PULSE_EVERY_MIN ?? '150');
  const errors: string[] = [];

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    errors.push('TIMEZONE must be a valid IANA timezone');
  }

  const timeFields = [
    ['MORNING_TIME', morningTime],
    ['EVENING_TIME', eveningTime],
    ['WORK_START', workStart],
    ['WORK_END', workEnd],
    ['QUIET_START', quietStart],
    ['QUIET_END', quietEnd],
  ] as const;
  for (const [name, value] of timeFields) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      errors.push(`${name} must be strict HH:MM (00:00–23:59)`);
    }
  }
  if (!(['gentle', 'standard', 'relentless'] as string[]).includes(nagLevel)) {
    errors.push('NAG_LEVEL must be gentle, standard, or relentless');
  }
  if (!Number.isSafeInteger(pulseEveryMin) || pulseEveryMin < 15) {
    errors.push('PULSE_EVERY_MIN must be a safe integer of at least 15');
  }

  return {
    value: {
      contact: env.OWNER_CONTACT ?? '',
      timezone,
      morning_time: morningTime,
      evening_time: eveningTime,
      work_start: workStart,
      work_end: workEnd,
      quiet_start: quietStart,
      quiet_end: quietEnd,
      nag_level: nagLevel,
      pulse_every_min: pulseEveryMin,
    },
    errors,
  };
}

export async function runSetup(env: AppEnv, requestUrl: URL): Promise<string> {
  const steps: SetupStep[] = [];
  const origin = requestUrl.origin;
  const sendTest = requestUrl.searchParams.get('test') === '1';

  await ensureSchema(env.DB);
  await setSetting(env.DB, 'public_origin', origin);
  steps.push({ name: 'Database schema', ok: true, note: 'migrations applied' });

  let user = await getUser(env.DB);
  let profileErrors: string[] = [];
  if (env.OWNER_CONTACT) {
    const configured = profileConfigFromEnv(env);
    profileErrors = configured.errors;
    if (profileErrors.length === 0) {
      await upsertUser(env.DB, configured.value);
      user = await getUser(env.DB);
    }
  }
  const profileReady = Boolean(user && profileErrors.length === 0);
  const contactNote =
    profileErrors.length > 0
      ? `invalid configuration — ${profileErrors.join('; ')}; existing profile preserved`
      : user
        ? `owner ···${user.contact.slice(-4)}, tz ${user.timezone}`
        : 'set the OWNER_CONTACT secret, then reload';
  steps.push({ name: 'Owner profile', ok: profileReady, note: contactNote });

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
    const signingSecretReady = Boolean(env.TRELLO_APP_SECRET);
    steps.push({
      name: 'Trello signing secret (TRELLO_APP_SECRET)',
      ok: signingSecretReady,
      note: signingSecretReady ? 'present' : 'missing — callback POSTs cannot be verified',
    });
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
      if (env.WEBHOOK_TOKEN && signingSecretReady) {
        const cb = `${origin}/webhook/trello/${env.WEBHOOK_TOKEN}`;
        const wh = await registerWebhook(env, cb);
        steps.push({ name: 'Trello webhook', ok: wh !== 'failed', note: wh });
      } else if (!signingSecretReady) {
        steps.push({
          name: 'Trello webhook',
          ok: false,
          note: 'not registered — add TRELLO_APP_SECRET first',
        });
      }
    } else {
      steps.push({ name: 'Trello lists', ok: false, note: 'could not load board lists' });
    }
  } else {
    steps.push({ name: 'Trello (optional)', ok: true, note: 'not configured — bot runs standalone' });
  }

  const coreReady = Boolean(profileReady && env.LOOP_AUTH_KEY && env.LOOP_WEBHOOK_AUTH && env.WEBHOOK_TOKEN);
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
<p>Using the free sandbox? The fields live on the <b>Sandbox</b> page of the LoopMessage dashboard
(<i>Sandbox Webhook URL</i> + <i>Sandbox Webhook Header</i>) — <b>not</b> under API → Settings, which only
covers paid dedicated senders. Set the webhook URL to:</p>
<pre style="background:#f4f4f4;padding:10px;overflow-x:auto">${esc(loopWebhookUrl)}</pre>
<p>…and set the webhook <b>header</b> field to exactly the same value as your <code>LOOP_WEBHOOK_AUTH</code>
secret. Paste carefully — one stray character causes silent 401 rejections (their Webhooks history page
shows <i>failed 401</i> and has a Retry button if that happens).</p>
<p><a href="?key=${esc(requestUrl.searchParams.get('key') ?? '')}&test=1">Send a test iMessage →</a></p>
<p>${coreReady ? 'Core is ready. Text the bot "help" to begin. 🫡' : 'Fix the ❌ rows above, then reload this page.'}</p>
</body>`;
}
