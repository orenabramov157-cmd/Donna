#!/usr/bin/env bash
# Local live-fire smoke test — boots the Worker on Miniflare with dummy
# secrets, drives the real HTTP surface (setup, inbound webhooks, dedupe,
# auth rejection, a cron tick), then asserts the persisted D1 state.
# No cloud resources, no real secrets, no production data. ~30 seconds.
#
#   ./scripts/smoke-local.sh
#
# Exit 0 = PASS, exit 1 = FAIL (with the failed assertion printed).
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=8788
STATE=".wrangler/smoke-state"
LOG="$(mktemp -t donna-smoke)"
AUTH="smokewebhookauth1234567890ab"
TOKEN="smokewebhooktoken1234567890a"
SETUP="smokesetupkey1234567890abcdef"
BASE="http://localhost:$PORT"

rm -rf "$STATE"

npx wrangler dev --port "$PORT" --test-scheduled --persist-to "$STATE" \
  --var LOOP_AUTH_KEY:smoke-dummy-key \
  --var LOOP_WEBHOOK_AUTH:"$AUTH" \
  --var OWNER_CONTACT:+13105550100 \
  --var SETUP_KEY:"$SETUP" \
  --var WEBHOOK_TOKEN:"$TOKEN" \
  >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
trap cleanup EXIT

fail() {
  echo "FAIL: $1"
  echo "--- last 30 log lines ($LOG) ---"
  tail -30 "$LOG"
  exit 1
}

for i in $(seq 1 30); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && fail "worker never became healthy"
  sleep 1
done

hook() { # hook <webhook_id> <text>
  curl -s -m 20 -X POST "$BASE/webhook/loop/$TOKEN" \
    -H "Authorization: $AUTH" -H "Content-Type: application/json" \
    -d "{\"event\":\"message_inbound\",\"message_type\":\"text\",\"text\":\"$2\",\"contact\":\"+13105550100\",\"webhook_id\":\"$1\",\"message_id\":\"$1\"}"
}

curl -sf "$BASE/setup?key=$SETUP" | grep -q "❌" && fail "setup page shows a red X"
[ "$(hook smoke-add-1 'add: smoke test task 9pm')" = '{"ok":true}' ] || fail "add webhook rejected"
[ "$(hook smoke-add-1 'add: smoke test task 9pm')" = '{"ok":true}' ] || fail "duplicate webhook errored (should no-op with 200)"
[ "$(hook smoke-status-2 status)" = '{"ok":true}' ] || fail "status webhook rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/webhook/loop/$TOKEN" \
  -H "Authorization: WRONG" -d '{"event":"message_inbound","text":"x","contact":"+13105550100","webhook_id":"evil"}')
[ "$code" = "401" ] || fail "bad auth returned $code, expected 401"
curl -sf "$BASE/__scheduled?cron=*+*+*+*+*" -o /dev/null || fail "scheduled tick errored"
sleep 2

cleanup
trap - EXIT

ROWS=$(npx wrangler d1 execute accountability-bot-db --local --persist-to "$STATE" --json --command \
  "SELECT (SELECT COUNT(*) FROM tasks) AS tasks,
          (SELECT COUNT(*) FROM inbound_events WHERE processed_at_utc IS NOT NULL AND error IS NULL) AS processed,
          (SELECT COUNT(*) FROM outbound_log) AS outbound,
          (SELECT COUNT(*) FROM outbound_log WHERE retry_count >= 1) AS retried;" 2>/dev/null |
  python3 -c "import sys,json,re; m=re.search(r'\[[\s\S]*\]',sys.stdin.read()); r=json.loads(m.group(0))[0]['results'][0]; print(r['tasks'],r['processed'],r['outbound'],r['retried'])")
read -r TASKS PROCESSED OUTBOUND RETRIED <<<"$ROWS"

[ "$TASKS" = "1" ] || fail "expected exactly 1 task (dedupe), got $TASKS"
[ "$PROCESSED" = "2" ] || fail "expected 2 processed inbound events, got $PROCESSED"
[ "$OUTBOUND" -ge 2 ] || fail "expected >=2 outbound attempts, got $OUTBOUND"
[ "$RETRIED" -ge 1 ] || fail "expected cron to retry failed sends, got $RETRIED retried"

rm -rf "$STATE"
echo "PASS: health+setup green, webhook processed, duplicate deduped (1 task), bad auth 401, cron ticked, $OUTBOUND sends logged, $RETRIED retried."
