// Typed access to D1. All SQL lives here; the engine speaks in rows and
// domain verbs.

export interface UserRow {
  id: number;
  contact: string;
  timezone: string;
  morning_time: string;
  evening_time: string;
  work_start: string;
  work_end: string;
  quiet_start: string;
  quiet_end: string;
  nag_level: string;
  pulse_every_min: number;
}

export interface TaskRow {
  id: number;
  trello_card_id: string | null;
  title: string;
  definition_of_done: string | null;
  source_local_date: string;
  due_at_utc: number | null;
  next_action_at_utc: number | null;
  status: string;
  consecutive_deferrals: number;
  nags_sent_today: number;
  last_nag_at_utc: number | null;
  blocker: string | null;
  pending_prompt: string | null;
  created_by: string;
  created_at_utc: number;
}

export interface SessionRow {
  local_date: string;
  plan_state: string;
  prompted_at_utc: number | null;
  nudges_sent: number;
  recap_sent_at_utc: number | null;
  weekly_sent: number;
}

export interface OutboundRow {
  id: number;
  at_utc: number;
  kind: string;
  task_id: number | null;
  channel_message_id: string | null;
  trello_card_id: string | null;
  body: string;
  status: string;
  retry_count: number;
}

export interface EventRow {
  id: number;
  task_id: number;
  at_utc: number;
  kind: string;
  detail: string | null;
}

export const OPEN_STATUSES = ['pending', 'nagging', 'awaiting_reply', 'awaiting_recommitment', 'started'] as const;
const OPEN_IN = `('pending','nagging','awaiting_reply','awaiting_recommitment','started')`;

// -- settings ---------------------------------------------------------------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value)
    .run();
}

export async function delSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare(`DELETE FROM settings WHERE key = ?`).bind(key).run();
}

// -- user -------------------------------------------------------------------

export async function getUser(db: D1Database): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE id = 1`).first<UserRow>();
}

export async function upsertUser(db: D1Database, u: Omit<UserRow, 'id'>): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, contact, timezone, morning_time, evening_time, work_start, work_end, quiet_start, quiet_end, nag_level, pulse_every_min)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET contact = excluded.contact`,
    )
    .bind(
      u.contact,
      u.timezone,
      u.morning_time,
      u.evening_time,
      u.work_start,
      u.work_end,
      u.quiet_start,
      u.quiet_end,
      u.nag_level,
      u.pulse_every_min,
    )
    .run();
}

export async function updateUserField(db: D1Database, field: keyof UserRow, value: string | number): Promise<void> {
  const allowed: Array<keyof UserRow> = [
    'timezone',
    'morning_time',
    'evening_time',
    'work_start',
    'work_end',
    'quiet_start',
    'quiet_end',
    'nag_level',
    'pulse_every_min',
  ];
  if (!allowed.includes(field)) throw new Error(`user field not editable: ${String(field)}`);
  await db.prepare(`UPDATE users SET ${String(field)} = ? WHERE id = 1`).bind(value).run();
}

// -- sessions ---------------------------------------------------------------

export async function ensureSession(db: D1Database, localDate: string): Promise<SessionRow> {
  await db.prepare(`INSERT OR IGNORE INTO daily_sessions (local_date) VALUES (?)`).bind(localDate).run();
  const row = await db.prepare(`SELECT * FROM daily_sessions WHERE local_date = ?`).bind(localDate).first<SessionRow>();
  if (!row) throw new Error('session insert failed');
  return row;
}

export async function updateSession(db: D1Database, localDate: string, fields: Partial<SessionRow>): Promise<void> {
  const keys = Object.keys(fields).filter((k) => k !== 'local_date');
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => fields[k as keyof SessionRow] as string | number | null);
  await db
    .prepare(`UPDATE daily_sessions SET ${sets} WHERE local_date = ?`)
    .bind(...values, localDate)
    .run();
}

// -- tasks ------------------------------------------------------------------

export interface NewTask {
  trello_card_id?: string | null;
  title: string;
  definition_of_done?: string | null;
  source_local_date: string;
  due_at_utc?: number | null;
  next_action_at_utc?: number | null;
  status?: string;
  created_by?: string;
}

export async function createTask(db: D1Database, t: NewTask): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO tasks (trello_card_id, title, definition_of_done, source_local_date, due_at_utc, next_action_at_utc, status, created_by, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      t.trello_card_id ?? null,
      t.title,
      t.definition_of_done ?? null,
      t.source_local_date,
      t.due_at_utc ?? null,
      t.next_action_at_utc ?? null,
      t.status ?? 'pending',
      t.created_by ?? 'owner',
      Date.now(),
    )
    .run();
  return Number(res.meta.last_row_id);
}

const TASK_FIELDS = new Set([
  'trello_card_id',
  'title',
  'definition_of_done',
  'source_local_date',
  'due_at_utc',
  'next_action_at_utc',
  'status',
  'consecutive_deferrals',
  'nags_sent_today',
  'last_nag_at_utc',
  'blocker',
  'pending_prompt',
]);

export async function updateTask(db: D1Database, id: number, fields: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(fields).filter((k) => TASK_FIELDS.has(k));
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db
    .prepare(`UPDATE tasks SET ${sets} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k] ?? null), id)
    .run();
}

export async function getTask(db: D1Database, id: number): Promise<TaskRow | null> {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).bind(id).first<TaskRow>();
}

export async function taskByCard(db: D1Database, cardId: string): Promise<TaskRow | null> {
  return db.prepare(`SELECT * FROM tasks WHERE trello_card_id = ?`).bind(cardId).first<TaskRow>();
}

export async function openTasks(db: D1Database, uptoLocalDate: string): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM tasks WHERE status IN ${OPEN_IN} AND source_local_date <= ?
       ORDER BY next_action_at_utc IS NULL, next_action_at_utc ASC, id ASC`,
    )
    .bind(uptoLocalDate)
    .all<TaskRow>();
  return res.results;
}

