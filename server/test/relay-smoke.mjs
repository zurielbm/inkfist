// Smoke test against a running relay (default: wrangler dev on :8787).
const BASE = process.env.RELAY ?? 'ws://127.0.0.1:8787';
const open = (path) => new Promise((res, rej) => {
  const ws = new WebSocket(BASE + path);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiters.findIndex((x) => x.t === m.t); if (w >= 0) waiters.splice(w, 1)[0].res(m); else inbox.push(m); };
  ws.onopen = () => res({ ws, next: (t, ms = 5000) => new Promise((r2, j2) => { const i = inbox.findIndex((m) => m.t === t); if (i >= 0) return r2(inbox.splice(i, 1)[0]); waiters.push({ t, res: r2 }); setTimeout(() => j2(new Error('timeout waiting ' + t)), ms); }) });
  ws.onerror = (e) => rej(e);
});
const ok = (c, msg) => { if (!c) { console.error('FAIL', msg); process.exit(1); } console.log('ok', msg); };

// private room
const host = await open('/room/KWANG?role=host');
await host.next('open');
const guest = await open('/room/KWANG?role=guest');
await guest.next('accept');
await host.next('paired');
host.ws.send(JSON.stringify({ t: 'hello', v: 1 }));
ok((await guest.next('hello')).v === 1, 'room relays host -> guest');
guest.ws.send(JSON.stringify({ t: 'i', f: 3, i: [1, 2, 3] }));
ok((await host.next('i')).f === 3, 'room relays guest -> host');
const third = await open('/room/KWANG?role=guest');
ok((await third.next('busy')).t === 'busy', 'third player rejected');
const dup = await open('/room/ABCDE?role=guest');
ok((await dup.next('not-found')).t === 'not-found', 'missing room reported');
guest.ws.close();
ok((await host.next('bye')).t === 'bye', 'host told when guest leaves');
host.ws.close();

// quick match through the lobby
const a = await open('/lobby');
const b = await open('/lobby');
const ma = await a.next('match');
const mb = await b.next('match');
ok(ma.room === mb.room && ma.host !== mb.host, 'lobby pairs two players into one room');
const pa = await open(`/room/${ma.room}?role=peer`);
const pb = await open(`/room/${mb.room}?role=peer`);
await pa.next('paired');
await pb.next('paired');
pb.ws.send(JSON.stringify({ t: 'ping', s: 1 }));
ok((await pa.next('ping')).s === 1, 'quick-match room relays');
pa.ws.close(); pb.ws.close();
console.log('relay smoke test passed');
process.exit(0);
