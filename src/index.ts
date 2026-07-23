// HTTP surface + cron entrypoint. Thin by design: verify, route, delegate to
// the engine. See PLAYBOOK.md §8.

import type { AppEnv } from './env';
import { ensureSchema } from './schema';
import { getSetting } from './db';
import { getChannel } from './channel';
import { timingSafeEqualStr } from './channel/types';
import { handleTrelloWebhook, processInbound, runSetup, tick } from './engine/core';

const VERSION = '1.0.0';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/health') {
        await ensureSchema(env.DB);
        const last = await getSetting(env.DB, 'last_cron_at');
        return json({ ok: true, version: VERSION, last_cron_at: last ? Number(last) : null });
      }

      if (url.pathname === '/setup' && request.method === 'GET') {
        const key = url.searchParams.get('key') ?? '';
        if (!env.SETUP_KEY || !(await timingSafeEqualStr(env.SETUP_KEY, key))) return new Response('not found', { status: 404 });
        const html = await runSetup(env, url);
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      if (seg[0] === 'webhook' && seg[1] === 'loop' && seg[2]) {
        if (!env.WEBHOOK_TOKEN || !(await timingSafeEqualStr(env.WEBHOOK_TOKEN, seg[2]))) {
          return new Response('not found', { status: 404 });
        }
        if (request.method !== 'POST') return new Response('ok');
        const inbound = await getChannel(env).parseWebhook(request, env);
        if (!inbound) return new Response('unauthorized', { status: 401 });
        await processInbound(env, inbound);
        return json({ ok: true });
      }

      if (seg[0] === 'webhook' && seg[1] === 'trello' && seg[2]) {
        if (!env.WEBHOOK_TOKEN || !(await timingSafeEqualStr(env.WEBHOOK_TOKEN, seg[2]))) {
          return new Response('not found', { status: 404 });
        }
        // Trello sends HEAD on webhook registration and expects a 200.
        if (request.method === 'HEAD' || request.method === 'GET') return new Response('ok');
        let body: unknown = null;
        try {
          body = await request.json();
        } catch {
          return new Response('ok'); // keep Trello happy; nothing to do
        }
        await handleTrelloWebhook(env, body);
        return new Response('ok');
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error(
        JSON.stringify({
          evt: 'fetch_error',
          path: url.pathname,
          err: err instanceof Error ? (err.stack ?? err.message) : String(err),
        }),
      );
      return json({ ok: false }, 500);
    }
  },

  async scheduled(controller: ScheduledController, env: AppEnv): Promise<void> {
    try {
      await tick(env, controller.scheduledTime || Date.now());
    } catch (err) {
      console.error(
        JSON.stringify({ evt: 'cron_error', err: err instanceof Error ? (err.stack ?? err.message) : String(err) }),
      );
    }
  },
} satisfies ExportedHandler<AppEnv>;