export async function dueTasks(db: D1Database, nowUtc: number, uptoLocalDate: string): Promise<TaskRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM tasks WHERE status IN ('pending','nagging','started') AND source_local_date <= ?
       AND next_action_at_utc IS NOT NULL AND next_action_at_utc <= ? ORDER BY next_action_at_utc ASC LIMIT 10`,
    )
    .bind(uptoLocalDate, nowUtc)
    .all<TaskRow>();
  return res.results;
}

export async function stuckTasks(db: D1Database): Promise<TaskRow[]> {
  const res = await db.prepare(`SELECT * FROM tasks WHERE status = 'stuck' ORDER BY id ASC`).all<TaskRow>();
  return res.results;
}

export async function pendingPromptTask(db: D1Database): Promise<TaskRow | null> {
  return db
    .prepare(`SELECT * FROM tasks WHERE pending_prompt IS NOT NULL AND status IN ${OPEN_IN} ORDER BY id DESC LIMIT 1`)
    .first<TaskRow>();
}

export async function appendEvent(db: D1Database, taskId: number, kind: string, detail?: unknown): Promise<number> {
  const res = await db
    .prepare(`INSERT INTO task_events (task_id, at_utc, kind, detail) VALUES (?, ?, ?, ?)`)
    .bind(taskId, Date.now(), kind, detail === undefined ? null : JSON.stringify(detail))
    .run();
  return Number(res.meta.last_row_id);
}

export async function eventsInRange(db: D1Database, fromUtc: number, toUtc: number): Promise<EventRow[]> {
  const res = await db
    .prepare(`SELECT * FROM task_events WHERE at_utc >= ? AND at_utc < ? ORDER BY at_utc ASC`)
    .bind(fromUtc, toUtc)
    .all<EventRow>();
  return res.results;
}

// -- inbound (durable inbox + idempotency) ----------------------------------

export async function tryInsertInbound(db: D1Database, dedupeId: string, raw: string): Promise<boolean> {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO inbound_events (dedupe_id, received_at_utc, raw) VALUES (?, ?, ?)`)
    .bind(dedupeId, Date.now(), raw)
    .run();
  return res.meta.changes > 0;
}

export async function markInboundProcessed(db: D1Database, dedupeId: string, error?: string): Promise<void> {
  await db
    .prepare(`UPDATE inbound_events SET processed_at_utc = ?, error = ? WHERE dedupe_id = ?`)
    .bind(Date.now(), error ?? null, dedupeId)
    .run();
}

export async function unprocessedInbound(
  db: D1Database,
  olderThanUtc: number,
  limit = 10,
): Promise<Array<{ dedupe_id: string; raw: string }>> {
  const res = await db
    .prepare(
      `SELECT dedupe_id, raw FROM inbound_events WHERE processed_at_utc IS NULL AND received_at_utc <= ?
       ORDER BY received_at_utc ASC LIMIT ?`,
    )
    .bind(olderThanUtc, limit)
    .all<{ dedupe_id: string; raw: string }>();
  return res.results;
}

// -- outbound log -----------------------------------------------------------

export interface NewOutbound {
  kind: string;
  task_id?: number | null;
  channel_message_id?: string | null;
  trello_card_id?: string | null;
  body: string;
  status?: string;
}

export async function logOutbound(db: D1Database, o: NewOutbound): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO outbound_log (at_utc, kind, task_id, channel_message_id, trello_card_id, body, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      Date.now(),
      o.kind,
      o.task_id ?? null,
      o.channel_message_id ?? null,
      o.trello_card_id ?? null,
      o.body,
      o.status ?? 'sent',
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function outboundByMessageId(db: D1Database, messageId: string): Promise<OutboundRow | null> {
  return db
    .prepare(`SELECT * FROM outbound_log WHERE channel_message_id = ? ORDER BY id DESC LIMIT 1`)
    .bind(messageId)
    .first<OutboundRow>();
}

export async function recentTrelloEcho(db: D1Database, cardId: string, sinceUtc: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT id FROM outbound_log WHERE trello_card_id = ? AND at_utc >= ? LIMIT 1`)
    .bind(cardId, sinceUtc)
    .first<{ id: number }>();
  return row !== null;
}

export async function setOutboundStatus(db: D1Database, id: number, status: string, retryCount?: number): Promise<void> {
  if (retryCount === undefined) {
    await db.prepare(`UPDATE outbound_log SET status = ? WHERE id = ?`).bind(status, id).run();
  } else {
    await db.prepare(`UPDATE outbound_log SET status = ?, retry_count = ? WHERE id = ?`).bind(status, retryCount, id).run();
  }
}

export async function failedOutbound(db: D1Database, limit = 5): Promise<OutboundRow[]> {
  const res = await db
    .prepare(`SELECT * FROM outbound_log WHERE status = 'failed' AND retry_count < 5 ORDER BY at_utc ASC LIMIT ?`)
    .bind(limit)
    .all<OutboundRow>();
  return res.results;
}

export async function lastOutboundAt(db: D1Database, kinds: string[]): Promise<number | null> {
  const marks = kinds.map(() => '?').join(',');
  const row = await db
    .prepare(`SELECT MAX(at_utc) AS t FROM outbound_log WHERE kind IN (${marks})`)
    .bind(...kinds)
    .first<{ t: number | null }>();
  return row?.t ?? null;
}

export async function lastInboundAt(db: D1Database): Promise<number | null> {
  const row = await db.prepare(`SELECT MAX(received_at_utc) AS t FROM inbound_events`).first<{ t: number | null }>();
  return row?.t ?? null;
}
