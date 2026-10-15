// Replay / live viewer: re-runs a bout from its seed and input log with the same deterministic sim the server used.
import { SimEvent } from '../sim/defs';
import { CHARS } from '../sim/chars';
import { Match, createMatch, step } from '../sim/sim';
import { arenaGet } from './client';
import { moveLabel } from './observe';
import { ReplayData, TurnRecord } from './replay';
import { rleDecode } from './rle';

/** Frames kept behind the live edge, so a bout that is still running plays smoothly between agent turns. */
const LIVE_LAG = 90;

export class WatchRun {
  s: Match;
  in0: number[];
  in1: number[];
  turns: TurnRecord[];
  speed = 1;
  paused = false;
  private polling = false;
  private lastPoll = 0;
  /** index of the next turn record to show */
  turnI = 0;

  private constructor(public data: ReplayData) {
    this.s = createMatch({ p1: data.p1, p2: data.p2, seed: data.seed });
    this.in0 = rleDecode(data.inputs[0]);
    this.in1 = rleDecode(data.inputs[1]);
    this.turns = data.turns ?? [];
  }

  static async load(id: string): Promise<WatchRun> {
    const data = await arenaGet<ReplayData>(`/api/replays/${encodeURIComponent(id)}`, 15000);
    const w = new WatchRun(data);
    // joining a long live bout: skip ahead quietly to shortly before the live edge
    if (w.live && w.in0.length > 600) w.skipTo(w.in0.length - 300);
    return w;
  }

  get live(): boolean {
    return this.data.status === 'live';
  }

  get labels(): [string, string] {
    return this.data.labels;
  }

  /** Simulate without presenting (no events are returned). */
  skipTo(frame: number): void {
    while (this.s.frame < frame && this.s.frame < this.in0.length) step(this.s, this.in0[this.s.frame], this.in1[this.s.frame]);
    while (this.turnI < this.turns.length && this.turns[this.turnI].f < this.s.frame) this.turnI++;
  }

  restart(): void {
    this.s = createMatch({ p1: this.data.p1, p2: this.data.p2, seed: this.data.seed });
    this.turnI = 0;
  }

  /** Frames available but not yet shown. */
  buffered(): number {
    return this.in0.length - this.s.frame;
  }

  /** Can the next frame play now? Live bouts hold back a little so turns don't stutter. */
  canStep(): boolean {
    const left = this.buffered();
    if (left <= 0) return false;
    return !this.live || left > LIVE_LAG || this.s.frame < 240;
  }

  stepOnce(): SimEvent[] {
    const f = this.s.frame;
    step(this.s, this.in0[f], this.in1[f]);
    return this.s.events.slice();
  }

  /** Turn records that became visible since the last call. */
  newTurns(): TurnRecord[] {
    const out: TurnRecord[] = [];
    while (this.turnI < this.turns.length && this.turns[this.turnI].f <= this.s.frame) out.push(this.turns[this.turnI++]);
    return out;
  }

  /** Fetch new frames of a live bout (call often; it throttles itself). */
  poll(now: number): void {
    if (!this.live || this.polling || now - this.lastPoll < 1500) return;
    this.polling = true;
    this.lastPoll = now;
    arenaGet<ReplayData>(`/api/replays/${this.data.id}?from=${this.in0.length}`, 10000)
      .then((d) => {
        if ((d.from ?? 0) === this.in0.length) {
          this.in0.push(...rleDecode(d.inputs[0]));
          this.in1.push(...rleDecode(d.inputs[1]));
          this.turns.push(...(d.turns ?? []));
        }
        this.data = { ...this.data, status: d.status, winner: d.winner, endedBy: d.endedBy, frames: d.frames };
      })
      .catch(() => null)
      .finally(() => {
        this.polling = false;
      });
  }

  /** "launcher combo", or a fighter's own art name. */
  actionName(side: number, action: string): string {
    if (/^art_|^secret$/.test(action)) return moveLabel(CHARS[this.s.f[side].ch].id, action);
    return action.replace(/_/g, ' ');
  }
}
