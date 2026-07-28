import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../src/env';
import type { UserRow } from '../src/db';
import * as db from '../src/db';
import { claimInbound, markInboundProcessed, recordInboundFailure, upsertUser } from '../src/db';
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

function leasedInboundDb(initialAttempts = 0) {
  const state = {
    attempts: initialAttempts,
    error: '',
    leaseToken: null as string | null,
    leaseUntil: 0,
    processedAt: null as number | null,
  };
  const prepare = vi.fn((sql: string) => {
    if (sql.includes('RETURNING dedupe_id')) {
      return {
        bind: vi.fn(
          (
            maxAttempts: number,
            terminalAt: number,
            repeatedMax: number,
            cappedMax: number,
            token: string,
            leaseUntil: number,
            _dedupeId: string,
            nowUtc: number,
          ) => ({
            first: async () => {
              expect(repeatedMax).toBe(maxAttempts);
              expect(cappedMax).toBe(maxAttempts);
              if (state.processedAt !== null || (state.leaseToken !== null && state.leaseUntil > nowUtc)) return null;
              if (state.attempts >= maxAttempts) {
                state.processedAt = terminalAt;
                state.leaseToken = null;
                state.leaseUntil = 0;
                return { dedupe_id: 'evt-lease', processed_at_utc: terminalAt, lease_token: null };
              }
              state.attempts = Math.min(state.attempts + 1, maxAttempts);
              state.leaseToken = token;
              state.leaseUntil = leaseUntil;
              return { dedupe_id: 'evt-lease', processed_at_utc: null, lease_token: token };
            },
          }),
        ),
      };
    }
    if (sql.includes('RETURNING processed_at_utc')) {
      return {
        bind: vi.fn(
          (
            maxAttempts: number,
            terminalAt: number,
            repeatedMax: number,
            error: string,
            _dedupeId: string,
            token: string | null,
            repeatedToken: string | null,
          ) => ({
            first: async () => {
              expect(repeatedMax).toBe(maxAttempts);
              expect(repeatedToken).toBe(token);
              if (state.processedAt !== null || state.leaseToken !== token) return null;
              if (token === null) state.attempts = Math.min(state.attempts + 1, maxAttempts);
              state.error = error;
              state.leaseToken = null;
              state.leaseUntil = 0;
              state.processedAt = state.attempts >= maxAttempts ? terminalAt : null;
              return { processed_at_utc: state.processedAt };
            },
          }),
        ),
      };
    }
    if (sql.includes("json_extract(error, '$.leaseToken') = ?")) {
      return {
        bind: vi.fn((processedAt: number, error: string | null, _dedupeId: string, token: string) => ({
          run: async () => {
            if (state.processedAt !== null || state.leaseToken !== token) return { meta: { changes: 0 } };
            state.processedAt = processedAt;
            state.error = error ?? '';
            state.leaseToken = null;
            state.leaseUntil = 0;
            return { meta: { changes: 1 } };
          },
        })),
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { db: { prepare } as unknown as D1Database, prepare, state };
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

  it('grants one active lease and permits reclaim only after it expires', async () => {
    const fake = leasedInboundDb();

    const overlapping = await Promise.all([
      claimInbound(fake.db, 'evt-lease', 'worker-A', 1_000, 100, 5),
      claimInbound(fake.db, 'evt-lease', 'worker-B', 1_000, 100, 5),
    ]);

    expect(overlapping.filter(Boolean)).toHaveLength(1);
    expect(await claimInbound(fake.db, 'evt-lease', 'worker-C', 1_099, 100, 5)).toBe(false);
    expect(await claimInbound(fake.db, 'evt-lease', 'worker-C', 1_100, 100, 5)).toBe(true);
    expect(fake.state).toMatchObject({ attempts: 2, leaseToken: 'worker-C', leaseUntil: 1_200, processedAt: null });
    const claimSql = String(fake.prepare.mock.calls[0]?.[0]);
    expect(claimSql).toContain('processed_at_utc IS NULL');
    expect(claimSql).toContain("json_extract(error, '$.leaseUntil')");
    expect(claimSql).toContain('<= ?');
    expect(claimSql).toContain('RETURNING dedupe_id');
  });

  it('allows only the current lease owner to mark a successful row processed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T18:00:00.000Z'));
    const fake = leasedInboundDb();
    await claimInbound(fake.db, 'evt-lease', 'worker-A', 1_000, 100, 5);
    await claimInbound(fake.db, 'evt-lease', 'worker-B', 1_100, 100, 5);

    await markInboundProcessed(fake.db, 'evt-lease', undefined, 'worker-A');
    expect(fake.state.processedAt).toBeNull();

    await markInboundProcessed(fake.db, 'evt-lease', undefined, 'worker-B');
    expect(fake.state.processedAt).toBe(Date.now());
  });

  it('releases failed leases for retry and terminalizes exactly the fifth claimed failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T18:00:00.000Z'));
    const fake = leasedInboundDb();
    const transitions: boolean[] = [];

    for (let attempt = 1; attempt <= 5; attempt++) {
      const token = `worker-${attempt}`;
      expect(await claimInbound(fake.db, 'evt-lease', token, attempt * 1_000, 100, 5)).toBe(true);
      transitions.push(await recordInboundFailure(fake.db, 'evt-lease', `failure ${attempt}`, 5, token));
    }

    expect(transitions).toEqual([false, false, false, false, true]);
    expect(fake.state).toMatchObject({
      attempts: 5,
      error: 'failure 5',
      leaseToken: null,
      processedAt: Date.now(),
    });
    expect(await claimInbound(fake.db, 'evt-lease', 'worker-6', 6_000, 100, 5)).toBe(false);
  });

  it('terminalizes an expired fifth lease without executing a sixth attempt', async () => {
    const fake = leasedInboundDb(4);

    expect(await claimInbound(fake.db, 'evt-lease', 'worker-5', 5_000, 100, 5)).toBe(true);
    expect(fake.state).toMatchObject({ attempts: 5, leaseToken: 'worker-5', processedAt: null });

    expect(await claimInbound(fake.db, 'evt-lease', 'worker-6', 5_100, 100, 5)).toBe(false);
    expect(fake.state).toMatchObject({ attempts: 5, leaseToken: null, processedAt: 5_100 });
  });

  it('leaves a newly received row retryable when inbound processing throws', async () => {
    const database = {} as D1Database;
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000004');
    vi.spyOn(db, 'tryInsertInbound').mockResolvedValue(true);
    const claim = vi.spyOn(db, 'claimInbound').mockResolvedValue(true);
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

    expect(claim).toHaveBeenCalledWith(
      database,
      'evt-4',
      '00000000-0000-4000-8000-000000000004',
      expect.any(Number),
      5 * 60_000,
      5,
    );
    expect(recordFailure).toHaveBeenCalledWith(
      database,
      'evt-4',
      'temporary outage',
      5,
      '00000000-0000-4000-8000-000000000004',
    );
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('records sweep exceptions without terminally processing retriable rows', async () => {
    const database = {} as D1Database;
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
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
    const claim = vi.spyOn(db, 'claimInbound').mockResolvedValue(true);
    const recordFailure = vi.spyOn(db, 'recordInboundFailure').mockResolvedValue(false);
    const markProcessed = vi.spyOn(db, 'markInboundProcessed').mockResolvedValue();

    await tick({ DB: database } as AppEnv, Date.UTC(2026, 6, 28, 9, 0));

    expect(claim).toHaveBeenCalledWith(
      database,
      'evt-5',
      '00000000-0000-4000-8000-000000000001',
      Date.UTC(2026, 6, 28, 9, 0),
      5 * 60_000,
      5,
    );
    expect(recordFailure).toHaveBeenCalledWith(
      database,
      'evt-5',
      expect.stringContaining('sweep:'),
      5,
      '00000000-0000-4000-8000-000000000001',
    );
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('does not execute or finalize a sweep row when another worker owns the lease', async () => {
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
    vi.spyOn(db, 'unprocessedInbound').mockResolvedValue([{ dedupe_id: 'evt-owned', raw: 'not-json' }]);
    vi.spyOn(db, 'failedOutbound').mockResolvedValue([]);
    const claim = vi.spyOn(db, 'claimInbound').mockResolvedValue(false);
    const recordFailure = vi.spyOn(db, 'recordInboundFailure').mockResolvedValue(false);
    const markProcessed = vi.spyOn(db, 'markInboundProcessed').mockResolvedValue();

    await tick({ DB: database } as AppEnv, Date.UTC(2026, 6, 28, 9, 0));

    expect(claim).toHaveBeenCalledOnce();
    expect(recordFailure).not.toHaveBeenCalled();
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
