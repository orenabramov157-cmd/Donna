# Accountability Bot — Playbook v2

A single-user accountability drill sergeant. It texts the owner over **iMessage** (via LoopMessage), plans the day from **Trello**, nags until things are done or explicitly renegotiated, and keeps a permanent factual history of what happened. It runs entirely on **Cloudflare** — no computer of the owner's is involved after setup.

This document is the locked spec. `HANDOFF.md` is the setup guide. The code implements exactly what is written here.

## 1. Cost

$0/month on the default path.

| Piece | Plan | Why it fits |
|---|---|---|
| Cloudflare Worker + cron | Free (100k req/day) | ~1,500 invocations/day used |
| Cloudflare D1 | Free (5M reads / 100k writes per day) | a few hundred ops/day |
| Workers AI | Free daily allocation | ≤ `AI_DAILY_CAP` small LLM calls/day, deterministic fallback below |
| LoopMessage | Free sandbox (5 contacts; this bot uses 1) | iMessage in/out |
| Trello REST API + webhooks | Free | single-user volume, limits are ~300 req/10s |

Known risk: the LoopMessage sandbox is a test tier. If it is ever capped or closed, the channel adapter flips to Twilio SMS (~$10/mo, code already present) by changing config — no code changes.

## 2. Architecture decisions

