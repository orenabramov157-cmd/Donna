// Twilio SMS adapter — the paid fallback if the LoopMessage sandbox ever
// closes. Activated by CHANNEL=twilio plus the three TWILIO_* secrets; the
// engine is unchanged. Twilio posts form-encoded webhooks signed with
// X-Twilio-Signature (HMAC-SHA1 over URL + sorted params).

import type { AppEnv } from '../env';
import type { Channel, Inbound } from './types';
import { timingSafeEqualStr } from './types';

async function twilioSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + (params[k] ?? '')).join('');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export const twilio: Channel = {
  name: 'twilio',

  async send(env: AppEnv, to: string, text: string) {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) {
      console.error(JSON.stringify({ evt: 'twilio_send_skipped', reason: 'TWILIO_* secrets missing' }));
      return null;
    }
    const body = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(JSON.stringify({ evt: 'twilio_send_failed', status: res.status, detail }));
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    return { messageId: typeof data.sid === 'string' ? data.sid : null };
  },

  async parseWebhook(request: Request, env: AppEnv): Promise<Inbound | null> {
    if (!env.TWILIO_AUTH_TOKEN) return null;
    const form = await request.formData();
    const params: Record<string, string> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === 'string') params[k] = v;
    }
    // Note: request.url must match the URL Twilio signed. Workers sees the
    // public URL directly, so this holds; if a proxy ever rewrites it, set
    // the webhook to the workers.dev URL.
    const expected = await twilioSignature(env.TWILIO_AUTH_TOKEN, request.url, params);
    const given = request.headers.get('X-Twilio-Signature') ?? '';
    if (!(await timingSafeEqualStr(expected, given))) return null;

    const sid = params['MessageSid'] ?? params['SmsSid'] ?? crypto.randomUUID();
    const status = params['MessageStatus'];
    if (status === 'delivered' || status === 'failed' || status === 'undelivered') {
      return {
        kind: 'status',
        status: status === 'delivered' ? 'delivered' : 'failed',
        refMessageId: sid,
        passthrough: null,
        dedupeId: `status:${sid}:${status}`,
      };
    }
    const text = params['Body']?.trim();
    const from = params['From'] ?? '';
    if (text) return { kind: 'text', from, text, dedupeId: sid, messageId: sid };
    return { kind: 'ignored', reason: 'empty body', dedupeId: sid };
  },
};
