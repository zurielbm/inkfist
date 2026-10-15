// WebSocket relay transport (server/: Lobby + Room Durable Objects). Same surface as PeerLink.
import { NetChannel } from './rollback';
import { randomCode } from './peer';

export class RelayLink implements NetChannel {
  onMessage: ((msg: any) => void) | null = null;
  onClose: (() => void) | null = null;
  closed = false;
  private listeners = new Set<(msg: any) => void>();

  constructor(public ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '');
      } catch {
        return;
      }
      if (msg?.t === 'bye') this.handleClose();
      this.onMessage?.(msg);
      for (const l of this.listeners) l(msg);
    });
    ws.addEventListener('close', () => this.handleClose());
    ws.addEventListener('error', () => this.handleClose());
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  listen(fn: (msg: any) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg: unknown): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  waitFor(type: string, timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      const off = this.listen((m) => {
        if (m && m.t === type) {
          off();
          clearTimeout(timer);
          resolve(m);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  /** Wait for the first of several message types. */
  waitAny(types: string[], timeoutMs: number): Promise<any | null> {
    return new Promise((resolve) => {
      const off = this.listen((m) => {
        if (m && types.includes(m.t)) {
          off();
          clearTimeout(timer);
          resolve(m);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }
}

function connect(url: string, timeoutMs = 8000): Promise<RelayLink> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const link = new RelayLink(ws);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('relay-timeout'));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(link);
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('relay-unreachable'));
    });
  });
}

const wsBase = (base: string) => base.replace(/^http/, 'ws').replace(/\/$/, '');

export async function relayHostRoom(base: string, onCode: (code: string) => void, signal: AbortSignal): Promise<{ link: RelayLink; host: boolean } | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    const link = await connect(`${wsBase(base)}/room/${code}?role=host`);
    const first = await link.waitAny(['open', 'taken', 'busy'], 6000);
    if (first?.t !== 'open') {
      link.close();
      continue;
    }
    onCode(code);
    const paired = await new Promise<boolean>((resolve) => {
      const off = link.listen((m) => { if (m?.t === 'paired') { off(); resolve(true); } });
      signal.addEventListener('abort', () => { off(); resolve(false); });
      link.onClose = () => resolve(false);
    });
    if (!paired || signal.aborted) {
      link.close();
      return null;
    }
    link.send({ t: 'accept' });
    return { link, host: true };
  }
  throw new Error('no-room');
}

export async function relayJoinRoom(base: string, code: string): Promise<{ link: RelayLink; host: boolean }> {
  const link = await connect(`${wsBase(base)}/room/${code.toUpperCase().trim()}?role=guest`);
  const r = await link.waitAny(['accept', 'not-found', 'busy'], 8000);
  if (r?.t !== 'accept') {
    link.close();
    throw new Error(r?.t === 'busy' ? 'room-busy' : 'room-not-found');
  }
  return { link, host: false };
}

export async function relayQuickMatch(base: string, onStatus: (s: string) => void, signal: AbortSignal): Promise<{ link: RelayLink; host: boolean } | null> {
  onStatus('Joining the queue…');
  const lobby = await connect(`${wsBase(base)}/lobby`);
  onStatus('Waiting for a challenger…');
  const match = await new Promise<any | null>((resolve) => {
    const off = lobby.listen((m) => { if (m?.t === 'match') { off(); resolve(m); } });
    signal.addEventListener('abort', () => { off(); resolve(null); });
  });
  lobby.close();
  if (!match || signal.aborted) return null;
  onStatus('Opponent found! Bowing…');
  const link = await connect(`${wsBase(base)}/room/${match.room}?role=peer`);
  const ok = await link.waitFor('paired', 10000);
  if (!ok) {
    link.close();
    throw new Error('pair-timeout');
  }
  return { link, host: !!match.host };
}
