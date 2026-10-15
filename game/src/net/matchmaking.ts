// Chooses the online transport: the server's WebSocket relay when RELAY_URL is configured (or ?relay=... in the page URL),
// otherwise peer-to-peer WebRTC through the public PeerJS broker.
import { RELAY_URL } from '../config';
import { LinkResult } from './link';
import * as P from './peer';
import * as R from './relay';

export function relayBase(): string {
  const q = new URLSearchParams(location.search).get('relay');
  return q || RELAY_URL;
}

export function quickMatch(onStatus: (s: string) => void, signal: AbortSignal): Promise<LinkResult | null> {
  const base = relayBase();
  return base ? R.relayQuickMatch(base, onStatus, signal) : P.quickMatch(onStatus, signal);
}

export function hostRoom(onCode: (code: string) => void, signal: AbortSignal): Promise<LinkResult | null> {
  const base = relayBase();
  return base ? R.relayHostRoom(base, onCode, signal) : P.hostRoom(onCode, signal);
}

export function joinRoom(code: string): Promise<LinkResult> {
  const base = relayBase();
  return base ? R.relayJoinRoom(base, code) : P.joinRoom(code);
}
