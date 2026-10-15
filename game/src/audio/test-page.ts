/*
 * Dev-only audition page for the procedural audio module (served at /audio-test.html by
 * `npm run dev`). Not imported by the game.
 */

import { audio, audioDebugInfo } from './audio';
import type { MusicTrack, PlayOpts, SfxId } from './audio';

/** One-line design notes; the Record type guarantees every SfxId has a button. */
const NOTES: Record<SfxId, string> = {
  whoosh_light: 'sleeve swish, fluttering band-passed air',
  whoosh_heavy: 'deep body swing, low air push + whum',
  hit_light: 'crack + snap + pitched thump + cloth slap',
  hit_heavy: 'driven crack, bone clicks, deep kick, crunch',
  hit_focus: 'unblockable: crack, boom, sub, metal ring',
  block: 'dull wooden/cloth thud, no crack',
  deflect: 'FM clang + inharmonic bar partials, shimmer',
  guard_crush: 'splintering crackle, low hit, glass, falling tone',
  dash: 'cloth swish + foot scuff',
  jump: 'push-off thump + rising swish',
  land: 'soft thump + dust',
  slam: 'ground boom, dirt crunch, rumble, debris',
  crater: 'explosion, sub boom, rolling rumble, rock rattle',
  qi_charge: 'rising airy hum, tremolo speeds up (~0.8 s)',
  qi_ready: 'pentatonic glass-chime sparkle',
  qi_burst: 'explosive wind, sweeping low-pass roar',
  art_cast: 'rising wind + pitched D/A swell + ting',
  projectile: 'lash snap + travelling doppler whoosh',
  secret_start: 'odaiko hit, reverse gong into gong + taiko',
  secret_hit: 'massive driven boom, rumble, debris, dark gong',
  ko: 'jing gong + slowed boom',
  round_call: 'temple bell with log strike',
  fight_call: 'two sharp taiko hits',
  ui_move: 'soft woodblock tick',
  ui_select: 'two-note zither pluck',
  ui_back: 'falling muted pluck',
  victory: 'pentatonic run + rolled chord + gong',
  defeat: 'descending phrase, falling bend, low gong',
  countdown: 'woodblock tick (< 10 s)',
};

const GROUPS: { title: string; ids: SfxId[] }[] = [
  { title: 'Combat', ids: ['whoosh_light', 'whoosh_heavy', 'hit_light', 'hit_heavy', 'hit_focus', 'block', 'deflect', 'guard_crush'] },
  { title: 'Movement and ground', ids: ['dash', 'jump', 'land', 'slam', 'crater'] },
  { title: 'Qi and techniques', ids: ['qi_charge', 'qi_ready', 'qi_burst', 'art_cast', 'projectile', 'secret_start', 'secret_hit'] },
  { title: 'Match flow', ids: ['round_call', 'fight_call', 'countdown', 'ko', 'victory', 'defeat'] },
  { title: 'Menu', ids: ['ui_move', 'ui_select', 'ui_back'] },
];

const app = document.getElementById('app') as HTMLElement;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

function section(title: string): HTMLElement {
  app.append(el('h2', { textContent: title }));
  const box = el('div');
  app.append(box);
  return box;
}

function button(label: string, sub: string, onClick: (ev: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = el('button', { type: 'button', className: cls }, label);
  if (sub) b.append(el('small', { textContent: sub }));
  b.addEventListener('click', (ev) => {
    // unlock inside the gesture, then act once the context is running
    void audio.unlock().then(() => onClick(ev));
  });
  return b;
}

function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
  const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = el('output', { textContent: value.toFixed(2) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = v.toFixed(2);
    onInput(v);
  });
  parent.append(el('label', { className: 'slider' }, label, input, out));
  return input;
}

function checkbox(parent: HTMLElement, label: string, checked: boolean): HTMLInputElement {
  const input = el('input', { type: 'checkbox', checked });
  parent.append(el('label', { className: 'check' }, input, label));
  return input;
}

// ------------------------------------------------------------------------------------- status

const status = el('div', { id: 'status', textContent: 'audio locked: click any button' });
app.append(status);
setInterval(() => {
  const d = audioDebugInfo();
  status.textContent =
    `context: ${d.state}${d.supported ? '' : ' (Web Audio unavailable)'}  ${d.sampleRate ? d.sampleRate + ' Hz' : ''}   ready: ${audio.ready}   unlock: ${d.unlockMs} ms main thread\n` +
    `sfx pre-rendered: ${d.sfxRendered}/${d.sfxTotal} variations, ${d.sfxRenderMs} ms CPU${d.sfxRenderWhere ? ` (${d.sfxRenderWhere})` : ''}   active voices: ${d.voices}\n` +
    `music: ${d.musicTrack ?? 'off'}   instrument bank: ${d.musicReady ? `ready, ${d.musicRenderMs} ms CPU (${d.musicRenderWhere})` : 'not rendered yet'}   slowmo: ${d.slowmo}`;
}, 250);

// ------------------------------------------------------------------------------------- play options

const opts = { volume: 1, pitch: 1, pan: 0, intensity: 0.5 };
const optBox = section('Play options');
optBox.className = 'controls';
slider(optBox, 'volume', 0, 1, 0.01, opts.volume, (v) => (opts.volume = v));
slider(optBox, 'pitch', 0.5, 2, 0.01, opts.pitch, (v) => (opts.pitch = v));
slider(optBox, 'pan', -1, 1, 0.01, opts.pan, (v) => (opts.pan = v));
slider(optBox, 'intensity', 0, 1, 0.01, opts.intensity, (v) => (opts.intensity = v));
const randPan = checkbox(optBox, 'random pan per play', false);
const randInt = checkbox(optBox, 'random intensity per play', false);
optBox.append(el('span', { className: 'note', textContent: 'Space replays the last sound.' }));

