import * as THREE from 'three';
import { Assets } from './assets';
import { CameraRig } from './camera';
import { Effects } from './effects';
import { FighterView } from './fighterView';
import { InkPost } from './ink';
import { StageView } from './stage';
import { Match, moveOf } from '../sim/sim';
import { CHARS } from '../sim/chars';
import { SimEvent, ST, U } from '../sim/defs';
import { audio } from '../audio/audio';

const LIGHT_WORDS = ['탁', '팍', 'TAK', 'PAK', '퍽'];
const MID_WORDS = ['BAM', '퍽!', 'WHAM', '빡'];
const HEAVY_WORDS = ['KWANG', '쾅!', 'CRACK', 'BAM!'];
const HUGE_WORDS = ['KWA-GANG', '콰광!', 'KUUUNG', '쿠웅!'];
const pick = (a: string[]) => a[(Math.random() * a.length) | 0];

export type HudListener = (e: SimEvent, s: Match) => void;

export class GameRenderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  rig = new CameraRig();
  post: InkPost;
  stage: StageView | null = null;
  fighters: FighterView[] = [];
  fx: Effects;
  outlinePx = { value: 2.0 };
  res = { value: new THREE.Vector2(1, 1) };
  impact = 0;
  impactInv = 0;
  speed = 0;
  speedCenter = new THREE.Vector2(0.5, 0.5);
  flash = 0;
  flashColor = new THREE.Color(1, 1, 1);
  grey = 0;
  projViews = new Map<number, THREE.Sprite>();
  listeners: HudListener[] = [];
  time = 0;
  sfxOn = true;
  cineHits = 0;
  lowQuality = false;
  private tmp = new THREE.Vector3();

  private play(id: Parameters<typeof audio.play>[0], opts?: Parameters<typeof audio.play>[1]): void {
    if (this.sfxOn) audio.play(id, opts);
  }
  private chargeTick = 0;

  /** phones/tablets: no MSAA, lower pixel-ratio cap, adaptive resolution */
  mobile: boolean;
  dynScale = 1;
  private perfAcc = 0;
  private perfN = 0;
  private goodWindows = 0;
  private lastT = performance.now();

  constructor(public canvas: HTMLCanvasElement, public assets: Assets, opts: { mobile?: boolean } = {}) {
    this.mobile = !!opts.mobile;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor('#e8dcc4');
    this.post = new InkPost(assets.tex.paper, assets.tex.speedlines, this.mobile ? 0 : 4);
    this.fx = new Effects(assets.tex);
    this.scene.add(this.fx.group);
    const hemi = new THREE.HemisphereLight('#fff6e6', '#5b5448', 1.6);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight('#fffaf0', 2.4);
    key.position.set(-3, 7, 9);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#f3e3c6', 0.8);
    rim.position.set(4, 3, -6);
    this.scene.add(rim);
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const cap = this.lowQuality ? 1 : this.mobile ? 1.5 : 2;
    const pr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, cap) * this.dynScale);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, pr);
    this.res.value.set(w * pr, h * pr);
    this.outlinePx.value = Math.max(1.4, 2.1 * (h * pr) / 1080) * 1.0;
    this.rig.setAspect(w / Math.max(1, h));
  }

  setMatch(charIds: string[], stageId: string): void {
    for (const f of this.fighters) f.removeFrom(this.scene);
    this.fighters = [];
    if (this.stage) this.scene.remove(this.stage.group);
    const st = this.assets.stages[stageId] ?? Object.values(this.assets.stages)[0];
    this.stage = new StageView(st);
    this.scene.add(this.stage.group);
    this.scene.background = this.stage.bg;
    for (const id of charIds) {
      const a = this.assets.chars[id] ?? Object.values(this.assets.chars)[0];
      const v = new FighterView(a, this.outlinePx, this.res);
      v.addTo(this.scene);
      this.fighters.push(v);
    }
    this.fx.clear();
    for (const p of this.projViews.values()) this.fx.group.remove(p);
    this.projViews.clear();
    this.prewarm();
  }

  /** Compile every effect shader up front so the first hit doesn't hitch. */
  private prewarm(): void {
    const far = new THREE.Vector3(0, -50, 0);
    this.fx.hit(far, 3, 1, true);
    this.fx.text('BAM', far, 0.5);
    this.fx.ring(far, '#b8893a', 1);
    this.fx.dust(far, 1);
    this.fx.debris(far, 1);
    this.fx.streak(far, 1);
    this.fx.crater(0, true);
    this.rig.update({ f: [{ x: 0, y: 0 }, { x: 0, y: 0 }], cine: -1 } as unknown as Match, 0);
    this.renderer.compile(this.scene, this.rig.cam);
    this.renderer.setRenderTarget(this.post.rt);
    this.renderer.render(this.scene, this.rig.cam);
    this.renderer.setRenderTarget(null);
    this.fx.clear();
  }

  // ------------------------------------------------------------------ events

  handleEvents(events: SimEvent[], s: Match): void {
    for (const e of events) {
      this.onEvent(e, s);
      for (const l of this.listeners) l(e, s);
    }
  }

  private worldPos(x: number, y: number, z = 0.35): THREE.Vector3 {
    return new THREE.Vector3(x / U, y / U, z);
  }

  private pan(x: number): number {
    return Math.max(-1, Math.min(1, (x / U - this.rig.x) / 5));
  }

  private onEvent(e: SimEvent, s: Match): void {
    switch (e.t) {
      case 'hit': {
        const pos = this.worldPos(e.x, e.y);
        const atk = s.f[e.atk];
        const p = e.power;
        this.fighters[e.def]?.hitFlash(p >= 3 ? '#f6ecd6' : '#ffffff', p >= 3 ? 4 : 2);
        const flowBoost = Math.min(1, e.flow / 10);
        if (e.kind === 'secret' && p < 5) {
          // cinematic flurry: light touches only, the finisher gets the big moment
          this.cineHits++;
          this.fx.hit(pos, 0, atk.facing, this.cineHits % 3 === 0);
          if (this.cineHits % 4 === 1) this.fx.text(pick(LIGHT_WORDS), pos.clone().add(new THREE.Vector3(atk.facing * 0.35, 0.35, 0)), 0.32);
          this.rig.shake(0.03);
          this.play('hit_light', { intensity: 0.5, pan: this.pan(e.x), volume: 0.75 });
          break;
        }
        this.fx.hit(pos, p, atk.facing, p >= 2);
        if (e.kind === 'secret') {
          this.cineHits = 0;
          this.fx.text(pick(HUGE_WORDS), pos.clone().add(new THREE.Vector3(0, 0.6, 0)), 1.1, '#8c1c1f');
        } else {
          const words = p >= 4 ? HUGE_WORDS : p >= 3 ? HEAVY_WORDS : p >= 2 ? MID_WORDS : LIGHT_WORDS;
          const size = 0.42 + p * 0.16 + flowBoost * 0.2;
          this.fx.text(pick(words), pos.clone().add(new THREE.Vector3(atk.facing * 0.25, 0.45, 0)), size, p >= 3 ? '#8c1c1f' : '#1b1a17');
        }
        this.rig.shake(0.02 + p * 0.03);
        if (p >= 3) this.rig.zoomPunch(0.25 * (p - 2));
        if (e.kind === 'focus' || e.counter || p >= 5) this.impactFrames(p >= 5 ? 7 : 3, e.counter ? 1 : 0);
        if (e.fx === 'speedlines' || e.fx === 'impact' || p >= 4) this.speedLines(pos, 0.9);
        if (p >= 3) this.fx.ring(pos, '#1b1a17', 0.8 + p * 0.25, 0.35);
        this.play(p >= 4 ? 'hit_focus' : p >= 2 ? 'hit_heavy' : 'hit_light', { intensity: Math.min(1, 0.4 + flowBoost * 0.6), pan: this.pan(e.x) });
        break;
      }
      case 'block': {
        const pos = this.worldPos(e.x, e.y);
        this.fx.hit(pos, 0, s.f[1 - e.def].facing, false);
        if (e.power >= 3) {
          this.fx.text('不動', pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.5, '#8c6a1f');
          this.fighters[e.def]?.hitFlash('#d9b45a', 3);
        } else this.fx.text('탁', pos.clone().add(new THREE.Vector3(0, 0.35, 0)), 0.35, '#5a564c');
        this.rig.shake(0.02 * e.power);
        this.play('block', { pan: this.pan(e.x), intensity: e.power / 3 });
        break;
      }
      case 'deflect': {
        const pos = this.worldPos(e.x, e.y);
        this.fx.ring(pos, '#b8893a', 1.6, 0.4);
        this.fx.text(Math.random() < 0.5 ? 'TING!' : '챙!', pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.6, '#7d5a1f');
        this.fighters[e.def]?.hitFlash('#f0d080', 4);
        this.impactFrames(3, 1);
        this.rig.shake(0.08);
        this.play('deflect', { pan: this.pan(e.x) });
        break;
      }
      case 'crush': {
        const pos = this.worldPos(e.x, e.y);
        this.fx.text('CRACK!', pos.clone().add(new THREE.Vector3(0, 0.5, 0)), 0.8, '#8c1c1f');
        this.fx.ring(pos, '#a3262a', 2.0, 0.5);
        this.fx.hit(pos, 4, s.f[1 - e.def].facing, true);
        this.impactFrames(4, 0);
        this.speedLines(pos, 1);
        this.rig.shake(0.2);
        this.rig.zoomPunch(0.8);
        this.play('guard_crush', { pan: this.pan(e.x) });
        break;
      }
      case 'whiff': {
        const f = s.f[e.who];
        this.play(e.kind === 'strike' ? 'whoosh_light' : 'whoosh_heavy', { pan: this.pan(f.x), volume: 0.8 });
        break;
      }
      case 'jump': {
        const f = s.f[e.who];
        this.play('jump', { pan: this.pan(f.x), volume: 0.7 });
        if (!e.double) this.fx.dust(this.worldPos(f.x, 0, 0.2), 1);
        else this.fx.ring(this.worldPos(f.x, f.y, 0.1), '#3a3730', 0.6, 0.3);
        break;
      }
      case 'land': {
        const f = s.f[e.who];
        this.play('land', { pan: this.pan(f.x), volume: e.hard ? 1 : 0.6 });
        this.fx.dust(this.worldPos(f.x, 0, 0.2), e.hard ? 3 : 1);
        if (e.hard) this.rig.shake(0.06);
        break;
      }
      case 'dash': {
        const f = s.f[e.who];
        this.play('dash', { pan: this.pan(f.x), volume: 0.8 });
        this.fx.streak(this.worldPos(f.x, f.y + 9000, 0.1), f.facing * (f.st === ST.DASH_B ? -1 : 1), 1.5, '#3a3730');
        this.fx.dust(this.worldPos(f.x, 0, 0.2), 1);
        break;
      }
      case 'qi':
        this.play('qi_ready', { volume: 0.7 });
        break;
      case 'art': {
        const f = s.f[e.who];
        this.fighters[e.who]?.hitFlash('#e8c060', 5);
        this.fx.ring(this.worldPos(f.x, f.y + 11000), '#b8893a', 1.8, 0.5);
        this.play('art_cast', { pan: this.pan(f.x) });
        break;
      }
      case 'charge':
        this.play('qi_charge', { pan: this.pan(s.f[e.who].x) });
        break;
      case 'burst': {
        const f = s.f[e.who];
        const pos = this.worldPos(f.x, f.y + 10000);
        this.fx.ring(pos, '#b8893a', 3.0, 0.55);
        this.fx.text('破!', pos.clone().add(new THREE.Vector3(0, 0.7, 0)), 0.8, '#7d5a1f');
        this.speedLines(pos, 0.7);
        this.rig.shake(0.15);
        this.play('qi_burst', { pan: this.pan(f.x) });
        break;
      }
      case 'wall': {
        const pos = this.worldPos(e.x, e.y, 0.2);
        this.fx.text('쾅!', pos, 0.8, '#1b1a17');
        this.fx.hit(pos, 3, e.x > 0 ? -1 : 1, false);
        this.fx.debris(pos, 6);
        this.rig.shake(0.18);
        this.play('slam', { pan: this.pan(e.x) });
        break;
      }
      case 'ground': {
        const big = e.fx === 'crater';
        this.fx.crater(e.x / U, big);
        const pos = this.worldPos(e.x, 0, 0.3);
        this.fx.debris(pos, big ? 14 : 6);
        this.fx.dust(pos, big ? 4 : 2);
        if (big) this.fx.text(Math.random() < 0.5 ? 'KUUUNG' : '쿠웅!', pos.clone().add(new THREE.Vector3(0, 1.0, 0)), 0.9);
        this.rig.shake(big ? 0.28 : 0.14);
        this.play(big ? 'crater' : 'slam', { pan: this.pan(e.x) });
        break;
      }
      case 'proj':
        this.play('projectile', { pan: this.pan(s.f[e.who].x) });
        break;
      case 'grab': {
        const f = s.f[e.who];
        this.fx.text('잡았다!', this.worldPos(f.x, f.y + 19000), 0.6, '#8c1c1f');
        this.play('hit_heavy', { pan: this.pan(f.x), intensity: 0.4 });
        break;
      }
      case 'secret': {
        const f = s.f[e.who];
        if (e.phase === 'start') {
          this.play('secret_start');
          audio.duck(0.3, 3.5);
          this.fighters[e.who]?.hitFlash('#a3262a', 8);
          this.fx.ring(this.worldPos(f.x, f.y + 11000), '#a3262a', 2.6, 0.6);
        } else if (e.phase === 'connect') {
          this.flash = 0.65;
          this.flashColor.set('#f4ecdb');
          this.speedLines(this.worldPos(f.x, 12000), 1);
          if (CHARS[f.ch].id === 'hyeongong') {
            this.rig.cineWide = true;
            this.palmFromSky(f.x / U + f.facing * 0.75);
          }
        } else {
          this.impactFrames(8, 0);
          this.speedLines(this.worldPos(s.f[1 - e.who].x, 10000), 1);
          this.rig.shake(0.45);
          this.rig.zoomPunch(1.4);
          this.play('secret_hit');
        }
        break;
      }
      case 'round':
        this.play('round_call');
        this.fx.clear();
        break;
      case 'fight':
        this.play('fight_call');
        break;
      case 'ko':
        this.play('ko');
        if (this.sfxOn) audio.setSlowmo(0.45);
        this.impactFrames(6, 1);
        this.grey = 1;
        this.rig.zoomPunch(1.2);
        break;
      case 'timeout':
        this.play('ko');
        break;
      case 'roundWin':
        audio.setSlowmo(1);
        this.grey = 0;
        break;
      case 'match':
        audio.setSlowmo(1);
        this.grey = 0;
        break;
    }
  }

  impactFrames(frames: number, invert: number): void {
    this.impact = Math.max(this.impact, frames);
    this.impactInv = invert;
  }

  speedLines(pos: THREE.Vector3, amount: number): void {
    this.speed = Math.max(this.speed, amount);
    const p = pos.clone().project(this.rig.cam);
    this.speedCenter.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
  }

  /** Iron Monk's Tathagata Palm: a giant ink palm crashing down. */
  palmFromSky(x: number): void {
    const t = this.assets.tex.palm ?? this.fx.splats[1];
    // descends over ~1 s so it lands on the finishing blow
    // fingers point down: the palm presses down from the heavens
    const p = this.fx.sprite(t, '#ffffff', 3.3, new THREE.Vector3(x, 8.2, -0.3), {
      life: 1.35, vel: new THREE.Vector3(0, -3.5, 0), grow: 0.06, aspect: 640 / 900, rot: Math.PI,
    });
    p.gravity = 8;
    p.fadeAt = 0.85;
  }

  // ------------------------------------------------------------------ per frame

  /** Adaptive resolution: drop pixel ratio when frames run long, recover slowly when there is headroom. */
  private adapt(): void {
    const now = performance.now();
    const real = (now - this.lastT) / 1000;
    this.lastT = now;
    if (real > 0.25) return; // tab switch / hitch
    this.perfAcc += real;
    this.perfN++;
    if (this.perfAcc < 2) return;
    const avg = this.perfAcc / this.perfN;
    this.perfAcc = 0;
    this.perfN = 0;
    if (avg > 1 / 45 && this.dynScale > 0.55) {
      this.dynScale = Math.max(0.55, this.dynScale - 0.15);
      this.goodWindows = 0;
      this.resize();
    } else if (avg < 1 / 57) {
      if (++this.goodWindows >= 3 && this.dynScale < 1) {
        this.dynScale = Math.min(1, this.dynScale + 0.1);
        this.goodWindows = 0;
        this.resize();
      }
    } else this.goodWindows = 0;
  }

  render(s: Match, dt: number, simFrames: number): void {
    this.adapt();
    this.time += dt;
    // fighters
    for (let i = 0; i < this.fighters.length; i++) {
      this.fighters[i].update(s.f[i], s, dt, simFrames > 0);
      // charge aura
      const f = s.f[i];
      if (f.st === ST.FOCUS_CHARGE && simFrames > 0) {
        this.chargeTick += simFrames;
        if (this.chargeTick % 6 < simFrames) {
          const pos = this.worldPos(f.x, f.y + 9000 + Math.random() * 6000, 0.3);
          pos.x += (Math.random() - 0.5) * 0.7;
          this.fx.sprite(this.fx.splats[(Math.random() * 4) | 0], '#a3262a', 0.18 + Math.random() * 0.2, pos, {
            life: 0.5, vel: new THREE.Vector3(0, 1.4, 0), grow: 0.6, rot: Math.random() * 6,
          });
        }
      }
      if (f.qi >= 300 && simFrames > 0 && Math.random() < 0.08 * simFrames) {
        const pos = this.worldPos(f.x, f.y + Math.random() * 16000, 0.2);
        pos.x += (Math.random() - 0.5) * 0.6;
        this.fx.sprite(this.fx.splats[(Math.random() * 4) | 0], '#b8893a', 0.1 + Math.random() * 0.12, pos, {
          life: 0.7, vel: new THREE.Vector3(0, 1.0, 0), grow: 0.4,
        });
      }
      if (f.st === ST.ATTACK && simFrames > 0) {
        const md = moveOf(f);
        if (md && md.passThrough && f.sf >= md.passThrough[0] && f.sf <= md.passThrough[1] && f.sf % 3 === 0) {
          this.fx.streak(this.worldPos(f.x, f.y + 10000, 0.0), f.facing, 1.8, '#1b1a17');
        }
      }
    }
    this.syncProjectiles(s);
    this.fx.update(dt);
    this.rig.update(s, dt);

    // post uniforms
    const u = this.post.u;
    u.uTime.value = this.time;
    if (simFrames > 0) {
      this.impact = Math.max(0, this.impact - simFrames);
    }
    u.uImpact.value = this.impact > 0 ? 1 : 0;
    u.uImpactInv.value = this.impactInv;
    this.speed = Math.max(0, this.speed - dt * 2.2);
    u.uSpeed.value = Math.min(1, this.speed);
    (u.uSpeedCenter.value as THREE.Vector2).copy(this.speedCenter);
    this.flash = Math.max(0, this.flash - dt * 3);
    u.uFlash.value = this.flash;
    (u.uFlashColor.value as THREE.Color).copy(this.flashColor);
    const greyTarget = s.phase === 3 ? this.grey * 0.85 : 0;
    u.uGrey.value += (greyTarget - u.uGrey.value) * Math.min(1, dt * 4);
    this.post.render(this.renderer, this.scene, this.rig.cam);
  }

  private syncProjectiles(s: Match): void {
    const alive = new Set<number>();
    for (const p of s.proj) {
      alive.add(p.id);
      let spr = this.projViews.get(p.id);
      if (!spr) {
        const t = this.assets.tex.brush_stroke ?? this.fx.splats[0];
        const mat = new THREE.SpriteMaterial({ map: t, color: '#a3262a', transparent: true, depthWrite: false });
        mat.rotation = p.vx < 0 ? Math.PI : 0;
        spr = new THREE.Sprite(mat);
        spr.scale.set(1.5, 0.34, 1);
        spr.renderOrder = 12;
        this.fx.group.add(spr);
        this.projViews.set(p.id, spr);
      }
      spr.position.set(p.x / U, p.y / U, 0.25);
      spr.material.opacity = Math.min(1, p.life / 8);
      if (Math.random() < 0.5) {
        this.fx.sprite(this.fx.splats[(Math.random() * 4) | 0], '#a3262a', 0.12 + Math.random() * 0.1,
          spr.position.clone().add(new THREE.Vector3(-Math.sign(p.vx) * 0.6, (Math.random() - 0.5) * 0.2, 0)), { life: 0.35, grow: 0.3 });
      }
    }
    for (const [id, spr] of this.projViews) {
      if (!alive.has(id)) {
        this.fx.group.remove(spr);
        spr.material.dispose();
        this.projViews.delete(id);
      }
    }
  }
}
