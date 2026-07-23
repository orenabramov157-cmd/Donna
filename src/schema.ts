// Self-migrating schema. The Worker applies these on /setup and lazily at
// startup, so deployment never needs a `wrangler d1 migrations` CLI step
// (which also does not support auto-provisioned bindings).

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_utc INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      contact TEXT NOT NULL,
      timezone TEXT NOT NULL,
      morning_time TEXT NOT NULL,
      evening_time TEXT NOT NULL,
      work_start TEXT NOT NULL,
      work_end TEXT NOT NULL,
      quiet_start TEXT NOT NULL,
      quiet_end TEXT NOT NULL,
      nag_level TEXT NOT NULL,
      pulse_every_min INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trello_card_id TEXT UNIQUE,
      title TEXT NOT NULL,
      definition_of_done TEXT,
      source_local_date TEXT NOT NULL,
      due_at_utc INTEGER,
      next_action_at_utc INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      consecutive_deferrals INTEGER NOT NULL DEFAULT 0,
      nags_sent_today INTEGER NOT NULL DEFAULT 0,
      last_nag_at_utc INTEGER,
      blocker TEXT,
      pending_prompt TEXT,
      created_by TEXT NOT NULL DEFAULT 'owner',
      created_at_utc INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_next_action ON tasks (status, next_action_at_utc)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks (source_local_date)`,
    `CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      at_utc INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_events_task ON task_events (task_id, at_utc)`,
    `CREATE TABLE IF NOT EXISTS daily_sessions (
      local_date TEXT PRIMARY KEY,
      plan_state TEXT NOT NULL DEFAULT 'unplanned',
      prompted_at_utc INTEGER,
      nudges_sent INTEGER NOT NULL DEFAULT 0,
      recap_sent_at_utc INTEGER,
      weekly_sent INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS inbound_events (
      dedupe_id TEXT PRIMARY KEY,
      received_at_utc INTEGER NOT NULL,
      raw TEXT NOT NULL,
      processed_at_utc INTEGER,
      error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS outbound_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_utc INTEGER NOT NULL,
      kind TEXT NOT NULL,
      task_id INTEGER,
      channel_message_id TEXT,
      trello_card_id TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      retry_count INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_outbound_msg ON outbound_log (channel_message_id)`,
    `CREATE INDEX IF NOT EXISTS idx_outbound_status ON outbound_log (status, at_utc)`,
  ],
];

let schemaReady: Promise<void> | null = null; // process-wide init latch, not request state

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = applyMigrations(db).catch((err: unknown) => {
      schemaReady = null; // allow retry on next invocation
      throw err;
    });
  }
  return schemaReady;
}

async function applyMigrations(db: D1Database): Promise<void> {
  await db
    .prepare(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc INTEGER NOT NULL)`)
    .run();
  const row = await db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).first<{ v: number | null }>();
  const current = row?.v ?? 0;
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    const statements = MIGRATIONS[version - 1];
    if (!statements) continue;
    await db.batch(statements.map((s) => db.prepare(s)));
    await db
      .prepare(`INSERT OR IGNORE INTO schema_migrations (version, applied_at_utc) VALUES (?, ?)`)
      .bind(version, Date.now())
      .run();
  }
}
