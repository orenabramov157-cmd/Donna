# 🤖 Accountability Bot

A single-user accountability drill sergeant that lives in your **iMessage**. It plans your day from **Trello**, texts you when it's time to move, nags until things are done or honestly renegotiated, and sends an evening recap with the receipts. Runs entirely on **Cloudflare's free tier** — after a one-time browser setup, no computer of yours is involved. Your Mac can sleep forever.

**$0/month** on the default path (Cloudflare free tier + LoopMessage sandbox + free Trello API). A paid Twilio SMS fallback (~$10/mo) is built in if you ever outgrow the sandbox.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/orenabramov157-cmd/accountability-bot)

Then open **[HANDOFF.md](HANDOFF.md)** and follow it top to bottom (≈25 minutes, browser only, no terminal). If you have an AI assistant — ChatGPT, Codex, Claude, anything — open HANDOFF.md in the chat and ask it to walk you through.

## What it does

- 🌅 **Morning plan** — pulls your Trello "Today" list, proposes times, locks the day on your "ok"
- ⏰ **Nags on schedule** — `done` / `start` / `snooze 30` / `tomorrow` / `blocked <why>`, or just 👍 the message
- 📈 **Escalation ladder** — deferring gets progressively harder: next-action → shrink it → 10-minute start or drop. Five deferrals parks the task until you rewrite or kill it. No silent carry-forward, ever.
- 📍 **Pulse check-ins** — periodic scoreboard during work hours ("2 done, 3 open — status?")
- 🌙 **Evening + weekly recaps** — completed, dropped, parked, still-open, and factual patterns only
- 🔁 **Trello two-way sync** — drag a card to Done and the bot already knows; text `add: call vendor 10am` and the card appears
- 🎚 **Nag levels** — text `nag gentle`, `nag standard`, or `nag relentless`. Quiet hours respected.
- 🧠 **AI optional** — natural language works via Workers AI (free tier); exact keywords always work with zero AI

## How it's built

One Cloudflare Worker + D1 database + a 1-minute cron. iMessage via LoopMessage (pluggable adapter; Twilio SMS included). Full spec in [PLAYBOOK.md](PLAYBOOK.md).

## Development

```
npm install
npm run check   # typecheck
npm test        # unit tests (ladder, grammar, DST math, nag policy)
npm run dev     # local dev (needs .dev.vars — see .dev.vars.example)
npm run deploy  # deploy from CLI (alternative to the button)
```