- **One Worker, one D1 database, one cron (`* * * * *`).** No Queues, despite them now being free. Rationale: LoopMessage allows 15 seconds to answer a webhook (vs Slack's 3), so inbound work is done inline. Durability comes from writing every inbound event to D1 **before** processing; a cron sweep retries anything unprocessed. Fewer moving parts for a hand-off appliance.
- **Self-migrating schema.** The Worker applies its own SQL migrations (versioned, idempotent) at startup and on `/setup`. No `wrangler d1 migrations` CLI step — this keeps the Deploy-to-Cloudflare button flow browser-only and avoids the known gap where D1 subcommands don't resolve auto-provisioned bindings.
- **Auto-provisioned resources.** `wrangler.jsonc` declares the D1 binding without an ID; the Deploy button / wrangler provisions it on first deploy.
- **Pluggable channel.** `src/channel/types.ts` defines the interface; `loopmessage.ts` (default) and `twilio.ts` implement it. `CHANNEL` var selects.
- **Trello owns the task list; D1 owns the accountability layer.** Reminder state, nag counts, deferral ladder, and the append-only event history live in D1, keyed to Trello card IDs. Tasks created by text are mirrored into Trello. If Trello is not configured, the bot still works with its own list.
- **AI is garnish, not load-bearing.** Deterministic keyword grammar is always available. Workers AI (model = `AI_MODEL` var) interprets natural language and proposes plans; on quota exhaustion, low confidence, or failure, the bot asks for keywords instead of guessing.

## 3. Channel: LoopMessage (verified 2026-07-23)

- Send: `POST https://a.loopmessage.com/api/v1/message/send/`, headers `Authorization: <org api key>` (no Bearer prefix), body `{ contact, text, passthrough?, reply_to_id?, effect? }`. Sandbox ignores `sender`.
- Inbound webhook JSON: `event` (`message_inbound`, `message_reaction`, `message_delivered`, `message_failed`), `contact`, `text`, `message_type`, `message_id`, `webhook_id`.
- Webhook auth: LoopMessage sends the `Authorization` header value configured in their dashboard; the Worker compares it timing-safely to secret `LOOP_WEBHOOK_AUTH`. Requests must be answered `200` within 15s; retries up to 30×, deduped via `webhook_id` in `inbound_events`.
- `passthrough` on outbound carries `task_id`, so delivery/failure webhooks and **tapback reactions** map back to tasks. A 👍 or ❤️ reaction on a nag = `done` for that task. 👎 = `not done yet` (opens recommitment).
- Only messages from `OWNER_CONTACT` are processed; everything else is logged and ignored.

## 4. Trello sync

- `/setup` resolves the board (`TRELLO_BOARD_ID` secret) and finds lists by name (`TRELLO_TODAY_LIST`, `TRELLO_DONE_LIST`, defaults "Today"/"Done"), storing their IDs in `settings`. It registers one webhook on the board (callback contains a random path token).
- Board → bot: `createCard` into Today = new task (bot asks for a time at the next touchpoint). `updateCard` moved into Done = task completed (`source: trello`, no nag). Card renamed = title updated. Card moved out of Today = task dropped with reason `moved in trello`.
- Bot → board: task done by text/tapback = card moved to Done + `dueComplete`. Task added by text (`add: call vendor 10am`) = card created in Today with due date. Drops archive the card only if it was bot-created.
- Loop prevention: every board mutation the bot makes is recorded in `outbound_log`; matching webhook actions arriving within 10 minutes are ignored.

## 5. Data model (D1)

- `settings(key TEXT PK, value TEXT)` — schema version, resolved Trello IDs, AI daily counter, setup state.
- `users(id=1)` — contact, timezone, `morning_time`, `evening_time`, `work_start`, `work_end`, `quiet_start`, `quiet_end`, `nag_level`, `pulse_every_min`. Seeded from vars at `/setup`; editable by texting settings commands.
- `tasks(id, trello_card_id UNIQUE NULL, title, definition_of_done NULL, source_local_date, due_at_utc NULL, next_action_at_utc NULL, status, consecutive_deferrals, nags_sent_today, last_nag_at_utc NULL, blocker NULL, created_by)` — status ∈ `pending | nagging | awaiting_reply | awaiting_recommitment | started | done | dropped | stuck | deferred`.
- `task_events(id, task_id, at_utc, kind, detail)` — append-only: created/reminded/started/completed/deferred/recommitted/rewritten/blocked/dropped/stuck/undone/trello_synced.
- `daily_sessions(local_date PK, plan_state, recap_sent_at, nudges_sent, stats)` — plan_state ∈ `unplanned | prompted | planning | confirmed | no_plan`.
- `inbound_events(dedupe_id PK, received_at_utc, raw, processed_at_utc NULL, error NULL)` — idempotency + durable inbox.
- `outbound_log(id, at_utc, kind, task_id NULL, channel_message_id NULL, body)` — nag accounting, reaction resolution, Trello echo suppression.

## 6. A day in the life (engine behavior)

All local times computed from the user's IANA timezone (DST-safe, recomputed at each use — never stored as fixed UTC across days).

1. **Morning (`morning_time`)** — bot pulls Today-list cards + carryovers, proposes the checklist with per-task times (AI proposes; deterministic default 10:00/14:00/16:00 slots otherwise), asks for confirmation. Unanswered: nudge at +45m, final at +3h, then `no_plan` (recoverable anytime by texting `plan`).
2. **Nags** — when a task's `next_action_at_utc` arrives: nag with menu (`done / start / snooze 30 / tomorrow / blocked / drop`). Re-nag cadence by `nag_level`: **gentle** = one re-nag after 60m; **standard** = every 45m, max 4; **relentless** = every 20m until answered. Quiet hours suppress and roll to morning.
3. **Pulse check-ins** — during `work_start`–`work_end`, every `pulse_every_min` (default 150): one message with the open-task scoreboard and a status question. Skipped if any exchange happened in the last 30 minutes (don't nag someone mid-conversation).
4. **Replies** — `start` schedules a 10-minute check-in. `not done` / `blocked` → `awaiting_recommitment`: bot requires a smallest-next-action and a specific new time (blocked also records the blocker). No silent carry-forward.
5. **Escalation ladder** (consecutive deferrals): 1 → next action + new time required. 2 → shorten, split, or drop with a reason. 3–4 → only: 10-minute start today, rewrite smaller, or drop. 5 → `stuck`: nags stop, next morning opens with a stuck-task review; the task cannot re-enter the list until rewritten or dropped.
6. **Evening recap (`evening_time`)** — completed / recommitted / dropped / stuck / still-open, plus factual patterns only ("`invoice` deferred 3 days running"). Open tasks go through recommitment — there is no one-tap bulk carry.
7. **Weekly recap** — Sunday evening: completion rate, most-deferred task, best day. Facts only, no psychology.

## 7. Command grammar (always works, no AI needed)

`done` · `done 2` · `start` · `snooze 30` · `tomorrow` · `not done` · `blocked <why>` · `skip` / `drop 2 <reason>` · `add: <task> [time]` · `plan` · `status` · `undo` · `settings` · `nag gentle|standard|relentless` · `help`

Bare replies resolve to the task most recently nagged about; `<n>` indexes the numbered `status` list; AI matches content words when enabled; genuine ambiguity → the bot asks, never guesses. Every state change is answered with a receipt ("✅ Product photos — done. Next: call Sam, 1:30."). `undo` reverses the last change within 10 minutes via a compensating event.

## 8. HTTP surface

- `POST /webhook/loop/:token` — LoopMessage inbound (token + `Authorization` both verified, timing-safe).
- `HEAD|POST /webhook/trello/:token` — Trello callback (HEAD 200s for registration).
- `GET /setup?key=<SETUP_KEY>` — idempotent HTML setup page: migrations, secret presence, Trello auth + list resolution, webhook registration, test iMessage. Re-run anytime.
- `GET /health` — `{ ok, version, last_cron_at }`, no secrets.
- Anything else: 404. Errors: structured JSON logs (`console.error`), no `passThroughOnException`.

## 9. Configuration

Vars (in `wrangler.jsonc`, editable in dashboard): `TIMEZONE`, `MORNING_TIME`, `EVENING_TIME`, `WORK_START`, `WORK_END`, `QUIET_START`, `QUIET_END`, `NAG_LEVEL`, `PULSE_EVERY_MIN`, `CHANNEL`, `AI_MODEL`, `AI_DAILY_CAP`, `TRELLO_TODAY_LIST`, `TRELLO_DONE_LIST`.

Secrets (dashboard → Settings → Variables and Secrets; never in the repo): `LOOP_AUTH_KEY`, `LOOP_WEBHOOK_AUTH`, `OWNER_CONTACT`, `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID`, `SETUP_KEY`, `WEBHOOK_TOKEN`. Twilio path adds `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.

## 10. Degradation modes

| Failure | Behavior |
|---|---|
| Workers AI quota/model failure | Deterministic grammar + "reply with keywords" prompt; never blocks core flow |
| LoopMessage send failure | Logged in `outbound_log`, retried by cron (max 5, backoff); `message_failed` webhook recorded |
| Trello down / not configured | Bot runs standalone on D1 tasks; sync resumes on next webhook/cron |
| Webhook redelivery | Deduped by `webhook_id` / Trello action id in `inbound_events` |
| Cron gap (platform) | Next tick catches up from timestamps; `/health` exposes `last_cron_at` |

## 11. Tests

Pure-logic units run in plain vitest: escalation ladder transitions, keyword grammar, timezone/DST math (spring-forward and fall-back cases), nag cadence calculation. `npm run check` (tsc) and `npm test` must both pass before handoff.

## 12. Future flips

- **Twilio SMS**: set `CHANNEL=twilio`, add the three Twilio secrets, point the Twilio number's webhook at `/webhook/loop/:token` (same route, adapter branches on parse). Documented in HANDOFF appendix.
- **Multiple contacts** (e.g. cc the boss on the weekly recap): sandbox allows 5 contacts; `outbound_log` already records recipients.
