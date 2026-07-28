import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/env';
import worker from '../src/index';
import * as core from '../src/engine/core';
import * as trello from '../src/trello';

vi.mock('../src/engine/core', () => ({
  handleTrelloWebhook: vi.fn(),
  processInbound: vi.fn(),
  runSetup: vi.fn(),
  tick: vi.fn(),
}));

const CALLBACK_URL = 'https://donna.example/webhook/trello/public-token';
const RAW_BODY = '{\n  "action": { "type": "createCard" }\n}';
const SIGNATURE = 'ba5TA5KXgXv78vxWaT6vUR0SFlA=';

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
  vi.clearAllMocks();
});

describe('verifyTrelloWebhook', () => {
  it('accepts Trello HMAC-SHA1 over the raw body plus callback URL', async () => {
    await expect(
      trello.verifyTrelloWebhook(RAW_BODY, CALLBACK_URL, SIGNATURE, 'app-secret'),
    ).resolves.toBe(true);
  });

  it('rejects a signature when the raw body changes', async () => {
    await expect(
      trello.verifyTrelloWebhook(`${RAW_BODY} `, CALLBACK_URL, SIGNATURE, 'app-secret'),
    ).resolves.toBe(false);
  });
});

describe('Trello API errors', () => {
  it('logs credential-free metadata with token path segments redacted', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('upstream failed', { status: 500 }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = {
      TRELLO_KEY: 'key-secret',
      TRELLO_TOKEN: 'token-secret',
      TRELLO_BOARD_ID: 'board-id',
    } as AppEnv;

    await expect(trello.registerWebhook(env, CALLBACK_URL)).resolves.toBe('failed');

    const entries = error.mock.calls.map((call) => String(call[0]));
    expect(entries.map((entry) => JSON.parse(entry))).toContainEqual({
      evt: 'trello_api_error',
      method: 'GET',
      path: '/tokens/[redacted]/webhooks',
      status: 500,
    });
    expect(entries.join('\n')).not.toContain('key-secret');
    expect(entries.join('\n')).not.toContain('token-secret');
  });
});

describe('Trello HTTP surface', () => {
  it('rejects POST callbacks with an invalid signature', async () => {
    const env = {
      WEBHOOK_TOKEN: 'public-token',
      TRELLO_APP_SECRET: 'app-secret',
    } as AppEnv;
    const request = new Request(CALLBACK_URL, {
      method: 'POST',
      headers: { 'X-Trello-Webhook': 'invalid' },
      body: RAW_BODY,
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(401);
    expect(vi.mocked(core.handleTrelloWebhook)).not.toHaveBeenCalled();
  });

  it('verifies the exact raw body before parsing a valid callback', async () => {
    const env = {
      WEBHOOK_TOKEN: 'public-token',
      TRELLO_APP_SECRET: 'app-secret',
    } as AppEnv;
    const request = new Request(CALLBACK_URL, {
      method: 'POST',
      headers: { 'X-Trello-Webhook': SIGNATURE },
      body: RAW_BODY,
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(200);
    expect(vi.mocked(core.handleTrelloWebhook)).toHaveBeenCalledWith(env, {
      action: { type: 'createCard' },
    });
  });

  it('redacts webhook credentials from fetch-error paths', async () => {
    vi.mocked(core.handleTrelloWebhook).mockRejectedValueOnce(new Error('boom'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = {
      WEBHOOK_TOKEN: 'public-token',
      TRELLO_APP_SECRET: 'app-secret',
    } as AppEnv;
    const request = new Request(CALLBACK_URL, {
      method: 'POST',
      headers: { 'X-Trello-Webhook': SIGNATURE },
      body: RAW_BODY,
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(500);
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
      evt: 'fetch_error',
      path: '/webhook/trello/[redacted]',
    });
    expect(String(error.mock.calls[0]?.[0])).not.toContain('public-token');
  });

  it('marks setup responses as non-cacheable', async () => {
    const response = await worker.fetch(new Request('https://donna.example/setup'), {} as AppEnv);

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
