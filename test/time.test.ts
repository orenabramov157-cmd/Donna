import { describe, expect, it } from 'vitest';
import {
  addDaysLocal,
  extractTrailingTime,
  inWindow,
  localParts,
  parseTimeToken,
  utcForLocalDateTime,
} from '../src/time';

const LA = 'America/Los_Angeles';

describe('localParts', () => {
  it('renders a known instant in LA', () => {
    // 2026-07-23 17:00 UTC = 10:00 PDT
    const p = localParts(Date.UTC(2026, 6, 23, 17, 0), LA);
    expect(p.localDate).toBe('2026-07-23');
    expect(p.hhmm).toBe('10:00');
    expect(p.weekday).toBe('Thu');
  });
});

describe('utcForLocalDateTime (DST)', () => {
  it('summer (PDT, UTC-7)', () => {
    const utc = utcForLocalDateTime(LA, '2026-07-23', '10:00');
    expect(utc).toBe(Date.UTC(2026, 6, 23, 17, 0));
  });
  it('winter (PST, UTC-8)', () => {
    const utc = utcForLocalDateTime(LA, '2026-01-15', '10:00');
    expect(utc).toBe(Date.UTC(2026, 0, 15, 18, 0));
  });
  it('day of spring-forward maps 10:00 correctly (2026-03-08)', () => {
    const utc = utcForLocalDateTime(LA, '2026-03-08', '10:00');
    expect(utc).toBe(Date.UTC(2026, 2, 8, 17, 0));
  });
  it('nonexistent 02:30 on spring-forward day resolves without looping', () => {
    const utc = utcForLocalDateTime(LA, '2026-03-08', '02:30');
    const p = localParts(utc, LA);
    expect([1, 3]).toContain(p.hh); // resolved to a real wall time
  });
  it('day of fall-back maps 10:00 correctly (2026-11-01)', () => {
    const utc = utcForLocalDateTime(LA, '2026-11-01', '10:00');
    expect(utc).toBe(Date.UTC(2026, 10, 1, 18, 0));
  });
});

describe('addDaysLocal', () => {
  it('crosses spring-forward without skipping a date', () => {
    expect(addDaysLocal(LA, '2026-03-07', 1)).toBe('2026-03-08');
    expect(addDaysLocal(LA, '2026-03-08', 1)).toBe('2026-03-09');
  });
});

describe('inWindow (overnight quiet hours)', () => {
  const start = '22:00';
  const end = '07:30';
  it('23:00 is quiet', () => expect(inWindow(23 * 60, start, end)).toBe(true));
  it('03:00 is quiet', () => expect(inWindow(3 * 60, start, end)).toBe(true));
  it('07:29 is quiet', () => expect(inWindow(7 * 60 + 29, start, end)).toBe(true));
  it('07:30 is not', () => expect(inWindow(7 * 60 + 30, start, end)).toBe(false));
  it('12:00 is not', () => expect(inWindow(12 * 60, start, end)).toBe(false));
});

describe('parseTimeToken', () => {
  it('10am', () => expect(parseTimeToken('10am')).toBe('10:00'));
  it('4:30pm', () => expect(parseTimeToken('4:30pm')).toBe('16:30'));
  it('12pm', () => expect(parseTimeToken('12pm')).toBe('12:00'));
  it('12am', () => expect(parseTimeToken('12am')).toBe('00:00'));
  it('16:00', () => expect(parseTimeToken('16:00')).toBe('16:00'));
  it('noon', () => expect(parseTimeToken('noon')).toBe('12:00'));
  it('junk', () => expect(parseTimeToken('whenever')).toBeNull());
});

describe('extractTrailingTime', () => {
  it('trailing am/pm time', () => {
    expect(extractTrailingTime('call vendor 10am')).toEqual({ title: 'call vendor', time: '10:00' });
  });
  it('with "at" and comma', () => {
    expect(extractTrailingTime('email the draft, at 4pm')).toEqual({ title: 'email the draft', time: '16:00' });
  });
  it('no time', () => {
    expect(extractTrailingTime('think about strategy')).toEqual({ title: 'think about strategy', time: null });
  });
});
