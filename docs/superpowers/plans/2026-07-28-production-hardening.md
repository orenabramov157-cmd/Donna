# Donna Production Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the reviewed security, state-loss, scheduling, provider-integration, and validation defects without deploying or adding paid infrastructure.

**Architecture:** Keep the existing Cloudflare Worker, D1 database, cron, and channel adapters. Add small pure helpers plus conditional D1 claim operations so behavior is testable and concurrent invocations cannot dispatch the same logical work.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite, Workers Web Crypto, Vitest, Wrangler.

## Global Constraints

- Do not deploy or perform any paid action.
- Preserve the default LoopMessage flow.
- Trello POST callbacks require `TRELLO_APP_SECRET`.
- Inbound processing retries at most five times.
- Every production change follows a failing-test-first cycle.
- Keep the worktree free of unrelated changes.

---

### Task 1: Validation and webhook security

**Files:**
- Modify: `src/time.ts`
- Modify: `src/engine/brain.ts`
- Modify: `src/trello.ts`
- Modify: `src/index.ts`
- Modify: `src/env.ts`
- Test: `test/time.test.ts`
- Test: `test/brain.test.ts`
- Create: `test/trello.test.ts`

**Interfaces:**
- Produce: `verifyTrelloWebhook(rawBody, callbackUrl, signature, secret): Promise<boolean>`
- Produce: strict `parseTimeToken()` and calendar-date validation.

- [ ] Add tests rejecting `13am`, `0pm`, invalid minutes, and impossible calendar dates.
- [ ] Add tests proving Trello signature success/failure and credential-free error metadata.
- [ ] Run targeted tests and confirm they fail for the reviewed reasons.
- [ ] Implement strict validation, HMAC verification, path redaction, raw-body handling, and no-store setup responses.
- [ ] Re-run targeted tests until green.

### Task 2: Provider registration and delivery callbacks

**Files:**
- Modify: `src/channel/types.ts`
- Modify: `src/channel/twilio.ts`
- Modify: `src/trello.ts`
- Modify: `src/engine/core.ts`
- Test: `test/channel.test.ts`
- Test: `test/trello.test.ts`

**Interfaces:**
- Extend: `SendOpts` with `statusCallbackUrl?: string`.
- Preserve: `Channel.send(...): Promise<{messageId: string | null} | null>`.

- [ ] Add failing tests proving Twilio includes `StatusCallback` and failed Trello webhook listing does not POST a duplicate.
- [ ] Implement the minimal adapter and registration changes.
- [ ] Re-run targeted tests until green.

### Task 3: Durable inbound handling and profile synchronization

**Files:**
- Modify: `src/db.ts`
- Modify: `src/engine/core.ts`
- Create: `test/core-state.test.ts`

**Interfaces:**
- Produce: `recordInboundFailure(db, dedupeId, error, maxAttempts): Promise<boolean>`, returning whether the row became terminal.
- Change: `upsertUser()` updates every configured singleton-user field.

- [ ] Add failing tests for retryable inbound failures and full owner-profile reconciliation.
- [ ] Implement bounded failure recording while leaving retriable rows unprocessed.
- [ ] Always reconcile the profile during setup.
- [ ] Re-run targeted tests until green.

### Task 4: Daily nag rollover, AI budget, and conflicting actions

**Files:**
- Modify: `src/engine/nag.ts`
- Modify: `src/engine/core.ts`
- Modify: `src/engine/brain.ts`
- Modify: `src/parse.ts`
- Modify: `src/db.ts`
- Test: `test/nag.test.ts`
- Test: `test/brain.test.ts`
- Test: `test/core-state.test.ts`

**Interfaces:**
- Produce: `nagsSentToday(task, todayLocal, timezone): number`.
- Produce: `incrementSettingBelow(db, key, cap): Promise<boolean>`.

- [ ] Add failing rollover, duplicate-action, and atomic-budget tests.
- [ ] Implement local-date-aware nag counts and first-action-per-task validation.
- [ ] Replace the AI budget read/modify/write with a conditional SQLite upsert.
- [ ] Re-run targeted tests until green.

### Task 5: Scheduler and outbound retry claims

**Files:**
- Modify: `src/db.ts`
- Modify: `src/engine/core.ts`
- Test: `test/core-state.test.ts`

**Interfaces:**
- Produce conditional claim helpers for session fields, task nags, settings leases, and outbound retries.
- Produce outbound-attempt update that stores `channel_message_id`, status, and retry count together.

- [ ] Add failing tests proving only one claimant wins and successful retries retain task/message correlation.
- [ ] Claim morning plans, nudges, nags, pulses, recaps, weekly recaps, and retries before sending.
- [ ] Make `sendOwner` log thrown provider errors as failed outbound attempts.
- [ ] Re-run targeted tests until green.

### Task 6: Trello echo correlation, generated types, and documentation

**Files:**
- Modify: `src/db.ts`
- Modify: `src/engine/core.ts`
- Modify: `.dev.vars.example`
- Modify: `HANDOFF.md`
- Modify: `worker-configuration.d.ts`
- Test: `test/core-state.test.ts`

**Interfaces:**
- Change: `recentTrelloEcho()` accepts the expected outbound kind and optional detail.

- [ ] Add a failing test showing a create echo is suppressed but a subsequent move-to-Done is not.
- [ ] Narrow echo matching to the expected Trello action.
- [ ] Document `TRELLO_APP_SECRET` and the setup-derived Twilio callback.
- [ ] Run `npm run types` and confirm `wrangler types --check` passes.

### Task 7: Final verification

**Files:**
- Review all changed files.

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `WRANGLER_LOG_PATH=/tmp/donna-wrangler-final.log npx wrangler types --check`.
- [ ] Run `WRANGLER_LOG_PATH=/tmp/donna-wrangler-final.log npx wrangler deploy --dry-run --outdir /tmp/donna-wrangler-final`.
- [ ] Inspect `git diff --check`, `git status`, and the complete diff.
- [ ] Perform a final review for security regressions, floating promises, secret exposure, and claim ordering.
