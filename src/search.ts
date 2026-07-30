// Minimal Tavily web-search client. Optional: every function no-ops to null
// when TAVILY_API_KEY is absent, and the brain falls back to being honest
// about not having search rather than guessing (see brain.ts's capability
// rule). This is Donna's only source of real-world/current information —
// the model itself has no browsing.

import type { AppEnv } from './env';

const SEARCH_URL = 'https://api.tavily.com/search';

export function searchConfigured(env: AppEnv): boolean {
  return Boolean(env.TAVILY_API_KEY);
}

export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchResponse {
  answer: string | null;
  results: WebSearchResult[];
}

export async function webSearch(env: AppEnv, query: string, maxResults = 5): Promise<WebSearchResponse | null> {
  if (!env.TAVILY_API_KEY) return null;
  // Without a timeout, a slow/hanging upstream response blocks the whole
  // inbound message indefinitely (no error to catch, nothing to retry into —
  // it just sits claimed forever). 12s is generous for a search API but
  // still leaves headroom for the two AI calls in the same request.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        max_results: Math.max(1, Math.min(maxResults, 10)),
        include_answer: 'basic',
        search_depth: 'basic',
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: 'tavily_search_error',
        aborted: err instanceof Error && err.name === 'AbortError',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(JSON.stringify({ evt: 'tavily_search_failed', status: res.status, detail }));
    return null;
  }
  const data = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return {
    answer: data.answer ?? null,
    results: (data.results ?? []).map((r) => ({
      title: (r.title ?? '').slice(0, 200),
      url: r.url ?? '',
      content: (r.content ?? '').slice(0, 500),
    })),
  };
}
