// Small shared helpers for the INKFIST server.
import type { Arena } from './arena';
import type { Bout } from './bout';
import type { Judge } from './judge';
import type { Lobby, Room } from './index';

export interface Env {
  LOBBY: DurableObjectNamespace<Lobby>;
  ROOM: DurableObjectNamespace<Room>;
  ARENA: DurableObjectNamespace<Arena>;
  BOUT: DurableObjectNamespace<Bout>;
  JUDGE: DurableObjectNamespace<Judge>;
  /** where the game is hosted (watch links) */
  GAME_URL: string;
  /** this server's public URL once deployed; other origins get ?arena=<origin> in watch links */
  PUBLIC_API?: string;
  /** header carrying the client address (rate limits); self-hosted behind Traefik/nginx use x-real-ip */
  IP_HEADER?: string;
}

/** The address agents should call. Behind a reverse proxy the request URL is the internal one, so PUBLIC_API wins. */
export function publicOrigin(env: Env, url: URL): string {
  return env.PUBLIC_API ? env.PUBLIC_API.replace(/\/$/, '') : url.origin;
}

export function clientIp(env: Env, req: Request): string {
  return req.headers.get(env.IP_HEADER || 'cf-connecting-ip')?.split(',')[0].trim() || 'local';
}

export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '86400',
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra },
  });
}

/** Errors crossing a Durable Object RPC boundary keep only their message, so failures travel as plain values. */
export interface Fail {
  error: { status: number; code: string; message: string };
}
export function fail(status: number, code: string, message: string): Fail {
  return { error: { status, code, message } };
}
export function isFail(x: unknown): x is Fail {
  return !!x && typeof x === 'object' && 'error' in x && !!(x as Fail).error?.code;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Unwrap a DO result, turning a Fail into a thrown ApiError. */
export function ok<T>(x: T): Exclude<T, Fail> {
  if (isFail(x)) throw new ApiError(x.error.status, x.error.code, x.error.message);
  return x as Exclude<T, Fail>;
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export function randomId(prefix: string, n = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = prefix;
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export function randomCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  let s = '';
  for (const b of bytes) s += A[b % A.length];
  return s;
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Display-safe single-line text. */
export function cleanText(v: unknown, max: number): string {
  return String(v ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069<>`"\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const BOUT_ID = /^b_[a-z2-9]{10}$/;
export const RESULT_ID = /^r_[a-z2-9]{10}$/;
export const ENTRANT_ID = /^e_[a-z2-9]{10}$/;

export function watchUrl(env: Env, origin: string, id: string): string {
  const base = env.GAME_URL || 'https://pages.subir.dev/inkfist/';
  const q = env.PUBLIC_API && env.PUBLIC_API.replace(/\/$/, '') === origin ? '' : `?arena=${encodeURIComponent(origin)}`;
  return `${base}${q}#watch=${id}`;
}
