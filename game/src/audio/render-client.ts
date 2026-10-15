/*
 * INKFIST procedural audio: runs render jobs in a Web Worker (off the main thread) and falls back
 * to time-sliced main-thread rendering when workers are unavailable or fail.
 */

import { renderJob } from './render-jobs';
import type { RenderJob, RenderResult } from './render-jobs';
import type { WorkerMessage, WorkerRequest } from './render-worker';

export type RenderWhere = 'worker' | 'main';

/**
 * Wraps rendered samples in an AudioBuffer. `rate` may be below the context rate (half-rate
 * renders); the browser resamples on playback. If the browser rejects that rate, the data is
 * linearly upsampled to the context rate instead.
 */
export function toBuffer(ctx: BaseAudioContext, data: Float32Array, rate = ctx.sampleRate): AudioBuffer {
  const n = Math.max(1, data.length);
  if (rate !== ctx.sampleRate) {
    try {
      const b = ctx.createBuffer(1, n, rate);
      b.getChannelData(0).set(data);
      return b;
    } catch {
      const ratio = rate / ctx.sampleRate;
      const m = Math.max(1, Math.floor((n - 1) / ratio) + 1);
      const up = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const p = i * ratio;
        const j = Math.floor(p);
        const f = p - j;
        up[i] = (data[j] ?? 0) * (1 - f) + (data[j + 1] ?? 0) * f;
      }
      return toBuffer(ctx, up);
    }
  }
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  b.getChannelData(0).set(data);
  return b;
}

/**
 * Yields to the event loop. MessageChannel is not subject to the 4 ms nested-timer clamp nor to
 * background-tab timer throttling; falls back to setTimeout.
 */
function makeYield(): (fn: () => void) => void {
  if (typeof MessageChannel === 'undefined') return (fn) => void setTimeout(fn, 0);
  const ch = new MessageChannel();
  const queue: Array<() => void> = [];
  ch.port1.onmessage = () => {
    const fn = queue.shift();
    if (fn) fn();
  };
  return (fn) => {
    queue.push(fn);
    ch.port2.postMessage(0);
  };
}

/** Runs tasks on the main thread in time slices of ~budgetMs, yielding in between. */
export function runChunked(tasks: Array<() => void>, budgetMs: number, done: () => void): void {
  const yieldTo = makeYield();
  let i = 0;
  const slice = (): void => {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    while (i < tasks.length) {
      try {
        tasks[i]();
      } catch (e) {
        console.warn('[audio] render task failed', e);
      }
      i++;
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - start > budgetMs) break;
    }
    if (i < tasks.length) yieldTo(slice);
    else done();
  };
  yieldTo(slice);
}

/**
 * Renders `jobs` at the context sample rate, preferably in a module Web Worker. Results are
 * delivered one by one (in job order) via onResult; onDone reports the summed render CPU time and
 * where it ran.
 */
export function renderInBackground(
  rate: number,
  jobs: RenderJob[],
  onResult: (job: RenderJob, r: RenderResult) => void,
  onDone: (cpuMs: number, where: RenderWhere) => void,
): void {
  const pending = new Set<number>(jobs.map((_, i) => i));
  let cpu = 0;
  let finished = false;
  const deliver = (r: RenderResult): void => {
    if (!pending.has(r.i)) return;
    pending.delete(r.i);
    cpu += r.ms;
    try {
      onResult(jobs[r.i], r);
    } catch (e) {
      console.warn('[audio] could not store render result', e);
    }
  };
  const finish = (where: RenderWhere): void => {
    if (finished) return;
    finished = true;
    onDone(cpu, where);
  };
  const fallback = (): void => {
    const rest = [...pending].sort((a, b) => a - b);
    runChunked(
      rest.map((i) => () => deliver(renderJob(jobs[i], i, rate))),
      10,
      () => finish('main'),
    );
  };

  let worker: Worker | null = null;
  try {
    if (typeof Worker !== 'undefined') {
      worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module', name: 'inkfist-audio-render' });
    }
  } catch {
    worker = null;
  }
  if (!worker) {
    fallback();
    return;
  }
  const w = worker;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    w.terminate();
  };
  w.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const m = e.data;
    if (m.type === 'result') deliver(m.r);
    else if (m.type === 'error') console.warn('[audio] worker render job failed', m.i, m.message);
    else if (m.type === 'done') {
      close();
      if (pending.size) fallback();
      else finish('worker');
    }
  };
  const fail = (why: string): void => {
    if (closed) return;
    console.warn('[audio] render worker unavailable, rendering on the main thread:', why);
    close();
    fallback();
  };
  w.onerror = (e) => {
    e.preventDefault();
    fail(e.message || 'worker error');
  };
  w.onmessageerror = () => fail('message error');
  const req: WorkerRequest = { jobs, rate };
  w.postMessage(req);
}
