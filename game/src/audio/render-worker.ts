/*
 * INKFIST procedural audio: Web Worker entry. Renders a list of jobs off the main thread and
 * streams each result back (buffers are transferred, not copied).
 */

import { renderJob } from './render-jobs';
import type { RenderJob, RenderResult } from './render-jobs';

export type WorkerRequest = { jobs: RenderJob[]; rate: number };
export type WorkerMessage =
  | { type: 'result'; r: RenderResult }
  | { type: 'error'; i: number; message: string }
  | { type: 'done'; cpu: number };

// typed loosely so this file compiles against the DOM lib used by the rest of the project
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerMessage, transfer: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { jobs, rate } = e.data;
  let cpu = 0;
  for (let i = 0; i < jobs.length; i++) {
    try {
      const r = renderJob(jobs[i], i, rate);
      cpu += r.ms;
      const transfer: Transferable[] = r.chans.map((c) => c.buffer as ArrayBuffer);
      if (r.heavy) transfer.push(r.heavy.buffer as ArrayBuffer);
      scope.postMessage({ type: 'result', r }, transfer);
    } catch (err) {
      scope.postMessage({ type: 'error', i, message: String(err) }, []);
    }
  }
  scope.postMessage({ type: 'done', cpu }, []);
};
