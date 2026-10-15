import * as THREE from 'three';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { ClipMeta } from './animmap';
import { CHAR_IDS } from '../sim/chars';

export interface ChainMeta {
  name: string;
  parent: string;
  kind: string;
  bones: string[];
  points: [number, number, number][];
  stiffness: number;
  damping: number;
  gravity: number;
  drag?: number;
  follow?: string;
  follow_amount?: number;
  /** extra clearance from the body colliders (hair over clothes needs more) */
  margin?: number;
}

export interface ColliderMeta {
  bone: string;
  /** capsule end: this bone's head; null = along the bone itself (length) */
  to: string | null;
  radius: number;
  length?: number;
}

export interface CharMeta {
  id: string;
  height: number;
  clips: Record<string, ClipMeta>;
  chains: ChainMeta[];
  colliders?: ColliderMeta[];
}

export interface CharAsset {
  gltf: GLTF;
  meta: CharMeta;
}

export interface StageLayer {
  id: string;
  src: string;
  z: number;
  centerY: number;
  width: number;
  height: number;
}

export interface StageJson {
  name: string;
  nameKo?: string;
  bg: string;
  layers: StageLayer[];
  floor: { src: string; zNear: number; zFar: number; tileWidth: number };
}

export interface StageAsset {
  id: string;
  json: StageJson;
  tex: Record<string, THREE.Texture>;
}

export interface Assets {
  chars: Record<string, CharAsset>;
  stages: Record<string, StageAsset>;
  tex: Record<string, THREE.Texture>;
}

const BASE = import.meta.env.BASE_URL || './';
export const assetUrl = (p: string) => `${BASE}assets/${p}`;

const TEX_FILES = ['paper', 'splat_0', 'splat_1', 'splat_2', 'splat_3', 'crater', 'cracks', 'speedlines', 'brush_stroke', 'enso', 'mist', 'palm'];
export const STAGE_IDS = ['cloudpeak', 'bamboo'];

type Progress = (loaded: number, total: number, label: string) => void;

function loadTexture(url: string): Promise<THREE.Texture | null> {
  return new Promise((resolve) => {
    new THREE.TextureLoader().load(
      url,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        resolve(t);
      },
      undefined,
      () => resolve(null),
    );
  });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function loadAssets(onProgress: Progress): Promise<Assets> {
  const out: Assets = { chars: {}, stages: {}, tex: {} };
  const jobs: { label: string; weight: number; run: () => Promise<void> }[] = [];
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  for (const id of CHAR_IDS) {
    jobs.push({
      label: id,
      weight: 5,
      run: async () => {
        const [gltf, meta] = await Promise.all([
          loader.loadAsync(assetUrl(`chars/${id}.glb`)).catch(() => null),
          fetchJson<CharMeta>(assetUrl(`chars/${id}.json`)),
        ]);
        if (gltf && meta) out.chars[id] = { gltf, meta };
      },
    });
  }
  for (const sid of STAGE_IDS) {
    jobs.push({
      label: sid,
      weight: 3,
      run: async () => {
        const json = await fetchJson<StageJson>(assetUrl(`stage/${sid}/stage.json`));
        if (!json) return;
        const tex: Record<string, THREE.Texture> = {};
        const files = [...json.layers.map((l) => l.src), json.floor?.src].filter(Boolean) as string[];
        await Promise.all(
          files.map(async (f) => {
            const t = await loadTexture(assetUrl(`stage/${sid}/${f}`));
            if (t) tex[f] = t;
          }),
        );
        out.stages[sid] = { id: sid, json, tex };
      },
    });
  }
  for (const name of TEX_FILES) {
    jobs.push({
      label: name,
      weight: 1,
      run: async () => {
        const t = await loadTexture(assetUrl(`tex/${name}.webp`));
        if (t) out.tex[name] = t;
      },
    });
  }
  const total = jobs.reduce((a, j) => a + j.weight, 0);
  let done = 0;
  onProgress(0, total, 'brush');
  await Promise.all(
    jobs.map(async (j) => {
      await j.run();
      done += j.weight;
      onProgress(done, total, j.label);
    }),
  );
  return out;
}
