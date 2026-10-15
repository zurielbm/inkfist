// Judge: re-simulates a human match submitted by the game, in small chunks driven by alarms (Free plan: 10 ms CPU per run).
import { DurableObject } from 'cloudflare:workers';
import { Board, HumanClaim, ReplayData, VerifyJob, VerifySnapshot, stageFor } from '../../game/src/arena/replay';
import { Env, Fail, fail } from './util';

/** Frames simulated per alarm (about 4 ms of CPU). */
const CHUNK = 900;

interface JudgeMeta {
  resultId: string;
  board: Board;
  labels: [string, string];
  created: number;
  status: 'running' | 'verified' | 'rejected';
  reason?: string;
  winner?: number;
  frames?: number;
}

export class Judge extends DurableObject<Env> {
  async start(resultId: string, claim: HumanClaim, info: { board: Board; labels: [string, string]; created: number }): Promise<void> {
    if (await this.ctx.storage.get('meta')) return;
    const meta: JudgeMeta = { resultId, ...info, status: 'running' };
    await this.ctx.storage.put({ meta, claim });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const meta = await this.ctx.storage.get<JudgeMeta>('meta');
    const claim = await this.ctx.storage.get<HumanClaim>('claim');
    if (!meta || !claim || meta.status !== 'running') return;
    let job: VerifyJob;
    let done: boolean;
    try {
      job = new VerifyJob(claim, await this.ctx.storage.get<VerifySnapshot>('job'));
      done = job.run(CHUNK);
    } catch (e) {
      meta.status = 'rejected';
      meta.reason = String((e as Error).message || e);
      await this.ctx.storage.put('meta', meta);
      await this.env.ARENA.getByName('main').resultVerified(meta.resultId, { ok: false, reason: meta.reason, winner: -1, frames: 0, labels: meta.labels, p1: claim.p1, p2: claim.p2 });
      return;
    }
    if (!done) {
      await this.ctx.storage.put('job', job.snapshot());
      await this.ctx.storage.setAlarm(Date.now());
      return;
    }
    const v = job.verdict();
    meta.status = v.ok ? 'verified' : 'rejected';
    meta.reason = v.reason;
    meta.winner = v.winner;
    meta.frames = job.s.frame;
    await this.ctx.storage.put({ meta, inputs: job.out });
    await this.ctx.storage.delete('job');
    await this.env.ARENA.getByName('main').resultVerified(meta.resultId, {
      ok: v.ok, reason: v.reason, winner: v.winner, frames: job.s.frame, labels: meta.labels, p1: claim.p1, p2: claim.p2,
    });
  }

  async replay(): Promise<ReplayData | Fail> {
    const meta = await this.ctx.storage.get<JudgeMeta>('meta');
    const claim = await this.ctx.storage.get<HumanClaim>('claim');
    const inputs = await this.ctx.storage.get<[number[], number[]]>('inputs');
    if (!meta || !claim || meta.status !== 'verified' || !inputs) return fail(404, 'not_found', 'No verified replay here.');
    return {
      v: 1, id: meta.resultId, board: meta.board, status: 'done', seed: claim.seed, p1: claim.p1, p2: claim.p2, stage: stageFor(claim.seed),
      labels: meta.labels, inputs, frames: meta.frames ?? claim.frames, turns: [], winner: meta.winner ?? -1, endedBy: 'ko', created: meta.created,
    };
  }
}
