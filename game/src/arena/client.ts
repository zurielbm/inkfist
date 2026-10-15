// Browser side of the arena: server address, the player's arena account, leaderboards and ranked result submission.
import { ARENA_URL } from '../config';
import { HumanClaim } from './replay';

const ACCOUNT_KEY = 'inkfist.arena';
const BASE_KEY = 'inkfist.arenaBase';

/** Arena server base URL: ?arena=<url> (remembered for this tab) or the configured ARENA_URL. '' = arena disabled. */
export function arenaBase(): string {
  try {
    const q = new URLSearchParams(location.search).get('arena');
    if (q) {
      sessionStorage.setItem(BASE_KEY, q);
      return q.replace(/\/+$/, '');
    }
    const s = sessionStorage.getItem(BASE_KEY);
    if (s) return s.replace(/\/+$/, '');
  } catch {
    /* ignore */
  }
  return ARENA_URL.replace(/\/+$/, '');
}

export function arenaEnabled(): boolean {
  return !!arenaBase();
}

/** Where agents should read the manual. */
export function manualUrl(gameUrl: string): string {
  const base = arenaBase();
  return base && base !== ARENA_URL.replace(/\/+$/, '') ? `${base}/agents.md` : `${gameUrl}agents.md`;
}

export class ArenaError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(path: string, opts: { body?: unknown; token?: string; timeout?: number } = {}): Promise<T> {
  const base = arenaBase();
  if (!base) throw new ArenaError(0, 'disabled', 'The arena server is not configured.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 10000);
  try {
    const res = await fetch(base + path, {
      method: opts.body !== undefined ? 'POST' : 'GET',
      headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
    if (!res.ok || data.error) throw new ArenaError(res.status, data.error ?? 'http', data.message ?? `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e instanceof ArenaError) throw e;
    throw new ArenaError(0, 'network', 'Could not reach the arena server.');
  } finally {
    clearTimeout(timer);
  }
}

export function arenaGet<T>(path: string, timeout?: number): Promise<T> {
  return call<T>(path, { timeout });
}

// ---------------------------------------------------------------- account
interface Account {
  base: string;
  id: string;
  token: string;
  name: string;
}

function loadAccount(): Account | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    const list: Account[] = raw ? JSON.parse(raw) : [];
    return (Array.isArray(list) ? list : []).find((a) => a.base === arenaBase()) ?? null;
  } catch {
    return null;
  }
}

function saveAccount(a: Account): void {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    const list: Account[] = (raw ? JSON.parse(raw) : []).filter((x: Account) => x.base !== a.base);
    list.push(a);
    localStorage.setItem(ACCOUNT_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

let pending: Promise<Account> | null = null;

/** The player's arena entrant (registered on first use, renamed when the player changes their name). */
export function ensureAccount(name: string): Promise<Account> {
  if (pending) return pending;
  pending = (async () => {
    const have = loadAccount();
    if (have && have.name === name) return have;
    if (have) {
      try {
        await call('/api/register', { body: { name, human: true }, token: have.token });
        const a = { ...have, name };
        saveAccount(a);
        return a;
      } catch (e) {
        if (!(e instanceof ArenaError) || e.status !== 401) return have;
      }
    }
    const r = await call<{ id: string; token: string }>('/api/register', { body: { name, human: true } });
    const a = { base: arenaBase(), id: r.id, token: r.token, name };
    saveAccount(a);
    return a;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export function arenaId(): string | null {
  return arenaEnabled() ? loadAccount()?.id ?? null : null;
}

// ---------------------------------------------------------------- results
export interface RatingChange {
  board: string;
  before: number;
  after: number;
  delta: number;
  wins: number;
  losses: number;
}

export interface ResultStatus {
  id: string;
  status: 'verifying' | 'pending_opponent' | 'verified' | 'rejected';
  reason?: string | null;
  rating?: RatingChange | null;
  replay?: string | null;
}

/** Submit a finished human match and follow its verification. `onUpdate` sees every status change. */
export async function submitRanked(name: string, claim: HumanClaim, onUpdate: (s: ResultStatus) => void): Promise<void> {
  const acc = await ensureAccount(name);
  let st = await call<ResultStatus>('/api/results', { body: claim, token: acc.token, timeout: 15000 });
  onUpdate(st);
  const t0 = Date.now();
  const limit = claim.kind === 'pvp' ? 90_000 : 60_000;
  while ((st.status === 'verifying' || st.status === 'pending_opponent') && Date.now() - t0 < limit) {
    await new Promise((r) => setTimeout(r, st.status === 'pending_opponent' ? 2500 : 1200));
    const next = await call<ResultStatus>(`/api/results/${st.id}`, { token: acc.token });
    if (next.status !== st.status) onUpdate(next);
    st = next;
  }
}

// ---------------------------------------------------------------- public data
export interface BoardEntry {
  rank: number;
  id: string;
  kind: string;
  name: string;
  agent: string | null;
  label: string;
  rating: number;
  wins: number;
  losses: number;
  bestStreak: number;
  topWins: number;
}

export interface BoutListItem {
  id: string;
  board: string;
  mode: string;
  status: string;
  labels: [string | null, string | null];
  fighters: [string | null, string | null];
  winner: number | null;
  endedBy: string | null;
  updated: number;
}

export function leaderboard(board: string): Promise<{ entries: BoardEntry[] }> {
  return call(`/api/leaderboard?board=${board}&limit=50`);
}

export function bouts(status: 'live' | 'recent' | 'open'): Promise<{ bouts: BoutListItem[] }> {
  return call(`/api/bouts?status=${status}&limit=12`);
}

export interface DuelState {
  code: string;
  status: 'empty' | 'waiting' | 'live' | 'done';
  bout: string | null;
  labels: (string | null)[];
  fighters: (string | null)[];
  winner: number | null;
}

export function duelState(code: string): Promise<DuelState> {
  return call(`/api/duels/${code}`);
}
