import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/env';
import { twilio } from '../src/channel/twilio';

afterEach(() => {
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
