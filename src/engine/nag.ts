// Nag cadence + pulse policy. Pure functions over timestamps so they are
// unit-testable without a runtime.

import { inWindow, type LocalParts } from '../time';
import type { UserRow } from '../db';

export interface NagPolicy {
  intervalMin: number;
  // Total nags per task per day including the first. null = until answered.
  maxPerTask: number | null;
}

export function nagPolicy(level: string): NagPolicy {
  switch (level) {
    case 'gentle':
      return { intervalMin: 60, maxPerTask: 2 };
    case 'relentless':
      return { intervalMin: 20, maxPerTask: null };
    default:
      return { intervalMin: 45, maxPerTask: 5 };
  }
}

export function shouldRenag(policy: NagPolicy, nagsSentToday: number, lastNagAtUtc: number | null, nowUtc: number): boolean {
  if (nagsSentToday === 0) return true;
  if (policy.maxPerTask !== null && nagsSentToday >= policy.maxPerTask) return false;
  if (lastNagAtUtc === null) return true;
  return nowUtc - lastNagAtUtc >= policy.intervalMin * 60_000;
}

export function inQuietHours(user: UserRow, parts: LocalParts): boolean {
  return inWindow(parts.minOfDay, user.quiet_start, user.quiet_end);
}

export function inWorkHours(user: UserRow, parts: LocalParts): boolean {
  return inWindow(parts.minOfDay, user.work_start, user.work_end);
}

export interface PulseInputs {
  parts: LocalParts;
  nowUtc: number;
  lastPulseAtUtc: number | null;
  lastExchangeAtUtc: number | null;
  openCount: number;
}

// Pulse check-ins only exist at standard/relentless, only during work hours,
// only when there is something open, and never mid-conversation.
export function shouldPulse(user: UserRow, i: PulseInputs): boolean {
  if (user.nag_level === 'gentle') return false;
  if (i.openCount === 0) return false;
  if (!inWorkHours(user, i.parts)) return false;
  if (inQuietHours(user, i.parts)) return false;
  const interval = Math.max(30, user.pulse_every_min) * 60_000;
  if (i.lastPulseAtUtc !== null && i.nowUtc - i.lastPulseAtUtc < interval) return false;
  if (i.lastExchangeAtUtc !== null && i.nowUtc - i.lastExchangeAtUtc < 30 * 60_000) return false;
  return true;
}
