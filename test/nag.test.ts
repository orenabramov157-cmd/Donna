import { describe, expect, it } from 'vitest';
import { nagPolicy, shouldPulse, shouldRenag } from '../src/engine/nag';
import { localParts } from '../src/time';
import type { UserRow } from '../src/db';

const user: UserRow = {
  id: 1,
  contact: '+13105551234',
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

// 2026-07-23 13:00 PDT (work hours, not quiet)
const NOW = Date.UTC(2026, 6, 23, 20, 0);
const parts = localParts(NOW, user.timezone);

describe('nagPolicy', () => {
  it('gentle: 60min, max 2', () => expect(nagPolicy('gentle')).toEqual({ intervalMin: 60, maxPerTask: 2 }));
  it('standard: 45min, max 5', () => expect(nagPolicy('standard')).toEqual({ intervalMin: 45, maxPerTask: 5 }));
  it('relentless: 20min, unlimited', () => expect(nagPolicy('relentless')).toEqual({ intervalMin: 20, maxPerTask: null }));
});

describe('shouldRenag', () => {
  const std = nagPolicy('standard');
  it('first nag always fires', () => expect(shouldRenag(std, 0, null, NOW)).toBe(true));
  it('respects the interval', () => expect(shouldRenag(std, 1, NOW - 10 * 60_000, NOW)).toBe(false));
  it('fires after the interval', () => expect(shouldRenag(std, 1, NOW - 46 * 60_000, NOW)).toBe(true));
  it('caps at maxPerTask', () => expect(shouldRenag(std, 5, NOW - 2 * 3_600_000, NOW)).toBe(false));
  it('relentless never caps', () =>
    expect(shouldRenag(nagPolicy('relentless'), 12, NOW - 21 * 60_000, NOW)).toBe(true));
});

describe('shouldPulse', () => {
  const base = { parts, nowUtc: NOW, lastPulseAtUtc: null, lastExchangeAtUtc: null, openCount: 3 };
  it('fires in work hours with open tasks and no recent activity', () => {
    expect(shouldPulse(user, base)).toBe(true);
  });
  it('never on gentle', () => expect(shouldPulse({ ...user, nag_level: 'gentle' }, base)).toBe(false));
  it('not with zero open tasks', () => expect(shouldPulse(user, { ...base, openCount: 0 })).toBe(false));
  it('not outside work hours', () => {
    const evening = localParts(Date.UTC(2026, 6, 24, 4, 0), user.timezone); // 21:00 PDT
    expect(shouldPulse(user, { ...base, parts: evening })).toBe(false);
  });
  it('not right after a recent exchange', () => {
    expect(shouldPulse(user, { ...base, lastExchangeAtUtc: NOW - 10 * 60_000 })).toBe(false);
  });
  it('not before the pulse interval elapses', () => {
    expect(shouldPulse(user, { ...base, lastPulseAtUtc: NOW - 60 * 60_000 })).toBe(false);
  });
});
