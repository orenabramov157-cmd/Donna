import { describe, expect, it } from 'vitest';
import { digestTimesMin } from '../src/engine/core';
import { gmailConfigured } from '../src/gmail';
import type { AppEnv } from '../src/env';

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return { GMAIL_DIGEST_TIMES: '', ...overrides } as AppEnv;
}

describe('digestTimesMin', () => {
  it('parses a single time', () => {
    expect(digestTimesMin(env({ GMAIL_DIGEST_TIMES: '09:00' }))).toEqual([540]);
  });
  it('parses multiple comma-separated times, trimming whitespace', () => {
    expect(digestTimesMin(env({ GMAIL_DIGEST_TIMES: '09:00, 13:30 ,18:00' }))).toEqual([540, 810, 1080]);
  });
  it('empty var means no scheduled slots', () => {
    expect(digestTimesMin(env())).toEqual([]);
  });
  it('drops malformed entries instead of throwing', () => {
    expect(digestTimesMin(env({ GMAIL_DIGEST_TIMES: '09:00,garbage,25:99,14:15' }))).toEqual([540, 855]);
  });
});

describe('gmailConfigured', () => {
  it('false when any of the three secrets is missing', () => {
    expect(gmailConfigured(env())).toBe(false);
    expect(gmailConfigured(env({ GMAIL_CLIENT_ID: 'a' }))).toBe(false);
    expect(gmailConfigured(env({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b' }))).toBe(false);
  });
  it('true only when all three secrets are present', () => {
    expect(
      gmailConfigured(env({ GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' })),
    ).toBe(true);
  });
});
