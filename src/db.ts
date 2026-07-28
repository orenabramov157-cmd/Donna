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
  outbound_claim_token?: string | null;
}

export interface SessionRow {
  local_date: string;
  plan_state: string;
  prompted_at_utc: number | null;
  nudges_sent: number;
  recap_sent_at_utc: number | null;
  weekly_sent: number;
  outbound_claim_token?: string | null;
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
  attempt_token?: string | null;
  lease_until_utc?: number | null;
  dedupe_key?: string | null;
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

export async function incrementSettingBelow(db: D1Database, key: string, cap: number): Promise<boolean> {
  const boundedCap = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  if (boundedCap === 0) return false;
  const row = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)
       WHERE CAST(settings.value AS INTEGER) < ?
       RETURNING value`,
    )
    .bind(key, boundedCap)
    .first<{ value: string }>();
  return row !== null;
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
       ON CONFLICT(id) DO UPDATE SET
         contact = excluded.contact,
         timezone = excluded.timezone,
         morning_time = excluded.morning_time,
         evening_time = excluded.evening_time,
         work_start = excluded.work_start,
         work_end = excluded.work_end,
         quiet_start = excluded.quiet_start,
         quiet_end = excluded.quiet_end,
         nag_level = excluded.nag_level,
         pulse_every_min = excluded.pulse_every_min`,
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

const SESSION_FIELDS = new Set<keyof SessionRow>([
  'plan_state',
  'prompted_at_utc',
  'nudges_sent',
  'recap_sent_at_utc',
  'weekly_sent',
]);

export async function claimSessionFields(
  db: D1Database,
  localDate: string,
  expected: Partial<SessionRow>,
  fields: Partial<SessionRow>,
): Promise<boolean> {
  const expectedKeys = Object.keys(expected).filter((key): key is keyof SessionRow =>
    SESSION_FIELDS.has(key as keyof SessionRow),
  );
  const fieldKeys = Object.keys(fields).filter((key): key is keyof SessionRow =>
    SESSION_FIELDS.has(key as keyof SessionRow),
  );
  if (expectedKeys.length === 0 || fieldKeys.length === 0) return false;
  const claimed = await db
    .prepare(
      `UPDATE daily_sessions SET ${fieldKeys.map((key) => `${key} = ?`).join(', ')}
       WHERE local_date = ? AND ${expectedKeys.map((key) => `${key} IS ?`).join(' AND ')}
       RETURNING local_date`,
    )
    .bind(
      ...fieldKeys.map((key) => fields[key] ?? null),
      localDate,
      ...expectedKeys.map((key) => expected[key] ?? null),
    )
    .first<{ local_date: string }>();
  return claimed !== null;
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

type TaskNagState = Pick<TaskRow, 'status' | 'next_action_at_utc' | 'nags_sent_today' | 'last_nag_at_utc'>;

export async function claimTaskNag(
  db: D1Database,
  id: number,
  expected: TaskNagState,
  fields: TaskNagState,
): Promise<boolean> {
  const claimed = await db
    .prepare(
      `UPDATE tasks
       SET status = ?, nags_sent_today = ?, last_nag_at_utc = ?, next_action_at_utc = ?
       WHERE id = ? AND status IS ? AND nags_sent_today IS ?
       AND last_nag_at_utc IS ? AND next_action_at_utc IS ?
       RETURNING id`,
    )
    .bind(
      fields.status,
      fields.nags_sent_today,
      fields.last_nag_at_utc,
      fields.next_action_at_utc,
      id,
      expected.status,
      expected.nags_sent_today,
      expected.last_nag_at_utc,
      expected.next_action_at_utc,
    )
    .first<{ id: number }>();
  return claimed !== null;
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

export async function markInboundProcessed(
  db: D1Database,
  dedupeId: string,
  error?: string,
  claimToken?: string,
): Promise<void> {
  if (claimToken !== undefined) {
    const now = Date.now();
    await db
      .prepare(
        `UPDATE inbound_events SET processed_at_utc = ?, error = ?
         WHERE dedupe_id = ? AND processed_at_utc IS NULL
         AND json_valid(error) AND json_extract(error, '$.leaseToken') = ?
         AND COALESCE(CAST(json_extract(error, '$.leaseUntil') AS INTEGER), 0) > ?`,
      )
      .bind(now, error ?? null, dedupeId, claimToken, now)
      .run();
    return;
  }
  await db
    .prepare(`UPDATE inbound_events SET processed_at_utc = ?, error = ? WHERE dedupe_id = ?`)
    .bind(Date.now(), error ?? null, dedupeId)
    .run();
}

export async function claimInbound(
  db: D1Database,
  dedupeId: string,
  claimToken: string,
  nowUtc: number,
  leaseMs: number,
  maxAttempts: number,
): Promise<boolean> {
  const leaseDuration = Number.isFinite(leaseMs) ? Math.max(1, Math.floor(leaseMs)) : 1;
  const attemptLimit = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1;
  const claimed = await db
    .prepare(
      `UPDATE inbound_events
       SET processed_at_utc = CASE
             WHEN MAX(
               0,
               CASE WHEN json_valid(error)
                 THEN COALESCE(CAST(json_extract(error, '$.attempts') AS INTEGER), 0)
                 ELSE 0
               END
             ) >= ?
             THEN ?
             ELSE NULL
           END,
           error = CASE
             WHEN MAX(
               0,
               CASE WHEN json_valid(error)
                 THEN COALESCE(CAST(json_extract(error, '$.attempts') AS INTEGER), 0)
                 ELSE 0
               END
             ) >= ?
             THEN json_object(
               'attempts',
               MAX(0, CAST(json_extract(error, '$.attempts') AS INTEGER)),
               'error',
               json_extract(error, '$.error')
             )
             ELSE json_object(
               'attempts',
               MIN(
                 MAX(
                   0,
                   CASE WHEN json_valid(error)
                     THEN COALESCE(CAST(json_extract(error, '$.attempts') AS INTEGER), 0)
                     ELSE 0
                   END
                 ) + 1,
                 ?
               ),
               'error',
               CASE WHEN json_valid(error) THEN json_extract(error, '$.error') ELSE error END,
               'leaseToken',
               ?,
               'leaseUntil',
               ?
             )
           END
       WHERE dedupe_id = ? AND processed_at_utc IS NULL
       AND (
         NOT json_valid(error)
         OR json_extract(error, '$.leaseToken') IS NULL
         OR COALESCE(CAST(json_extract(error, '$.leaseUntil') AS INTEGER), 0) <= ?
       )
       RETURNING dedupe_id, processed_at_utc,
         CASE WHEN json_valid(error) THEN json_extract(error, '$.leaseToken') ELSE NULL END AS lease_token`,
    )
    .bind(
      attemptLimit,
      nowUtc,
      attemptLimit,
      attemptLimit,
      claimToken,
      nowUtc + leaseDuration,
      dedupeId,
      nowUtc,
    )
    .first<{ dedupe_id: string; processed_at_utc: number | null; lease_token: string | null }>();
  return claimed !== null && claimed.processed_at_utc === null && claimed.lease_token === claimToken;
}

export async function renewInboundClaim(
  db: D1Database,
  dedupeId: string,
  claimToken: string,
  nowUtc: number,
  leaseMs: number,
): Promise<boolean> {
  const leaseDuration = Number.isFinite(leaseMs) ? Math.max(1, Math.floor(leaseMs)) : 1;
  const renewed = await db
    .prepare(
      `UPDATE inbound_events
       SET error = json_set(error, '$.leaseUntil', ?)
       WHERE dedupe_id = ? AND processed_at_utc IS NULL
       AND json_valid(error) AND json_extract(error, '$.leaseToken') = ?
       AND COALESCE(CAST(json_extract(error, '$.leaseUntil') AS INTEGER), 0) > ?
       RETURNING dedupe_id`,
    )
    .bind(nowUtc + leaseDuration, dedupeId, claimToken, nowUtc)
    .first<{ dedupe_id: string }>();
  return renewed !== null;
}

export async function recordInboundFailure(
  db: D1Database,
  dedupeId: string,
  error: string,
  maxAttempts: number,
  claimToken: string | null = null,
): Promise<boolean> {
  const attemptLimit = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1;
  if (claimToken !== null) {
    const now = Date.now();
    const transition = await db
      .prepare(
        `UPDATE inbound_events
         SET processed_at_utc = CASE
               WHEN MAX(
                 0,
                 CASE WHEN json_valid(error)
                   THEN COALESCE(CAST(json_extract(error, '$.attempts') AS INTEGER), 0)
                   ELSE 0
                 END
               ) >= ?
               THEN ?
               ELSE NULL
             END,
             error = json_object(
               'attempts',
               MIN(
                 MAX(
                   0,
                   CASE WHEN json_valid(error)
                     THEN COALESCE(CAST(json_extract(error, '$.attempts') AS INTEGER), 0)
                     ELSE 0
                   END
                 ),
                 ?
               ),
               'error',
               ?
             )
         WHERE dedupe_id = ? AND processed_at_utc IS NULL
         AND ? IS NOT NULL
         AND json_valid(error) AND json_extract(error, '$.leaseToken') = ?
         AND COALESCE(CAST(json_extract(error, '$.leaseUntil') AS INTEGER), 0) > ?
         RETURNING processed_at_utc`,
      )
      .bind(attemptLimit, now, attemptLimit, error, dedupeId, claimToken, claimToken, now)
      .first<{ processed_at_utc: number | null }>();
    return transition !== null && transition.processed_at_utc !== null;
  }
  const transition = await db
    .prepare(
      `UPDATE inbound_events
       SET processed_at_utc = CASE
             WHEN MAX(
               0,
               CASE WHEN json_valid(error)
                 THEN COALESCE(CAST(json_extract(error, '$.attempts') AS INTEGER), 0)
                 ELSE 0
               END
             ) + 1 >= ?
             THEN ?
             ELSE NULL
           END,
           error = json_object(
             'attempts',
             MIN(
               MAX(
                 0,
                 CASE WHEN json_valid(error)
                   THEN COALESCE(CAST(json_extract(error, '$.attempts') AS INTEGER), 0)
                   ELSE 0
                 END
               ) + 1,
               ?
             ),
             'error',
             ?
           )
       WHERE dedupe_id = ? AND processed_at_utc IS NULL
       AND (
         (
           ? IS NULL
           AND (
             NOT json_valid(error)
             OR json_extract(error, '$.leaseToken') IS NULL
           )
         )
         OR (
           json_valid(error)
           AND json_extract(error, '$.leaseToken') = ?
         )
       )
       RETURNING processed_at_utc`,
    )
    .bind(attemptLimit, Date.now(), attemptLimit, error, dedupeId, claimToken, claimToken)
    .first<{ processed_at_utc: number | null }>();
  return transition !== null && transition.processed_at_utc !== null;
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
  attempt_token?: string | null;
  lease_until_utc?: number | null;
  dedupe_key?: string | null;
}

export async function logOutbound(db: D1Database, o: NewOutbound): Promise<number> {
  const res = await db
    .prepare(
      `INSERT INTO outbound_log
       (at_utc, kind, task_id, channel_message_id, trello_card_id, body, status, attempt_token, lease_until_utc, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      Date.now(),
      o.kind,
      o.task_id ?? null,
      o.channel_message_id ?? null,
      o.trello_card_id ?? null,
      o.body,
      o.status ?? 'sent',
      o.attempt_token ?? null,
      o.lease_until_utc ?? null,
      o.dedupe_key ?? null,
    )
    .run();
  return Number(res.meta.last_row_id);
}

function prepareLeasedOutbound(
  db: D1Database,
  o: NewOutbound,
  claimToken: string,
  nowUtc: number,
  leaseMs: number,
  dedupeKey: string,
  guardSql: string,
  guardArgs: unknown[],
): D1PreparedStatement {
  const duration = Number.isFinite(leaseMs) ? Math.max(1, Math.floor(leaseMs)) : 1;
  return db
    .prepare(
      `INSERT OR IGNORE INTO outbound_log
       (at_utc, kind, task_id, channel_message_id, trello_card_id, body, status,
        retry_count, attempt_token, lease_until_utc, dedupe_key)
       SELECT ?, ?, ?, ?, ?, ?, 'retrying', 0, ?, ?, ?
       WHERE EXISTS (${guardSql})`,
    )
    .bind(
      nowUtc,
      o.kind,
      o.task_id ?? null,
      o.channel_message_id ?? null,
      o.trello_card_id ?? null,
      o.body,
      claimToken,
      nowUtc + duration,
      dedupeKey,
      ...guardArgs,
    );
}

export async function claimSessionOutbound(
  db: D1Database,
  localDate: string,
  expected: Partial<SessionRow>,
  fields: Partial<SessionRow>,
  outbound: NewOutbound,
  claimToken: string,
  nowUtc: number,
  leaseMs: number,
  dedupeKey: string,
): Promise<{ id: number; token: string } | null> {
  const expectedKeys = Object.keys(expected).filter((key): key is keyof SessionRow =>
    SESSION_FIELDS.has(key as keyof SessionRow),
  );
  const fieldKeys = Object.keys(fields).filter((key): key is keyof SessionRow =>
    SESSION_FIELDS.has(key as keyof SessionRow),
  );
  if (expectedKeys.length === 0 || fieldKeys.length === 0) return null;
  const update = db
    .prepare(
      `UPDATE daily_sessions
       SET ${fieldKeys.map((key) => `${key} = ?`).join(', ')}, outbound_claim_token = ?
       WHERE local_date = ? AND ${expectedKeys.map((key) => `${key} IS ?`).join(' AND ')}`,
    )
    .bind(
      ...fieldKeys.map((key) => fields[key] ?? null),
      claimToken,
      localDate,
      ...expectedKeys.map((key) => expected[key] ?? null),
    );
  const results = await db.batch([
    update,
    prepareLeasedOutbound(
      db,
      outbound,
      claimToken,
      nowUtc,
      leaseMs,
      dedupeKey,
      `SELECT 1 FROM daily_sessions WHERE local_date = ? AND outbound_claim_token = ?`,
      [localDate, claimToken],
    ),
  ]);
  const stateClaimed = Number(results[0]?.meta.changes ?? 0) > 0;
  const outboundInserted = Number(results[1]?.meta.changes ?? 0) > 0;
  if (!stateClaimed || !outboundInserted) return null;
  return { id: Number(results[1]?.meta.last_row_id), token: claimToken };
}

export async function claimTaskNagOutbound(
  db: D1Database,
  id: number,
  expected: TaskNagState,
  fields: TaskNagState,
  outbound: NewOutbound,
  claimToken: string,
  nowUtc: number,
  leaseMs: number,
  dedupeKey: string,
): Promise<{ id: number; token: string } | null> {
  const update = db
    .prepare(
      `UPDATE tasks
       SET status = ?, nags_sent_today = ?, last_nag_at_utc = ?, next_action_at_utc = ?,
           outbound_claim_token = ?
       WHERE id = ? AND status IS ? AND nags_sent_today IS ?
       AND last_nag_at_utc IS ? AND next_action_at_utc IS ?`,
    )
    .bind(
      fields.status,
      fields.nags_sent_today,
      fields.last_nag_at_utc,
      fields.next_action_at_utc,
      claimToken,
      id,
      expected.status,
      expected.nags_sent_today,
      expected.last_nag_at_utc,
      expected.next_action_at_utc,
    );
  const results = await db.batch([
    update,
    prepareLeasedOutbound(
      db,
      outbound,
      claimToken,
      nowUtc,
      leaseMs,
      dedupeKey,
      `SELECT 1 FROM tasks WHERE id = ? AND outbound_claim_token = ?`,
      [id, claimToken],
    ),
  ]);
  const taskClaimed = Number(results[0]?.meta.changes ?? 0) > 0;
  const outboundInserted = Number(results[1]?.meta.changes ?? 0) > 0;
  if (!taskClaimed || !outboundInserted) return null;
  return { id: Number(results[1]?.meta.last_row_id), token: claimToken };
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

export async function setOutboundStatus(
  db: D1Database,
  id: number,
  status: string,
  retryCount?: number,
  channelMessageId?: string | null,
): Promise<void> {
  if (retryCount === undefined) {
    await db.prepare(`UPDATE outbound_log SET status = ? WHERE id = ?`).bind(status, id).run();
    return;
  }
  await db
    .prepare(
      `UPDATE outbound_log
       SET status = ?, retry_count = ?, channel_message_id = COALESCE(?, channel_message_id)
       WHERE id = ?`,
    )
    .bind(status, retryCount, channelMessageId ?? null, id)
    .run();
}

export async function completeOutboundAttempt(
  db: D1Database,
  id: number,
  claimToken: string,
  status: string,
  retryCount: number,
  channelMessageId?: string | null,
): Promise<boolean> {
  const completed = await db
    .prepare(
      `UPDATE outbound_log
       SET status = ?, retry_count = ?, channel_message_id = COALESCE(?, channel_message_id),
           attempt_token = NULL, lease_until_utc = NULL
       WHERE id = ? AND status = 'retrying' AND attempt_token = ?
       RETURNING id`,
    )
    .bind(status, retryCount, channelMessageId ?? null, id, claimToken)
    .first<{ id: number }>();
  return completed !== null;
}

export async function setOutboundStatusByMessageId(
  db: D1Database,
  messageId: string,
  status: string,
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE outbound_log SET status = ?
       WHERE channel_message_id = ? AND attempt_token IS NULL AND status != 'retrying'
       RETURNING id`,
    )
    .bind(status, messageId)
    .first<{ id: number }>();
  return updated !== null;
}

export async function claimOutboundRetry(
  db: D1Database,
  id: number,
  retryCount: number,
  claimToken: string,
  nowUtc: number,
  leaseMs: number,
): Promise<boolean> {
  const duration = Number.isFinite(leaseMs) ? Math.max(1, Math.floor(leaseMs)) : 1;
  const claimed = await db
    .prepare(
      `UPDATE outbound_log
       SET status = 'retrying', attempt_token = ?, lease_until_utc = ?
       WHERE id = ? AND retry_count = ? AND retry_count < 5
       AND (
         (status = 'failed' AND attempt_token IS NULL)
         OR (status = 'retrying' AND COALESCE(lease_until_utc, 0) <= ?)
       )
       RETURNING id, attempt_token`,
    )
    .bind(claimToken, nowUtc + duration, id, retryCount, nowUtc)
    .first<{ id: number; attempt_token: string }>();
  return claimed !== null && claimed.attempt_token === claimToken;
}

export async function failedOutbound(db: D1Database, nowUtc: number, limit = 5): Promise<OutboundRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM outbound_log
       WHERE retry_count < 5 AND (
         (status = 'failed' AND attempt_token IS NULL)
         OR (status = 'retrying' AND COALESCE(lease_until_utc, 0) <= ?)
       )
       ORDER BY at_utc ASC LIMIT ?`,
    )
    .bind(nowUtc, limit)
    .all<OutboundRow>();
  return res.results;
}

export async function claimSettingLease(
  db: D1Database,
  key: string,
  nowUtc: number,
  leaseMs: number,
): Promise<boolean> {
  const duration = Number.isFinite(leaseMs) ? Math.max(1, Math.floor(leaseMs)) : 1;
  const leaseUntil = nowUtc + duration;
  const claimed = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, CAST(? AS TEXT))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE CAST(settings.value AS INTEGER) <= ?
       RETURNING value`,
    )
    .bind(key, leaseUntil, nowUtc)
    .first<{ value: string }>();
  return claimed !== null;
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

// -- conversation transcript (for the brain) --------------------------------

export async function recentOutboundBodies(db: D1Database, n = 12): Promise<Array<{ at: number; body: string }>> {
  const res = await db
    .prepare(`SELECT at_utc AS at, body FROM outbound_log WHERE status != 'failed' ORDER BY at_utc DESC LIMIT ?`)
    .bind(n)
    .all<{ at: number; body: string }>();
  return res.results;
}

export async function recentInboundTexts(db: D1Database, n = 12): Promise<Array<{ at: number; body: string }>> {
  const res = await db
    .prepare(`SELECT received_at_utc AS at, raw FROM inbound_events ORDER BY received_at_utc DESC LIMIT ?`)
    .bind(n * 2)
    .all<{ at: number; raw: string }>();
  const out: Array<{ at: number; body: string }> = [];
  for (const row of res.results) {
    try {
      const parsed = JSON.parse(row.raw) as { kind?: string; text?: string };
      if (parsed.kind === 'text' && typeof parsed.text === 'string') out.push({ at: row.at, body: parsed.text });
    } catch {
      // ignore unparseable rows
    }
    if (out.length >= n) break;
  }
  return out;
}
