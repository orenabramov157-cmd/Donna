import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/env';
import type { UserRow } from '../src/db';
import * as db from '../src/db';
import { recordInboundFailure, upsertUser } from '../src/db';
import { processInbound, runSetup, tick } from '../src/engine/core';

vi.mock('../src/schema', () => ({ ensureSchema: vi.fn() }));

const configuredUser: Omit<UserRow, 'id'> = {
  contact: '+15557654321',
  timezone: 'America/New_York',
  morning_time: '07:15',
  evening_time: '21:45',
  work_start: '08:30',
  work_end: '17:30',
  quiet_start: '23:00',
  quiet_end: '06:45',
  nag_level: 'relentless',
  pulse_every_min: 90,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function inboundFailureDb(
  initial: { attempts: number; error: string; processedAt: number | null },
  synchronizeReads = false,
) {
  const state = {
    error: JSON.stringify({ attempts: initial.attempts, error: initial.error }),
    processedAt: initial.processedAt,
  };
  const waitingReads: Array<() => void> = [];
  const waitForOverlappingRead = (): Promise<void> => {
    if (!synchronizeReads) return Promise.resolve();
    return new Promise((resolve) => {
      waitingReads.push(resolve);
      if (waitingReads.length === 2) {
        for (const release of waitingReads) release();
      }
    });
  };
  const attempts = (): number => {
    const parsed = JSON.parse(state.error) as { attempts: number };
    return parsed.attempts;
  };
  const prepare = vi.fn((sql: string) => {
    if (sql.startsWith('SELECT')) {
      return {
        bind: vi.fn(() => ({
          first: async () => {
            const snapshot = { error: state.error };
            await waitForOverlappingRead();
            return snapshot;
          },
        })),
      };
    }
    if (sql.includes('RETURNING processed_at_utc')) {
      return {
        bind: vi.fn(
          (maxAttempts: number, terminalAt: number, repeatedMax: number, error: string, _dedupeId: string) => ({
            first: async () => {
              expect(repeatedMax).toBe(maxAttempts);
              if (state.processedAt !== null) return null;
              const nextAttempts = Math.min(attempts() + 1, maxAttempts);
              state.error = JSON.stringify({ attempts: nextAttempts, error });
              state.processedAt = nextAttempts >= maxAttempts ? terminalAt : null;
              return { processed_at_utc: state.processedAt };
            },
          }),
        ),
      };
    }
    return {
      bind: vi.fn((processedAt: number | null, error: string, _dedupeId: string) => ({
        run: async () => {
          state.error = error;
          state.processedAt = processedAt;
          return { meta: { changes: 1 } };
        },
      })),
    };
  });
  return {
    db: { prepare } as unknown as D1Database,
    state,
  };
}

describe('durable inbound failures', () => {
  it('leaves the first four sequential failures retryable and makes only the fifth terminal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T18:00:00.000Z'));
    const fake = inboundFailureDb({ attempts: 0, error: '', processedAt: null });
    const transitions: boolean[] = [];

    for (let attempt = 1; attempt <= 5; attempt++) {
      transitions.push(await recordInboundFailure(fake.db, 'evt-1', `failure ${attempt}`, 5));
    }

    expect(transitions).toEqual([false, false, false, false, true]);
    expect(fake.state).toEqual({
      error: JSON.stringify({ attempts: 5, error: 'failure 5' }),
      processedAt: Date.now(),
    });
  });

  it('does not transition or overwrite a row that is already terminal', async () => {
    const fake = inboundFailureDb({ attempts: 5, error: 'terminal failure', processedAt: 1234 });

    await expect(recordInboundFailure(fake.db, 'evt-2', 'late failure', 5)).resolves.toBe(false);

    expect(fake.state).toEqual({
      error: JSON.stringify({ attempts: 5, error: 'terminal failure' }),
      processedAt: 1234,
    });
  });

  it('allows only one overlapping worker to make the fifth-attempt transition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T18:00:00.000Z'));
    const fake = inboundFailureDb({ attempts: 4, error: 'failure 4', processedAt: null }, true);

    const transitions = await Promise.all([
      recordInboundFailure(fake.db, 'evt-3', 'worker A', 5),
      recordInboundFailure(fake.db, 'evt-3', 'worker B', 5),
    ]);

    expect(transitions.filter(Boolean)).toHaveLength(1);
    expect(fake.state.processedAt).toBe(Date.now());
    expect(JSON.parse(fake.state.error)).toMatchObject({ attempts: 5 });
  });

  it('leaves a newly received row retryable when inbound processing throws', async () => {
    const database = {} as D1Database;
    vi.spyOn(db, 'tryInsertInbound').mockResolvedValue(true);
    vi.spyOn(db, 'getUser').mockRejectedValue(new Error('temporary outage'));
    const recordFailure = vi.spyOn(db, 'recordInboundFailure').mockResolvedValue(false);
    const markProcessed = vi.spyOn(db, 'markInboundProcessed').mockResolvedValue();
    const inbound = {
      kind: 'text' as const,
      dedupeId: 'evt-4',
      from: configuredUser.contact,
      text: 'help',
      messageId: null,
    };

    await expect(processInbound({ DB: database } as AppEnv, inbound)).rejects.toThrow('temporary outage');

    expect(recordFailure).toHaveBeenCalledWith(database, 'evt-4', 'temporary outage', 5);
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('records sweep exceptions without terminally processing retriable rows', async () => {
    const database = {} as D1Database;
    vi.spyOn(db, 'setSetting').mockResolvedValue();
    vi.spyOn(db, 'getUser').mockResolvedValue({ id: 1, ...configuredUser });
    vi.spyOn(db, 'ensureSession').mockResolvedValue({
      local_date: '2026-07-28',
      plan_state: 'confirmed',
      prompted_at_utc: null,
      nudges_sent: 0,
      recap_sent_at_utc: null,
      weekly_sent: 0,
    });
    vi.spyOn(db, 'unprocessedInbound').mockResolvedValue([{ dedupe_id: 'evt-5', raw: 'not-json' }]);
    vi.spyOn(db, 'failedOutbound').mockResolvedValue([]);
    const recordFailure = vi.spyOn(db, 'recordInboundFailure').mockResolvedValue(false);
    const markProcessed = vi.spyOn(db, 'markInboundProcessed').mockResolvedValue();

    await tick({ DB: database } as AppEnv, Date.UTC(2026, 6, 28, 9, 0));

    expect(recordFailure).toHaveBeenCalledWith(database, 'evt-5', expect.stringContaining('sweep:'), 5);
    expect(markProcessed).not.toHaveBeenCalled();
  });
});

