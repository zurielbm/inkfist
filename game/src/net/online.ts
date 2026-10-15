import { Link } from './link';
import { PROTOCOL_VERSION } from '../config';

export interface OnlineStart {
  seed: number;
  p1: number;
  p2: number;
  stage: string;
  delay: number;
  names: [string, string];
  localSide: number;
  rtt: number;
  /** opponent's public arena id (ranked PvP), if they have one */
  oppAid: string | null;
}

function installPong(link: Link): void {
  link.listen((m) => {
    if (m?.t === 'lping') link.send({ t: 'lpong', s: m.s });
  });
}

async function measureRtt(link: Link, n = 5): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    link.send({ t: 'lping', s: i });
    const r = await link.waitFor('lpong', 1500);
    if (r) samples.push(performance.now() - t0);
  }
  if (!samples.length) return 250;
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

export async function handshake(link: Link, host: boolean, myChar: number, myName: string, stages: string[], aid: string | null = null): Promise<OnlineStart> {
  installPong(link);
  const helloP = link.waitFor('hello', 12000);
  link.send({ t: 'hello', v: PROTOCOL_VERSION, ch: myChar, name: myName.slice(0, 16), ...(aid ? { aid } : {}) });
  const hello = await helloP;
  if (!hello) throw new Error('handshake-timeout');
  if (hello.v !== PROTOCOL_VERSION) throw new Error('version-mismatch');
  const oppAid = typeof hello.aid === 'string' && /^e_[a-z2-9]{10}$/.test(hello.aid) ? hello.aid : null;
  if (host) {
    const rtt = await measureRtt(link);
    const delay = rtt < 50 ? 1 : rtt < 110 ? 2 : rtt < 170 ? 3 : 4;
    const seed = (Math.random() * 0xffffffff) >>> 0;
    const stage = stages[(Math.random() * stages.length) | 0] ?? 'cloudpeak';
    const start = { t: 'start', seed, p1: myChar, p2: hello.ch, stage, delay, names: [myName, String(hello.name || 'Wanderer')] };
    link.send(start);
    await new Promise((r) => setTimeout(r, rtt / 2));
    return { seed, p1: myChar, p2: hello.ch, stage, delay, names: start.names as [string, string], localSide: 0, rtt, oppAid };
  }
  const st = await link.waitFor('start', 15000);
  if (!st) throw new Error('handshake-timeout');
  return { seed: st.seed, p1: st.p1, p2: st.p2, stage: st.stage, delay: st.delay, names: st.names, localSide: 1, rtt: 0, oppAid };
}
