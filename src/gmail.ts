// Minimal Gmail REST client (OAuth refresh-token auth), read-only by design.
// Gmail is optional: every function no-ops to null/[] when the three
// GMAIL_* secrets are absent, and the engine runs standalone. No send/modify
// scope is used anywhere in this file — digest reads only.

import type { AppEnv } from './env';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const FETCH_TIMEOUT_MS = 8_000;

export function gmailConfigured(env: AppEnv): boolean {
  return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

// Every Gmail/Google call goes through this — without a timeout, one slow
// upstream response hangs the whole inbound message indefinitely (this bit
// us live: a "check email" reply took 5m07s because a hung fetch only
// resolved once the cron sweep's retry happened to land after it cleared).
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    console.error(
      JSON.stringify({
        evt: 'gmail_fetch_error',
        url,
        aborted: err instanceof Error && err.name === 'AbortError',
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Access tokens are short-lived (~1h); refreshed on every digest rather than
// cached, since digests run at most a handful of times a day.
async function getAccessToken(env: AppEnv): Promise<string | null> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return null;
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res) return null;
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(JSON.stringify({ evt: 'gmail_token_refresh_failed', status: res.status, detail }));
    return null;
  }
  const data = (await res.json()) as { access_token?: string };
  return data.access_token ?? null;
}

export interface GmailMessage {
  from: string;
  subject: string;
  snippet: string;
}

function headerValue(headers: Array<{ name?: string; value?: string }>, name: string): string {
  return headers.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? '';
}

// Messages received in the last `sinceHours`, newest first, capped at
// `limit`. Metadata only (From/Subject/snippet) — bodies are never fetched,
// keeping this strictly read-summary, not full mail access. Default limit
// kept small (not Gmail's max) so a "check email" reply stays fast: fewer
// parallel API round trips and a shorter summarization prompt.
export async function listRecentMessages(env: AppEnv, sinceHours: number, limit = 8): Promise<GmailMessage[] | null> {
  const token = await getAccessToken(env);
  if (!token) return null;
  const auth = { Authorization: `Bearer ${token}` };
  const q = encodeURIComponent(`newer_than:${Math.max(1, Math.round(sinceHours))}h`);
  const listRes = await fetchWithTimeout(`${API_BASE}/messages?q=${q}&maxResults=${limit}`, { headers: auth });
  if (!listRes) return null;
  if (!listRes.ok) {
    console.error(JSON.stringify({ evt: 'gmail_list_failed', status: listRes.status }));
    return null;
  }
  const listData = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const ids = (listData.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return [];

  const messages = await Promise.all(
    ids.map(async (id) => {
      const res = await fetchWithTimeout(
        `${API_BASE}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
        { headers: auth },
      );
      if (!res || !res.ok) return null;
      const data = (await res.json()) as { snippet?: string; payload?: { headers?: Array<{ name?: string; value?: string }> } };
      const headers = data.payload?.headers ?? [];
      return {
        from: headerValue(headers, 'From').slice(0, 120),
        subject: headerValue(headers, 'Subject').slice(0, 200) || '(no subject)',
        snippet: (data.snippet ?? '').slice(0, 200),
      };
    }),
  );
  return messages.filter((m): m is GmailMessage => m !== null);
}