describe('owner profile synchronization', () => {
  it('updates every configured singleton-user field on conflict', async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const bind = vi.fn().mockReturnValue({ run });
    const prepare = vi.fn().mockReturnValue({ bind });
    const fakeDb = { prepare } as unknown as D1Database;

    await upsertUser(fakeDb, configuredUser);

    const sql = String(prepare.mock.calls[0]?.[0]);
    for (const field of Object.keys(configuredUser)) {
      expect(sql).toContain(`${field} = excluded.${field}`);
    }
  });

  it('reconciles an existing profile from environment configuration during setup', async () => {
    const staleUser: UserRow = {
      id: 1,
      contact: '+15550000000',
      timezone: 'UTC',
      morning_time: '09:00',
      evening_time: '19:00',
      work_start: '10:00',
      work_end: '16:00',
      quiet_start: '21:00',
      quiet_end: '08:00',
      nag_level: 'gentle',
      pulse_every_min: 240,
    };
    const database = {} as D1Database;
    vi.spyOn(db, 'setSetting').mockResolvedValue();
    vi.spyOn(db, 'getUser')
      .mockResolvedValueOnce(staleUser)
      .mockResolvedValueOnce({ id: 1, ...configuredUser });
    const upsert = vi.spyOn(db, 'upsertUser').mockResolvedValue();
    const env = {
      DB: database,
      OWNER_CONTACT: configuredUser.contact,
      TIMEZONE: configuredUser.timezone,
      MORNING_TIME: configuredUser.morning_time,
      EVENING_TIME: configuredUser.evening_time,
      WORK_START: configuredUser.work_start,
      WORK_END: configuredUser.work_end,
      QUIET_START: configuredUser.quiet_start,
      QUIET_END: configuredUser.quiet_end,
      NAG_LEVEL: configuredUser.nag_level,
      PULSE_EVERY_MIN: String(configuredUser.pulse_every_min),
    } as AppEnv;

    const html = await runSetup(env, new URL('https://donna.example/setup'));

    expect(upsert).toHaveBeenCalledWith(database, configuredUser);
    expect(db.getUser).toHaveBeenCalledTimes(2);
    expect(html).toContain('tz America/New_York');
  });
});
