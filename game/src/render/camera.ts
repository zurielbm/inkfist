import * as THREE from 'three';
import { Match } from '../sim/sim';
import { STAGE_HALF, U } from '../sim/defs';

const FOV = 30;

export class CameraRig {
  cam = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 400);
  x = 0;
  y = 1.6;
  dist = 9;
  shakeAmp = 0;
  shakeT = 0;
  punch = 0;
  cineBlend = 0;
  cineSide = 1;
  tilt = 0;
  /** wide cinematic framing (e.g. a palm falling from the sky) */
  cineWide = false;

  shake(amount: number): void {
    this.shakeAmp = Math.min(0.5, Math.max(this.shakeAmp, amount));
  }

  zoomPunch(amount: number): void {
    this.punch = Math.min(2.4, Math.max(this.punch, amount));
  }

  setAspect(a: number): void {
    this.cam.aspect = a;
    this.cam.updateProjectionMatrix();
  }

  snap(s: Match): void {
    this.update(s, 1, true);
  }

  update(s: Match, dt: number, snap = false): void {
    const [a, b] = s.f;
    const ax = a.x / U, bx = b.x / U;
    const ay = a.y / U, by = b.y / U;
    const sep = Math.abs(ax - bx);
    let tx = (ax + bx) / 2;
    let tDist = THREE.MathUtils.clamp(6.6 + sep * 0.62, 7.0, 11.8);
    const maxY = Math.max(ay, by);
    let ty = 1.45 + Math.max(0, maxY - 0.6) * 0.55;
    // keep inside the stage
    const halfW = tDist * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * this.cam.aspect;
    const lim = Math.max(0, STAGE_HALF / U + 0.6 - halfW);
    tx = THREE.MathUtils.clamp(tx, -lim, lim);

    // secret-art cinematic framing
    const cineTarget = s.cine >= 0 ? 1 : 0;
    this.cineBlend += (cineTarget - this.cineBlend) * Math.min(1, dt * 5);
    if (s.cine >= 0) this.cineSide = s.f[s.cine].facing;
    else if (this.cineBlend < 0.05) this.cineWide = false;
    if (this.cineBlend > 0.001) {
      const owner = s.f[Math.max(0, s.cine)];
      const ox = owner.x / U + this.cineSide * 0.4;
      tx = THREE.MathUtils.lerp(tx, ox, this.cineBlend);
      tDist = THREE.MathUtils.lerp(tDist, this.cineWide ? 10.5 : 4.6, this.cineBlend);
      ty = THREE.MathUtils.lerp(ty, this.cineWide ? 3.0 : 1.25, this.cineBlend);
    }
    tDist -= this.punch;
    const k = snap ? 1 : 1 - Math.pow(0.0009, dt);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
    this.dist += (tDist - this.dist) * (snap ? 1 : 1 - Math.pow(0.002, dt));
    this.punch *= Math.pow(0.004, dt);

    this.shakeT += dt * 60;
    const sh = this.shakeAmp;
    const sx = sh * (Math.sin(this.shakeT * 1.7) * 0.6 + Math.sin(this.shakeT * 3.1) * 0.4);
    const sy = sh * (Math.cos(this.shakeT * 2.3) * 0.6 + Math.sin(this.shakeT * 4.7) * 0.4);
    this.shakeAmp *= Math.pow(0.0015, dt);

    const orbit = this.cineBlend * 0.35 * this.cineSide;
    const camX = this.x + sx + Math.sin(orbit) * this.dist;
    const camZ = Math.cos(orbit) * this.dist;
    this.cam.position.set(camX, this.y + 0.25 + sy, camZ);
    this.cam.lookAt(this.x + sx * 0.5, this.y - 0.3 + sy * 0.5, 0);
    this.cam.rotateZ(this.tilt * this.cineBlend);
  }
}
