/**
 * Dev-only character viewer (viewer.html): one fighter through the game's real ink pipeline (toon + ink map,
 * brush outline, watercolour/paper post) with an orbit camera, clip scrubbing and expression preview.
 * URL: ?char=mujin&clip=idle&t=0.5&expr=shout&cam=face|bust|full&yaw=0&ui=0&hide=hair,head
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CharMeta, assetUrl } from './render/assets';
import { FighterView } from './render/fighterView';
import { InkPost } from './render/ink';
import { CHAR_IDS } from './sim/chars';

const q = new URLSearchParams(location.search);
const state = {
  char: q.get('char') ?? CHAR_IDS[0],
  clip: q.get('clip') ?? 'idle',
  t: parseFloat(q.get('t') ?? '0'),
  play: q.get('play') !== '0',
  expr: q.get('expr') ?? 'none',
  cam: q.get('cam') ?? 'full',
  yaw: parseFloat(q.get('yaw') ?? '0'),
  pitch: parseFloat(q.get('pitch') ?? '4'),
};
const EXPRS = ['none', 'blink', 'glare', 'pain', 'shout', 'smirk'];

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor('#e8dcc4');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e8dcc4');
scene.add(new THREE.HemisphereLight('#fff6e6', '#5b5448', 1.6));
const key = new THREE.DirectionalLight('#fffaf0', 2.4);
key.position.set(-3, 7, 9);
scene.add(key);
const rim = new THREE.DirectionalLight('#f3e3c6', 0.8);
rim.position.set(4, 3, -6);
scene.add(rim);
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
const outlinePx = { value: 2.0 };
const res = { value: new THREE.Vector2(1, 1) };
const paper = await new THREE.TextureLoader().loadAsync(assetUrl('tex/paper.webp')).catch(() => undefined);
if (paper) paper.colorSpace = THREE.SRGBColorSpace;
const post = new InkPost(paper, undefined, 4);
post.u.uBoil.value = 0.0;

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
let view: FighterView | null = null;

async function load(id: string): Promise<void> {
  const [gltf, meta] = await Promise.all([
    loader.loadAsync(assetUrl(`chars/${id}.glb`)),
    fetch(assetUrl(`chars/${id}.json`), { cache: 'no-cache' }).then((r) => r.json() as Promise<CharMeta>),
  ]);
  if (view) view.removeFrom(scene);
  const inkMaps = new Map<string, THREE.Texture | null>();
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) inkMaps.set(m.name, (m.material as THREE.MeshStandardMaterial).emissiveMap);
  });
  view = new FighterView({ gltf, meta }, outlinePx, res);
  view.addTo(scene);
  view.shadow.position.set(0, 0.006, 0.05);
  // hide=hair,head isolates the rest (mesh names end in _body / _hair / _head)
  const hide = (q.get('hide') ?? '').split(',').filter(Boolean);
  view.root.traverse((o) => {
    if (hide.some((h) => o.name.endsWith(`_${h}`) || o.name.includes(`_${h}_`))) o.visible = false;
  });
  // dbg=ink shows the baked ink map unlit (R light bias, G sheen, B lines)
  if (q.get('dbg') === 'ink') {
    view.root.traverse((o) => {
      const m = o as THREE.Mesh;
      const map = inkMaps.get(m.name);
      if (m.isMesh && map) m.material = new THREE.MeshBasicMaterial({ map });
    });
  }
  // dbg=uv paints texture coordinates (R = u, G = v) to locate a surface in the atlas
  if (q.get('dbg') === 'uv') {
    const n = 256;
    const px = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) px.set([x, y, 0, 255], (y * n + x) * 4);
    const tex = new THREE.DataTexture(px, n, n);
    tex.needsUpdate = true;
    view.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.getAttribute('uv')) m.material = new THREE.MeshBasicMaterial({ map: tex });
    });
  }
  buildUi();
}

function setPose(dt: number): void {
  if (!view) return;
  const action = view.actions.get(state.clip) ?? view.actions.get('idle');
  if (!action) return;
  for (const a of view.actions.values()) if (a !== action) a.stop();
  action.play();
  action.setEffectiveWeight(1);
  const dur = action.getClip().duration;
  if (state.play) state.t = (state.t + dt / Math.max(dur, 1e-3)) % 1;
  action.time = Math.min(state.t * dur, dur - 1e-4);
  view.mixer.update(0);
  for (const { mesh, outline } of view.faces) {
    const dict = mesh.morphTargetDictionary!;
    const infl = mesh.morphTargetInfluences!;
    for (const name of EXPRS.slice(1)) if (dict[name] !== undefined) infl[dict[name]] = name === state.expr ? 1 : 0;
    if (outline.morphTargetInfluences) outline.morphTargetInfluences.splice(0, infl.length, ...infl);
  }
  view.root.updateMatrixWorld(true);
  view.updateCapsules();
  const caps = view.capsules.map((c) => c.cap);
  for (const c of view.chains) c.update(dt, 0.4 * Math.sin(performance.now() * 0.0011), caps);
}

const tmp = new THREE.Vector3();
function placeCamera(): void {
  if (!view) return;
  let target = new THREE.Vector3(0, 0.95, 0);
  let dist = 4.6;
  if (state.cam === 'handL' || state.cam === 'handR') {
    view.bonePos(state.cam === 'handL' ? 'middle_1_L' : 'middle_1_R', tmp);
    target = tmp.clone();
    dist = 0.5;
  } else if (state.cam === 'face' || state.cam === 'bust') {
    view.bonePos('head', tmp);
    target = tmp.clone().add(new THREE.Vector3(0, state.cam === 'face' ? 0.06 : -0.12, 0));
    dist = state.cam === 'face' ? 0.75 : 1.7;
  }
  // yaw 0 = the in-game view (fighter faces +X, camera on +Z)
  const yaw = THREE.MathUtils.degToRad(state.yaw);
  const pitch = THREE.MathUtils.degToRad(state.pitch);
  camera.position.set(
    target.x + Math.sin(yaw) * Math.cos(pitch) * dist,
    target.y + Math.sin(pitch) * dist,
    target.z + Math.cos(yaw) * Math.cos(pitch) * dist,
  );
  camera.lookAt(target);
}

function resize(): void {
  const w = innerWidth;
  const h = innerHeight;
  const pr = Math.min(devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  post.setSize(w, h, pr);
  res.value.set(w * pr, h * pr);
  outlinePx.value = Math.max(1.4, (2.1 * h * pr) / 1080) * (state.cam === 'face' ? 1.6 : state.cam === 'bust' ? 1.25 : 1);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

let drag: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => (drag = { x: e.clientX, y: e.clientY }));
addEventListener('pointerup', () => (drag = null));
addEventListener('pointermove', (e) => {
  if (!drag) return;
  state.yaw -= (e.clientX - drag.x) * 0.4;
  state.pitch = Math.max(-30, Math.min(60, state.pitch + (e.clientY - drag.y) * 0.3));
  drag = { x: e.clientX, y: e.clientY };
});

function buildUi(): void {
  const ui = document.getElementById('ui')!;
  if (q.get('ui') === '0') ui.classList.add('hidden');
  const clips = view ? [...view.actions.keys()] : [];
  ui.innerHTML = `<b>墨</b>
    <select id="vchar">${CHAR_IDS.map((c) => `<option ${c === state.char ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <select id="vclip">${clips.map((c) => `<option ${c === state.clip ? 'selected' : ''}>${c}</option>`).join('')}</select>
    <input id="vt" type="range" min="0" max="1" step="0.001" value="${state.t}" style="width:160px">
    <button id="vplay" class="${state.play ? 'on' : ''}">play</button>
    <select id="vexpr">${EXPRS.map((c) => `<option ${c === state.expr ? 'selected' : ''}>${c}</option>`).join('')}</select>
    ${['full', 'bust', 'face', 'handL', 'handR'].map((c) => `<button data-cam="${c}" class="${c === state.cam ? 'on' : ''}">${c}</button>`).join('')}`;
  (ui.querySelector('#vchar') as HTMLSelectElement).onchange = (e) => {
    state.char = (e.target as HTMLSelectElement).value;
    void load(state.char);
  };
  (ui.querySelector('#vclip') as HTMLSelectElement).onchange = (e) => {
    state.clip = (e.target as HTMLSelectElement).value;
    state.t = 0;
  };
  (ui.querySelector('#vt') as HTMLInputElement).oninput = (e) => {
    state.t = parseFloat((e.target as HTMLInputElement).value);
    state.play = false;
    buildUi();
  };
  (ui.querySelector('#vplay') as HTMLButtonElement).onclick = () => {
    state.play = !state.play;
    buildUi();
  };
  (ui.querySelector('#vexpr') as HTMLSelectElement).onchange = (e) => (state.expr = (e.target as HTMLSelectElement).value);
  ui.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) => {
    b.onclick = () => {
      state.cam = b.dataset.cam!;
      resize();
      buildUi();
    };
  });
}

resize();
await load(state.char);
let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  setPose(dt);
  placeCamera();
  post.u.uTime.value = now / 1000;
  if (q.get('dbg')) renderer.render(scene, camera);
  else post.render(renderer, scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
(window as unknown as { viewerReady: boolean }).viewerReady = true;