let last: SfxId | null = null;
function playOpts(): PlayOpts {
  return {
    volume: opts.volume,
    pitch: opts.pitch,
    pan: randPan.checked ? Math.random() * 1.6 - 0.8 : opts.pan,
    intensity: randInt.checked ? Math.random() : opts.intensity,
  };
}
function play(id: SfxId): void {
  last = id;
  audio.play(id, playOpts());
}

// ------------------------------------------------------------------------------------- SFX buttons

for (const g of GROUPS) {
  const box = section(g.title);
  box.className = 'grid';
  for (const id of g.ids) box.append(button(id, NOTES[id], () => play(id)));
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && last && !(e.target instanceof HTMLInputElement)) {
    e.preventDefault();
    const id = last;
    void audio.unlock().then(() => play(id));
  }
});

// ------------------------------------------------------------------------------------- sequences

const at = (ms: number, fn: () => void) => window.setTimeout(fn, ms);
const seqBox = section('Sequences');
seqBox.className = 'grid';
seqBox.append(
  button('Combo x8', 'rising intensity, stacking + limiter', () => {
    const chain: SfxId[] = ['hit_light', 'hit_light', 'hit_light', 'hit_heavy', 'hit_light', 'hit_heavy', 'hit_heavy', 'hit_focus'];
    chain.forEach((id, i) => {
      at(i * 140, () => {
        audio.play(i % 2 ? 'whoosh_heavy' : 'whoosh_light', { intensity: i / 7, pan: -0.2 });
        at(45, () => audio.play(id, { intensity: i / 7, pan: 0.2 }));
      });
    });
  }),
  button('Parry exchange', 'swing → deflect x3', () => {
    for (let i = 0; i < 3; i++) {
      at(i * 420, () => audio.play('whoosh_heavy', { pan: 0.4 }));
      at(i * 420 + 90, () => audio.play('deflect', { intensity: 0.4 + i * 0.25 }));
    }
  }),
  button('Block string', 'guard x4 → guard crush', () => {
    for (let i = 0; i < 4; i++) at(i * 180, () => audio.play('block', { intensity: 0.3 + i * 0.15 }));
    at(4 * 180 + 60, () => audio.play('guard_crush', { intensity: 0.8 }));
  }),
  button('Stress: 40 hits', '40 heavy hits in 0.4 s (voice cap)', () => {
    for (let i = 0; i < 40; i++) at(i * 10, () => audio.play(i % 3 ? 'hit_heavy' : 'hit_light', { intensity: 1, pan: Math.sin(i) * 0.8 }));
  }),
  button('Round intro', 'bell → fight call', () => {
    audio.play('round_call');
    at(1700, () => audio.play('fight_call'));
  }),
  button('Countdown 5 s', 'last five seconds of the timer', () => {
    for (let i = 0; i < 5; i++) at(i * 1000, () => audio.play('countdown'));
  }),
  button('Ultimate', 'duck music, secret start → hit', () => {
    audio.duck(0.3, 3.4);
    audio.play('secret_start');
    at(2600, () => audio.play('secret_hit'));
  }),
  button('KO + slow motion', 'focus hit → slowmo 0.4 + KO → victory', () => {
    audio.play('hit_focus', { intensity: 1 });
    at(80, () => {
      audio.setSlowmo(0.4);
      audio.duck(0.35, 2.4);
      audio.play('ko');
      audio.play('crater', { intensity: 0.7 });
    });
    at(2600, () => {
      audio.setSlowmo(1);
      audio.play('victory');
    });
  }),
);

// ------------------------------------------------------------------------------------- music

const musicBox = section('Music (generative)');
const musicRow = el('div', { className: 'row' });
musicBox.append(musicRow);
let fade = 1.5;
const trackButtons: HTMLButtonElement[] = [];
const tracks: { t: MusicTrack; label: string; sub: string }[] = [
  { t: 'menu', label: 'menu', sub: '~70 BPM, drone + sparse zither, flute' },
  { t: 'battle', label: 'battle', sub: '~126 BPM, taiko groove + ostinato' },
  { t: 'tension', label: 'tension', sub: 'low drone, heavy drums, tremolo' },
  { t: null, label: 'stop', sub: 'fade out' },
];
for (const tr of tracks) {
  const b = button(tr.label, tr.sub, () => {
    audio.music(tr.t, fade);
    trackButtons.forEach((x) => x.classList.toggle('on', x === b && tr.t !== null));
  });
  trackButtons.push(b);
  musicRow.append(b);
}
const musicCtl = el('div', { className: 'controls' });
musicBox.append(musicCtl);
slider(musicCtl, 'fade (s)', 0, 5, 0.1, fade, (v) => (fade = v));
const fxRow = el('div', { className: 'row' });
musicBox.append(fxRow);
fxRow.append(
  button('duck 0.3 for 3 s', 'ultimate cinematic', () => audio.duck(0.3, 3)),
);
let slow = false;
const slowBtn = button('slow motion 0.4', 'toggle setSlowmo', () => {
  slow = !slow;
  audio.setSlowmo(slow ? 0.4 : 1);
  slowBtn.classList.toggle('on', slow);
});
fxRow.append(slowBtn);

// ------------------------------------------------------------------------------------- volumes

const volBox = section('Volumes (persisted to localStorage "inkfist.audio")');
volBox.className = 'controls';
for (const k of ['master', 'sfx', 'music'] as const) {
  slider(volBox, k, 0, 1, 0.01, audio.getVolume(k), (v) => audio.setVolume(k, v));
}
