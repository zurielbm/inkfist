import { NetChannel } from './rollback';

/** A connected 1v1 message link (PeerJS data channel or WebSocket relay). */
export interface Link extends NetChannel {
  onClose: (() => void) | null;
  closed: boolean;
  listen(fn: (msg: any) => void): () => void;
  waitFor(type: string, timeoutMs: number): Promise<any | null>;
  close(): void;
}

export interface LinkResult {
  link: Link;
  host: boolean;
}
