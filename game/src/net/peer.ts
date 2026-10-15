// PeerJS transport: private rooms (5-letter codes) and a slot-based Quick Match queue on the public broker.
import Peer, { DataConnection } from 'peerjs';
import { ICE_SERVERS, PEER_NAMESPACE, QUICK_SLOTS } from '../config';
import { NetChannel } from './rollback';

const OPTS = { debug: 0, config: { iceServers: ICE_SERVERS } } as const;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';

export class PeerLink implements NetChannel {
  onMessage: ((msg: any) => void) | null = null;
  private listeners = new Set<(msg: any) => void>();
  onClose: (() => void) | null = null;
  closed = false;

  constructor(public conn: DataConnection, private owned: Peer[]) {
    conn.on('data', (d) => {
      const msg = d as any;
      this.onMessage?.(msg);
      for (const l of this.listeners) l(msg);
    });
    conn.on('close', () => this.handleClose());
    conn.on('error', () => this.handleClose());
    conn.peerConnection?.addEventListener('connectionstatechange', () => {
      const st = conn.peerConnection?.connectionState;
      if (st === 'failed' || st === 'closed') this.handleClose();
    });
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
    if (this.closed || !this.conn.open) return;
    try {
      this.conn.send(msg);
    } catch {
      /* ignore */
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.conn.close();
    } catch {
      /* ignore */
    }
    for (const p of this.owned) {
      try {
        p.destroy();
      } catch {
        /* ignore */
      }
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
}

export function randomCode(): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  return s;
}

/** Create a Peer; resolves null when the requested id is taken. Rejects on network/broker failure. */
function createPeer(id?: string): Promise<Peer | null> {
  return new Promise((resolve, reject) => {
    const p = id ? new Peer(id, OPTS) : new Peer(OPTS);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      p.destroy();
      reject(new Error('broker-timeout'));
    }, 12000);
    p.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(p);
    });
    p.once('error', (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      p.destroy();
      if (err?.type === 'unavailable-id') resolve(null);
      else reject(err);
    });
  });
}

/** Try to open a data connection to `target`; resolves null if it doesn't exist or times out. */
function tryConnect(me: Peer, target: string, timeoutMs: number): Promise<DataConnection | null> {
  return new Promise((resolve) => {
    const conn = me.connect(target, { reliable: false, serialization: 'json' });
    let done = false;
    const finish = (c: DataConnection | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      me.off('error', onErr);
      if (!c) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
      }
      resolve(c);
    };
    const onErr = (err: any) => {
      if (err?.type === 'peer-unavailable' && String(err.message || '').includes(target)) finish(null);
    };
    me.on('error', onErr);
    conn.once('open', () => finish(conn));
    conn.once('error', () => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

function waitForIncoming(host: Peer, timeoutMs: number, signal: AbortSignal): Promise<DataConnection | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: DataConnection | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      host.off('connection', onConn);
      signal.removeEventListener('abort', onAbort);
      resolve(c);
    };
    const onConn = (c: DataConnection) => {
      if (done) {
        c.on('open', () => {
          c.send({ t: 'busy' });
          setTimeout(() => c.close(), 300);
        });
        return;
      }
      c.once('open', () => finish(c));
    };
    const onAbort = () => finish(null);
    host.on('connection', onConn);
    signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

export type { LinkResult } from './link';
import type { LinkResult } from './link';

// ---------------------------------------------------------------- private rooms

export async function hostRoom(onCode: (code: string) => void, signal: AbortSignal): Promise<LinkResult | null> {
  let host: Peer | null = null;
  let code = '';
  for (let i = 0; i < 6 && !host; i++) {
    code = randomCode();
    host = await createPeer(PEER_NAMESPACE + 'room-' + code);
  }
  if (!host) throw new Error('no-room');
  onCode(code);
  const conn = await waitForIncoming(host, 1e9, signal);
  if (!conn) {
    host.destroy();
    return null;
  }
  conn.send({ t: 'accept' });
  host.on('connection', (c) => c.on('open', () => { c.send({ t: 'busy' }); setTimeout(() => c.close(), 300); }));
  return { link: new PeerLink(conn, [host]), host: true };
}

export async function joinRoom(code: string): Promise<LinkResult> {
  const me = await createPeer();
  if (!me) throw new Error('broker');
  const conn = await tryConnect(me, PEER_NAMESPACE + 'room-' + code.toUpperCase().trim(), 9000);
  if (!conn) {
    me.destroy();
    throw new Error('room-not-found');
  }
  const link = new PeerLink(conn, [me]);
  const reply = await Promise.race([link.waitFor('accept', 5000), link.waitFor('busy', 5000)]);
  if (!reply || reply.t !== 'accept') {
    link.close();
    throw new Error(reply?.t === 'busy' ? 'room-busy' : 'room-not-found');
  }
  return { link, host: false };
}

// ---------------------------------------------------------------- quick match

export async function quickMatch(onStatus: (s: string) => void, signal: AbortSignal): Promise<LinkResult | null> {
  const me = await createPeer();
  if (!me) throw new Error('broker');
  const slotId = (i: number) => PEER_NAMESPACE + 'q-' + i;
  try {
    for (let round = 0; !signal.aborted; round++) {
      for (let slot = 0; slot < QUICK_SLOTS && !signal.aborted; slot++) {
        onStatus(round === 0 ? 'Looking for a waiting fighter…' : 'Still searching the murim…');
        // 1. someone waiting in this slot?
        const conn = await tryConnect(me, slotId(slot), 4500);
        if (signal.aborted) {
          conn?.close();
          break;
        }
        if (conn) {
          const link = new PeerLink(conn, [me]);
          const reply = await Promise.race([link.waitFor('accept', 4000), link.waitFor('busy', 4000)]);
          if (reply?.t === 'accept') return { link, host: false };
          link.conn.close();
          continue;
        }
        // 2. claim the slot and wait
        const host = await createPeer(slotId(slot)).catch(() => null);
        if (!host) continue;
        onStatus('Waiting for a challenger…');
        const incoming = await waitForIncoming(host, 14000 + Math.random() * 6000, signal);
        if (incoming) {
          incoming.send({ t: 'accept' });
          // free the slot id for the next pair but keep the established connection
          host.on('connection', (c) => c.on('open', () => { c.send({ t: 'busy' }); setTimeout(() => c.close(), 300); }));
          setTimeout(() => host.disconnect(), 1500);
          me.destroy();
          return { link: new PeerLink(incoming, [host]), host: true };
        }
        host.destroy();
        break; // rescan from slot 0
      }
    }
  } catch (e) {
    me.destroy();
    throw e;
  }
  me.destroy();
  return null;
}
