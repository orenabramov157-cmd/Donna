# Donna Production Hardening Design

## Scope

Fix the concrete production risks found in the repository review without changing Donna's product behavior or adding paid infrastructure:

- prevent credentials from entering logs;
- authenticate Trello webhook bodies;
- preserve failed inbound commands for bounded retry;
- reset nag limits at each local-day boundary;
- keep the persisted owner profile synchronized with dashboard configuration;
- prevent conflicting AI actions from mutating the same task twice;
- narrow Trello echo suppression to the exact expected action;
- make scheduled sends and outbound retries claim work before dispatch;
- retain message correlation on successful retries;
- configure Twilio status callbacks from the setup-discovered public origin;
- strictly validate calendar dates and clock times;
- make the AI daily budget increment atomic;
- regenerate Wrangler binding types and document new setup requirements.

## Considered Approaches

### 1. Targeted D1 claims and existing tables — selected

Use conditional D1 updates and settings-based leases while preserving the current Worker, schema, channel interface, and one-minute cron. This minimizes deployment risk and remains on the existing free-tier architecture.

### 2. Durable outbox plus Cloudflare Queues

This gives stronger delivery semantics, but adds bindings, operational setup, and potentially billable infrastructure. It is disproportionate for a single-user accountability bot.

### 3. Minimal symptom patches

Redacting logs and resetting counters alone would be quick, but would leave command loss, duplicate sends, and provider-correlation failures unresolved.

## Design

Security-sensitive URLs are normalized before logging. Trello POST callbacks are verified with `X-Trello-Webhook` using HMAC-SHA1 over the raw request body plus the exact callback URL registered during setup. `TRELLO_APP_SECRET` becomes a required secret when Trello is enabled. Setup responses are non-cacheable.

Inbound rows remain unprocessed when execution throws. The existing `error` column stores a bounded retry count and last error; the cron sweep retries those rows and marks poison messages terminal after five attempts. Successful and explicitly rejected messages remain deduplicated.

Daily nag counts are interpreted relative to `last_nag_at_utc` in the owner's timezone. A count from a prior local date is treated as zero, so no schema migration is required.

Scheduled work uses conditional D1 claims before network delivery. Session transitions, task nags, pulse leases, and outbound retry status changes are claimed atomically. `sendOwner` always records a failed outbound row, including thrown network errors, so a claimed send can be retried.

Setup always reconciles the singleton user row with validated environment configuration and stores the public Worker origin. Twilio uses that stored origin to send a `StatusCallback`; retries preserve task passthrough and save the new provider message ID.

Validation rejects impossible dates and malformed 12-hour times. AI daily usage uses one atomic SQLite upsert with a conditional cap. Multiple AI actions targeting the same task are reduced to the first accepted action.

## Error Handling

- Authentication failures return `401` without logging secrets.
- Missing Trello application secret blocks Trello POST callbacks and is surfaced on `/setup`.
- Inbound execution errors retry up to five times, then become terminal with the last error retained.
- Provider send exceptions are converted to failed outbound rows rather than escaping after a scheduler claim.
- Conditional claims return false when another invocation already owns the work.

## Testing

Every behavior change begins with a failing Vitest regression test. Pure validation/authentication helpers are tested directly. D1-dependent functions use small deterministic fake bindings that exercise prepared-statement inputs and claim outcomes. Final verification runs the complete unit suite, TypeScript, `wrangler types --check`, and a Wrangler dry-run bundle.

