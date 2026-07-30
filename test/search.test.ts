import { describe, expect, it } from 'vitest';
import { searchConfigured } from '../src/search';
import type { AppEnv } from '../src/env';

function env(overrides: Partial<AppEnv> = {}): AppEnv {
  return { ...overrides } as AppEnv;
}

describe('searchConfigured', () => {
  it('false when TAVILY_API_KEY is absent', () => {
    expect(searchConfigured(env())).toBe(false);
  });
  it('true when TAVILY_API_KEY is present', () => {
    expect(searchConfigured(env({ TAVILY_API_KEY: 'tvly-abc123' }))).toBe(true);
  });
});
