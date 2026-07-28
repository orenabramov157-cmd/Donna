import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/env';
import { loopMessage } from '../src/channel/loopmessage';
import { twilio } from '../src/channel/twilio';

beforeEach(() => {
  Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
    configurable: true,
    value: (a: ArrayBufferView, b: ArrayBufferView): boolean => {
      const aa = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      const bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
      if (aa.byteLength !== bb.byteLength) return false;
      let diff = 0;
      for (let i = 0; i < aa.byteLength; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
      return diff === 0;
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(crypto.subtle, 'timingSafeEqual');
  vi.restoreAllMocks();
});

describe('Twilio channel', () => {
  it('includes the configured delivery status callback when sending a message', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 }),
    );
    const env = {
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'auth-token',
      TWILIO_FROM: '+15551234567',
    } as AppEnv;

    await twilio.send(env, '+15557654321', 'Check in.', {
      statusCallbackUrl: 'https://donna.example/webhook/loop/public-token',
    });

    const request = fetchMock.mock.calls[0];
    expect(request?.[1]).toMatchObject({ method: 'POST' });
    expect(new URLSearchParams(String(request?.[1]?.body)).get('StatusCallback')).toBe(
      'https://donna.example/webhook/loop/public-token',
    );
  });
});

describe('delivery-attempt callback correlation', () => {
  it('parses LoopMessage attempt metadata from passthrough', async () => {
    const passthrough = JSON.stringify({
      v: 1,
      outboundId: 8,
      attemptToken: 'worker-new',
      taskId: 42,
    });
    const request = new Request('https://donna.example/webhook/loop/public-token', {
      method: 'POST',
      headers: { Authorization: 'loop-guard', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'message_failed',
        message_id: 'SM-new',
        webhook_id: 'status-new',
        passthrough,
      }),
    });

    const inbound = await loopMessage.parseWebhook(
      request,
      { LOOP_WEBHOOK_AUTH: 'loop-guard' } as AppEnv,
    );

    expect(inbound).toMatchObject({
      kind: 'status',
      status: 'failed',
      refMessageId: 'SM-new',
      passthrough,
      outboundId: 8,
      attemptToken: 'worker-new',
    });
  });

  it('parses Twilio attempt metadata from the signed StatusCallback URL', async () => {
    const callbackUrl =
      'https://donna.example/webhook/loop/public-token?outbound_id=8&attempt_token=worker-new';
    const params = { MessageSid: 'SM-new', MessageStatus: 'failed' };
    const signedData = callbackUrl + Object.keys(params).sort().map((key) => key + params[key as keyof typeof params]).join('');
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('twilio-secret'),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const rawSignature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedData));
    const signature = btoa(String.fromCharCode(...new Uint8Array(rawSignature)));
    const request = new Request(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature,
      },
      body: new URLSearchParams(params),
    });

    const inbound = await twilio.parseWebhook(
      request,
      { TWILIO_AUTH_TOKEN: 'twilio-secret' } as AppEnv,
    );

    expect(inbound).toMatchObject({
      kind: 'status',
      status: 'failed',
      refMessageId: 'SM-new',
      outboundId: 8,
      attemptToken: 'worker-new',
    });
  });
});
