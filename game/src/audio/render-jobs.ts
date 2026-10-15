/*
 * INKFIST procedural audio: render jobs. Pure (no DOM), shared by the render worker and the
 * main-thread fallback, so pre-rendering can run off the main thread.
 */

import type { SfxId } from './audio';
import { mulberry32, renderRate, renderReverbIR } from './dsp';
import { renderBreathLoop, renderDroneLoop, renderDrum, renderGong, renderPluckNote } from './instruments';
import type { DroneName, DrumName, GongKind } from './instruments';
import { renderSfx } from './sfx-defs';

export type RenderJob =
  | { kind: 'sfx'; id: SfxId; v: number }
  | { kind: 'pluck'; idx: number }
  | { kind: 'drum'; name: DrumName }
  | { kind: 'gong'; gong: GongKind }
  | { kind: 'drone'; drone: DroneName }
  | { kind: 'breath' }
  | { kind: 'ir' };

export interface RenderResult {
  /** index of the job in the submitted list */
  i: number;
  /** channel data (1 channel, or 2 for the reverb IR) */
  chans: Float32Array[];
  /** SFX heavy layer, if any */
  heavy: Float32Array | null;
  /** sample rate the data was rendered at */
  rate: number;
  ms: number;
}

export function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Runs one job at the given AudioContext sample rate. */
export function renderJob(job: RenderJob, i: number, ctxRate: number): RenderResult {
  const t0 = nowMs();
  const half = renderRate(ctxRate, 2);
  let chans: Float32Array[];
  let heavy: Float32Array | null = null;
  let rate = ctxRate;
  switch (job.kind) {
    case 'sfx': {
      const r = renderSfx(job.id, ctxRate, job.v);
      chans = [r.main];
      heavy = r.heavy;
      rate = r.rate;
      break;
    }
    case 'pluck':
      chans = [renderPluckNote(ctxRate, job.idx)];
      break;
    case 'drum':
      chans = [renderDrum(ctxRate, job.name)];
      break;
    case 'gong':
      chans = [renderGong(half, job.gong)];
      rate = half;
      break;
    case 'drone':
      chans = [renderDroneLoop(half, job.drone)];
      rate = half;
      break;
    case 'breath':
      chans = [renderBreathLoop(ctxRate)];
      break;
    case 'ir':
      chans = renderReverbIR(ctxRate, mulberry32(0x1f2e3d));
      break;
  }
  return { i, chans, heavy, rate, ms: nowMs() - t0 };
}
