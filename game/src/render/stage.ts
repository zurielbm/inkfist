import * as THREE from 'three';
import { StageAsset } from './assets';

export class StageView {
  group = new THREE.Group();
  floor: THREE.Mesh | null = null;
  bg = new THREE.Color('#e8dcc4');

  constructor(stage: StageAsset | undefined) {
    if (stage) this.build(stage);
    else this.buildFallback();
  }

  private build(st: StageAsset): void {
    const j = st.json;
    this.bg.set(j.bg || '#e8dcc4');
    const layers = [...j.layers].sort((a, b) => a.z - b.z);
    let order = -100;
    for (const l of layers) {
      const tex = st.tex[l.src];
      if (!tex) continue;
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(l.width, l.height), mat);
      mesh.position.set(0, l.centerY, l.z);
      mesh.renderOrder = order++;
      this.group.add(mesh);
    }
    const fl = j.floor;
    const ftex = fl && st.tex[fl.src];
    if (fl && ftex) {
      const width = 80;
      const depth = fl.zNear - fl.zFar;
      ftex.wrapS = THREE.RepeatWrapping;
      ftex.wrapT = THREE.ClampToEdgeWrapping;
      ftex.repeat.set(width / fl.tileWidth, 1);
      ftex.offset.set(0.5 - (width / fl.tileWidth) / 2, 0);
      ftex.needsUpdate = true;
      const mat = new THREE.MeshBasicMaterial({ map: ftex, transparent: true, depthWrite: true });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(0, 0, (fl.zNear + fl.zFar) / 2);
      mesh.renderOrder = -10;
      this.floor = mesh;
      this.group.add(mesh);
    } else {
      this.addFallbackFloor();
    }
  }

  private buildFallback(): void {
    const c = document.createElement('canvas');
    c.width = 1024;
    c.height = 512;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, '#d7cbb1');
    grd.addColorStop(1, '#ece2cd');
    g.fillStyle = grd;
    g.fillRect(0, 0, 1024, 512);
    g.fillStyle = 'rgba(163,38,42,0.75)';
    g.beginPath();
    g.arc(760, 150, 46, 0, Math.PI * 2);
    g.fill();
    const ridge = (base: number, amp: number, col: string, seed: number) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(0, 512);
      for (let x = 0; x <= 1024; x += 8) {
        const y = base - amp * (0.5 + 0.5 * Math.sin(x * 0.008 + seed) * Math.sin(x * 0.0031 + seed * 2.1)) - 18 * Math.sin(x * 0.05 + seed);
        g.lineTo(x, y);
      }
      g.lineTo(1024, 512);
      g.fill();
    };
    ridge(330, 160, 'rgba(150,143,128,0.45)', 1.3);
    ridge(400, 120, 'rgba(95,90,80,0.55)', 2.7);
    ridge(470, 70, 'rgba(50,48,43,0.7)', 4.1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(70, 35), new THREE.MeshBasicMaterial({ map: tex, depthWrite: false }));
    mesh.position.set(0, 6, -35);
    mesh.renderOrder = -100;
    this.group.add(mesh);
    this.addFallbackFloor();
  }

  private addFallbackFloor(): void {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 256;
    const g = c.getContext('2d')!;
    const grd = g.createLinearGradient(0, 0, 0, 256);
    grd.addColorStop(0, '#ddd2bb');
    grd.addColorStop(1, '#8f897b');
    g.fillStyle = grd;
    g.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(40,38,34,${Math.random() * 0.08})`;
      g.fillRect(Math.random() * 512, Math.random() * 256, Math.random() * 60, Math.random() * 4);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(6, 1);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(80, 15), new THREE.MeshBasicMaterial({ map: tex }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, 0, -2);
    mesh.renderOrder = -10;
    this.floor = mesh;
    this.group.add(mesh);
  }
}
