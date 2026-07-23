// Minimal Trello REST client (key+token auth) plus board-webhook action
// parsing. Trello is optional: every function no-ops to null when the three
// TRELLO_* secrets are absent, and the engine runs standalone.

import type { AppEnv } from './env';

const BASE = 'https://api.trello.com/1';

export function trelloConfigured(env: AppEnv): boolean {
  return Boolean(env.TRELLO_KEY && env.TRELLO_TOKEN && env.TRELLO_BOARD_ID);
}

async function api<T>(
  env: AppEnv,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  params?: Record<string, string>,
): Promise<T | null> {
  if (!env.TRELLO_KEY || !env.TRELLO_TOKEN) return null;
  const url = new URL(BASE + path);
  url.searchParams.set('key', env.TRELLO_KEY);
  url.searchParams.set('token', env.TRELLO_TOKEN);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { method });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    console.error(JSON.stringify({ evt: 'trello_api_error', method, path, status: res.status, detail }));
    return null;
  }
  return (await res.json()) as T;
}

export interface TrelloList {
  id: string;
  name: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  due: string | null;
  idList: string;
  closed: boolean;
}

export async function getMemberName(env: AppEnv): Promise<string | null> {
  const me = await api<{ fullName?: string; username?: string }>(env, 'GET', '/members/me', { fields: 'fullName,username' });
  return me?.fullName ?? me?.username ?? null;
}

export async function getBoardName(env: AppEnv): Promise<string | null> {
  if (!env.TRELLO_BOARD_ID) return null;
  const b = await api<{ name?: string }>(env, 'GET', `/boards/${env.TRELLO_BOARD_ID}`, { fields: 'name' });
  return b?.name ?? null;
}

export async function getLists(env: AppEnv): Promise<TrelloList[] | null> {
  if (!env.TRELLO_BOARD_ID) return null;
  return api<TrelloList[]>(env, 'GET', `/boards/${env.TRELLO_BOARD_ID}/lists`, { fields: 'name' });
}

export async function getCards(env: AppEnv, listId: string): Promise<TrelloCard[] | null> {
  return api<TrelloCard[]>(env, 'GET', `/lists/${listId}/cards`, { fields: 'name,due,idList,closed' });
}

export async function createCard(env: AppEnv, listId: string, name: string, dueIso?: string): Promise<{ id: string } | null> {
  const params: Record<string, string> = { idList: listId, name };
  if (dueIso) params.due = dueIso;
  return api<{ id: string }>(env, 'POST', '/cards', params);
}

export async function moveCardToList(env: AppEnv, cardId: string, listId: string, dueComplete?: boolean): Promise<boolean> {
  const params: Record<string, string> = { idList: listId };
  if (dueComplete !== undefined) params.dueComplete = String(dueComplete);
  return (await api<unknown>(env, 'PUT', `/cards/${cardId}`, params)) !== null;
}

export async function archiveCard(env: AppEnv, cardId: string): Promise<boolean> {
  return (await api<unknown>(env, 'PUT', `/cards/${cardId}`, { closed: 'true' })) !== null;
}

export async function registerWebhook(env: AppEnv, callbackURL: string): Promise<'created' | 'exists' | 'failed'> {
  if (!env.TRELLO_TOKEN || !env.TRELLO_BOARD_ID) return 'failed';
  const existing = await api<Array<{ callbackURL: string; idModel: string }>>(
    env,
    'GET',
    `/tokens/${env.TRELLO_TOKEN}/webhooks`,
  );
  if (existing?.some((w) => w.callbackURL === callbackURL && w.idModel === env.TRELLO_BOARD_ID)) return 'exists';
  const created = await api<{ id: string }>(env, 'POST', '/webhooks/', {
    callbackURL,
    idModel: env.TRELLO_BOARD_ID,
    description: 'accountability-bot',
  });
  return created ? 'created' : 'failed';
}

// -- webhook action parsing -------------------------------------------------

export type TrelloAction =
  | { t: 'created'; cardId: string; name: string; due: string | null; listId: string | null }
  | { t: 'moved'; cardId: string; toListId: string; name: string }
  | { t: 'renamed'; cardId: string; name: string }
  | { t: 'archived'; cardId: string }
  | null;

export function parseTrelloAction(body: unknown): TrelloAction {
  if (!body || typeof body !== 'object') return null;
  const action = (body as Record<string, unknown>).action;
  if (!action || typeof action !== 'object') return null;
  const a = action as Record<string, unknown>;
  const type = typeof a.type === 'string' ? a.type : '';
  const data = (a.data ?? {}) as Record<string, unknown>;
  const card = (data.card ?? {}) as Record<string, unknown>;
  const cardId = typeof card.id === 'string' ? card.id : null;
  if (!cardId) return null;
  const cardName = typeof card.name === 'string' ? card.name : '';

  if (type === 'createCard') {
    const list = (data.list ?? null) as Record<string, unknown> | null;
    return {
      t: 'created',
      cardId,
      name: cardName,
      due: typeof card.due === 'string' ? card.due : null,
      listId: list && typeof list.id === 'string' ? list.id : null,
    };
  }
  if (type === 'updateCard') {
    const listAfter = (data.listAfter ?? null) as Record<string, unknown> | null;
    if (listAfter && typeof listAfter.id === 'string') {
      return { t: 'moved', cardId, toListId: listAfter.id, name: cardName };
    }
    const old = (data.old ?? {}) as Record<string, unknown>;
    if (typeof old.name === 'string' && cardName) {
      return { t: 'renamed', cardId, name: cardName };
    }
    if (card.closed === true || (data as { card?: { closed?: boolean } }).card?.closed === true) {
      return { t: 'archived', cardId };
    }
  }
  return null;
}
