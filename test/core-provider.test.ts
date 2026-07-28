import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutboundRow, UserRow } from '../src/db';
import type { AppEnv } from '../src/env';
import * as channel from '../src/channel';
import * as db from '../src/db';
import { tick } from '../src/engine/core';

vi.mock('../src/schema', () => ({ ensureSchema: vi.fn() }));

const user: UserRow = {
  id: 1,
  contact: '+15551234567',
  timezone: 'America/Los_Angeles',
  morning_time: '08:00',
  evening_time: '20:30',
  work_start: '09:00',
  work_end: '18:00',
  quiet_start: '22:00',
  quiet_end: '07:30',
  nag_level: 'standard',
  pulse_every_min: 150,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('outbound retry delivery', () => {
  it('reuses callback options and records the new provider message ID', async () => {
    const outbound: OutboundRow = {
      id: 8,
      at_utc: 0,
      kind: 'nag',
      task_id: 42,
      channel_message_id: 'SM-old',
      trello_card_id: null,
      body: 'Finish the draft.',
      status: 'failed',
      retry_count: 2,
    };
    const send = vi.fn().mockResolvedValue({ messageId: 'SM-new' });
    vi.spyOn(channel, 'getChannel').mockReturnValue({
      name: 'twilio',
      send,
      parseWebhook: vi.fn(),
    });
    vi.spyOn(db, 'getUser').mockResolvedValue(user);
    vi.spyOn(db, 'setSetting').mockResolvedValue();
    vi.spyOn(db, 'ensureSession').mockResolvedValue({
      local_date: '2026-07-28',
      plan_state: 'confirmed',
      prompted_at_utc: null,
      nudges_sent: 0,
      recap_sent_at_utc: null,
      weekly_sent: 0,
    });
    vi.spyOn(db, 'unprocessedInbound').mockResolvedValue([]);
    vi.spyOn(db, 'failedOutbound').mockResolvedValue([outbound]);
    vi.spyOn(db, 'claimOutboundRetry').mockResolvedValue(true);
    vi.spyOn(db, 'renewOutboundAttempt').mockResolvedValue(true);
    vi.spyOn(db, 'getSetting').mockResolvedValue('https://donna.example');
    const complete = vi.spyOn(db, 'completeOutboundAttempt').mockResolvedValue(true);

    await tick(
      { DB: {} as D1Database, WEBHOOK_TOKEN: 'public-token', CHANNEL: 'twilio' } as AppEnv,
      Date.UTC(2026, 6, 28, 14, 0),
    );

    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      user.contact,
      outbound.body,
      {
        passthrough: 'task:42',
        statusCallbackUrl: 'https://donna.example/webhook/loop/public-token',
      },
    );
    expect(complete).toHaveBeenCalledWith(
      {} as D1Database,
      outbound.id,
      expect.any(String),
      'sent',
      3,
      'SM-new',
    );
  });

  it('keeps the prior provider message ID when a retry cannot send', async () => {
    const outbound: OutboundRow = {
      id: 9,
      at_utc: 0,
      kind: 'nag',
      task_id: 42,
      channel_message_id: 'SM-old',
      trello_card_id: null,
      body: 'Finish the draft.',
      status: 'failed',
      retry_count: 2,
    };
    vi.spyOn(channel, 'getChannel').mockReturnValue({
      name: 'twilio',
      send: vi.fn().mockResolvedValue(null),
      parseWebhook: vi.fn(),
    });
    vi.spyOn(db, 'getUser').mockResolvedValue(user);
    vi.spyOn(db, 'setSetting').mockResolvedValue();
    vi.spyOn(db, 'ensureSession').mockResolvedValue({
      local_date: '2026-07-28',
      plan_state: 'confirmed',
      prompted_at_utc: null,
      nudges_sent: 0,
      recap_sent_at_utc: null,
      weekly_sent: 0,
    });
    vi.spyOn(db, 'unprocessedInbound').mockResolvedValue([]);
    vi.spyOn(db, 'failedOutbound').mockResolvedValue([outbound]);
    vi.spyOn(db, 'claimOutboundRetry').mockResolvedValue(true);
    vi.spyOn(db, 'renewOutboundAttempt').mockResolvedValue(true);
    vi.spyOn(db, 'getSetting').mockResolvedValue('https://donna.example');
    const complete = vi.spyOn(db, 'completeOutboundAttempt').mockResolvedValue(true);

    await tick(
      { DB: {} as D1Database, WEBHOOK_TOKEN: 'public-token', CHANNEL: 'twilio' } as AppEnv,
      Date.UTC(2026, 6, 28, 14, 0),
    );

    expect(complete).toHaveBeenCalledWith(
      {} as D1Database,
      outbound.id,
      expect.any(String),
      'failed',
      3,
      undefined,
    );
  });

  it('renews a slow provider attempt so an overlapping tick cannot reclaim it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 6, 28, 14, 0));
    const outbound: OutboundRow = {
      id: 10,
      at_utc: 0,
      kind: 'nag',
      task_id: 42,
      channel_message_id: 'SM-old',
      trello_card_id: null,
      body: 'Finish the draft.',
      status: 'failed',
      retry_count: 2,
    };
    let release!: () => void;
    const provider = new Promise<{ messageId: string }>((resolve) => {
      release = () => resolve({ messageId: 'SM-new' });
    });
    const send = vi.fn().mockReturnValue(provider);
    vi.spyOn(channel, 'getChannel').mockReturnValue({ name: 'twilio', send, parseWebhook: vi.fn() });
    vi.spyOn(db, 'getUser').mockResolvedValue(user);
    vi.spyOn(db, 'setSetting').mockResolvedValue();
    vi.spyOn(db, 'ensureSession').mockResolvedValue({
      local_date: '2026-07-28',
      plan_state: 'confirmed',
      prompted_at_utc: null,
      nudges_sent: 0,
      recap_sent_at_utc: null,
      weekly_sent: 0,
    });
    vi.spyOn(db, 'unprocessedInbound').mockResolvedValue([]);
    vi.spyOn(db, 'failedOutbound').mockResolvedValue([outbound]);
    vi.spyOn(db, 'getSetting').mockResolvedValue(null);
    const claim = vi.spyOn(db, 'claimOutboundRetry').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const renew = vi.spyOn(db, 'renewOutboundAttempt').mockResolvedValue(true);
    const complete = vi.spyOn(db, 'completeOutboundAttempt').mockResolvedValue(true);

    const first = tick({ DB: {} as D1Database } as AppEnv, Date.UTC(2026, 6, 28, 14, 0));
    await vi.advanceTimersByTimeAsync(100_001);
    const second = tick({ DB: {} as D1Database } as AppEnv, Date.UTC(2026, 6, 28, 14, 1));
    await vi.advanceTimersByTimeAsync(1);
    release();
    await Promise.all([first, second]);

    expect(renew).toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });
});
