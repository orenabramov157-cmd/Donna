import type { AppEnv } from '../env';

// Everything the engine knows about messaging. Swapping iMessage for SMS is
// implementing this interface and flipping the CHANNEL var — the engine and
// database never change.

export type Inbound =
  | { kind: 'text'; from: string; text: string; dedupeId: string; messageId: string | null }
  | { kind: 'reaction'; from: string; reaction: string; refMessageId: string | null; dedupeId: string }
  | {
      kind: 'status';
      status: 'delivered' | 'failed';
      refMessageId: string | null;
      passthrough: string | null;
      dedupeId: string;
    }
  | { kind: 'ignored'; reason: string; dedupeId: string };

export interface SendOpts {
  passthrough?: string;
  replyToId?: string;
}

export interface Channel {
  name: string;
  send(env: AppEnv, to: string, text: string, opts?: SendOpts): Promise<{ messageId: string | null } | null>;
  // null => authentication failed (caller responds 401). 'ignored' inbound
  // events are recorded for the dedupe log but produce no action.
  parseWebhook(request: Request, env: AppEnv): Promise<Inbound | null>;
}

export async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Length is not secret here; compare b against itself to keep timing flat.
  if (ab.byteLength !== bb.byteLength) {
    crypto.subtle.timingSafeEqual(bb, bb);
    return false;
  }
  return crypto.subtle.timingSafeEqual(ab, bb);
}
