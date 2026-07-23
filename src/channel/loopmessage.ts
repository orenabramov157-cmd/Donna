// LoopMessage iMessage adapter. API shape verified against
// docs.loopmessage.com on 2026-07-23 (see PLAYBOOK.md §3).

import type { AppEnv } from '../env';
import type { Channel, Inbound } from './types';
import { timingSafeEqualStr } from './types';

const SEND_URL = 'https://a.loopmessage.com/api/v1/message/send/';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function reactionInbound(b: Record<string, unknown>, from: string, dedupeId: string): Inbound {
  const reaction = str(b.reaction) ?? str(b.text) ?? '';
  // Which message was reacted to: prefer an explicit reference, fall back to
  // message_id. The engine treats an unresolvable reference as a no-op.
  const refMessageId = str(b.reply_to_id) ?? str(b.message_id);
  return { kind: 'reaction', from, reaction, refMessageId, dedupeId };
}

export const loopMessage: Channel = {
  name: 'loopmessage',

  async send(env: AppEnv, to: string, text: string, opts) {
    if (!env.LOOP_AUTH_KEY) {
      console.error(JSON.stringify({ evt: 'loop_send_skipped', reason: 'LOOP_AUTH_KEY missing' }));
      return null;
    }
    const body: Record<string, unknown> = { contact: to, text };
    if (opts?.passthrough) body.passthrough = opts.passthrough;
    if (opts?.replyToId) body.reply_to_id = opts.replyToId;
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: env.LOOP_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(JSON.stringify({ evt: 'loop_send_failed', status: res.status, detail }));
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    return { messageId: str(data.message_id) };
  },

  async parseWebhook(request: Request, env: AppEnv): Promise<Inbound | null> {
    const auth = request.headers.get('Authorization') ?? '';
    if (!env.LOOP_WEBHOOK_AUTH || !(await timingSafeEqualStr(env.LOOP_WEBHOOK_AUTH, auth))) {
      return null;
    }
    let b: Record<string, unknown>;
    try {
      b = (await request.json()) as Record<string, unknown>;
    } catch {
      return { kind: 'ignored', reason: 'unparseable body', dedupeId: crypto.randomUUID() };
    }
    const event = str(b.event) ?? 'unknown';
    const messageId = str(b.message_id);
    const dedupeId = str(b.webhook_id) ?? `${event}:${messageId ?? crypto.randomUUID()}`;
    const from = str(b.contact) ?? '';

    if (event === 'message_inbound') {
      const type = str(b.message_type) ?? 'text';
      if (type === 'reaction') return reactionInbound(b, from, dedupeId);
      const speech = b.speech && typeof b.speech === 'object' ? (b.speech as Record<string, unknown>) : null;
      const text = str(b.text) ?? (speech ? str(speech.text) : null);
      if (text) return { kind: 'text', from, text, dedupeId, messageId };
      return { kind: 'ignored', reason: `no text (message_type=${type})`, dedupeId };
    }
    if (event === 'message_reaction') {
      return reactionInbound(b, from, dedupeId);
    }
    if (event === 'message_delivered' || event === 'message_failed') {
      return {
        kind: 'status',
        status: event === 'message_failed' ? 'failed' : 'delivered',
        refMessageId: messageId,
        passthrough: str(b.passthrough),
        dedupeId,
      };
    }
    return { kind: 'ignored', reason: `event ${event}`, dedupeId };
  },
};
