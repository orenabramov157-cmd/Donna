# HANDOFF — Set up your Accountability Bot (~25 min, browser only)

> **If you are an AI assistant** (ChatGPT, Codex, Claude, or any other) helping with this setup:
> your job is to walk the human through the steps below **in order, one step at a time**, verifying
> each step's ✅ check before moving on. Do **not** modify any code in this repository. Do **not**
> improvise different steps. The human does all the clicking. **Never ask the human to paste a
> secret value (API key, token) into the chat** — secrets go directly from the source website into
> the Cloudflare dashboard fields, and the human just says "done".

What you'll have at the end: a bot that texts you over iMessage all day — morning plan, scheduled
nags, pulse check-ins, evening recap — synced to your Trello board, running 24/7 on Cloudflare's
free tier. Your computer is only needed for this setup; afterwards it can sleep forever.

---

## Step 1 — Cloudflare account

1. Go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and create a free account (skip any paid add-ons).
2. Verify your email.

✅ **Check:** you can see the Cloudflare dashboard.

## Step 2 — Deploy the bot (one click)

1. Open this repo's README and click the **Deploy to Cloudflare** button.
2. Sign in with GitHub when asked (create a free GitHub account if you don't have one) — Cloudflare makes your own copy of the repo.
3. Accept the defaults and click **Create and deploy**. The D1 database is created automatically. Wait for the build to finish (~2 min).
4. Note your Worker URL — it looks like `https://accountability-bot.YOURNAME.workers.dev`.

✅ **Check:** open `https://accountability-bot.YOURNAME.workers.dev/health` in a new tab. You should see `{"ok":true,...}`.

## Step 3 — LoopMessage (the iMessage pipe)

1. Sign up free at [loopmessage.com](https://loopmessage.com) and open their dashboard.
2. Find the **sandbox** section and register **your own phone number** (or Apple ID email) as a sandbox contact, following their instructions.
3. Find your **Organization API Key** in the dashboard. Keep that tab open — you'll paste the key in Step 5.

✅ **Check:** your number is listed as a sandbox contact and you can see the API key.

## Step 4 — Generate three random strings

You need three random strings (24+ characters, **letters and numbers only** — they go inside URLs). Use a password generator, or ask your AI assistant to generate three random alphanumeric strings — these three are not sensitive-in-advance, but treat them like passwords once used:

- one for `SETUP_KEY`
- one for `WEBHOOK_TOKEN`
- one for `LOOP_WEBHOOK_AUTH`

Save them somewhere temporarily (e.g. your notes app).

## Step 5 — Add the secrets in Cloudflare

In the Cloudflare dashboard: **Workers & Pages → accountability-bot → Settings → Variables and Secrets**. Click **Add**, choose type **Secret**, and add each of these:

| Name | Value |
|---|---|
| `LOOP_AUTH_KEY` | the Organization API Key from LoopMessage (paste directly from their tab) |
| `LOOP_WEBHOOK_AUTH` | random string #3 from Step 4 |
| `OWNER_CONTACT` | your phone in international format, e.g. `+12145551234` (or your Apple ID email) |
| `SETUP_KEY` | random string #1 from Step 4 |
| `WEBHOOK_TOKEN` | random string #2 from Step 4 |

Click **Deploy** if the dashboard asks to apply the changes.

✅ **Check:** all five secrets are listed.

## Step 6 — Trello (optional but excellent)

Skip this if you don't use Trello — the bot works standalone. Otherwise:

1. Make sure the board you'll use has a list named **Today** and a list named **Done** (create them if needed).
2. Get the board's full ID: open the board in your browser and add `.json` to the end of the URL. The first `"id"` value (24 characters) is your board ID. Copy it.
3. Go to [trello.com/power-ups/admin](https://trello.com/power-ups/admin) → **New** → fill in anything (name: "accountability-bot", your workspace) → open it → **API key** tab → **Generate a new API key**. Copy the key.
4. On that same page, click the **Token** link (right of the API key) → **Allow** → copy the token.
5. Back in Cloudflare **Variables and Secrets**, add three more Secrets: `TRELLO_KEY`, `TRELLO_TOKEN`, `TRELLO_BOARD_ID` (paste each directly).

✅ **Check:** eight secrets listed in total.

## Step 7 — Your timezone and schedule

Still in **Settings → Variables and Secrets**, the plain-text **variables** control the schedule. Edit if needed (then Deploy):

- `TIMEZONE` — IANA name, e.g. `America/Chicago`, `America/Los_Angeles`
- `MORNING_TIME` (default 08:00), `EVENING_TIME` (20:30), `WORK_START`/`WORK_END`, `QUIET_START`/`QUIET_END`
- `NAG_LEVEL` — `gentle` / `standard` / `relentless` (changeable later by texting the bot)

## Step 8 — Run setup

Open in your browser (swap in your Worker URL and your `SETUP_KEY`):

```
https://accountability-bot.YOURNAME.workers.dev/setup?key=YOUR_SETUP_KEY
```

The page shows a checklist. Fix any ❌ (usually a mistyped secret) and reload.

Then follow the **"Wire up LoopMessage"** box on that page: in the LoopMessage dashboard's webhook settings, paste the callback URL it shows, and set the webhook's **Authorization** header to your `LOOP_WEBHOOK_AUTH` string.

✅ **Check:** every row on the setup page is ✅.

## Step 9 — Test it

Click **"Send a test iMessage"** on the setup page. Your phone should buzz within seconds.

Reply **`help`** to see the commands. Reply **`plan`** to plan your first day.

✅ **Check:** you got the test message AND the bot answered your reply. You're live. 🫡

---

## Daily use (cheat sheet)

- Morning: bot proposes the day from Trello + carryovers → reply `ok` (or `2 at 3pm` to adjust)
- When nagged: `done` · `start` · `snooze 30` · `tomorrow` · `blocked <why>` — or just react 👍 to complete
- Anytime: `status` · `add: call vendor 10am` · `undo` · `nag relentless` · `help`
- Deferring has consequences (by design): the bot will demand a next action, then a smaller task, then a 10-minute start — and parks anything deferred 5 days running.

## Troubleshooting

- **No texts?** `/health` should show a recent `last_cron_at`. Check LoopMessage's webhook history in their dashboard, and Cloudflare → your Worker → **Logs** (live tail).
- **Bot doesn't answer replies?** The LoopMessage webhook URL or its Authorization header doesn't match — redo Step 8's wiring box.
- **Trello not syncing?** Re-run `/setup` — it re-registers the board webhook and re-resolves the Today/Done lists.
- **Changed a secret?** Re-run `/setup` afterwards.
- Setup page is safe to re-run anytime; it never duplicates anything.

## Appendix — switching to Twilio SMS (if the free sandbox ever dies)

1. Buy a number at Twilio (~$1.15/mo) and complete their US A2P registration (~$19 one-time, ~$2/mo).
2. In Cloudflare, add Secrets `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (your Twilio number).
3. Change the `CHANNEL` variable to `twilio` and Deploy.
4. In Twilio's console, set the number's incoming-message webhook to `https://YOUR-WORKER-URL/webhook/loop/YOUR_WEBHOOK_TOKEN` (yes, the same path).
5. Text the bot — everything else is identical.
