import * as THREE from 'three';

export const INK = new THREE.Color('#1b1a17');
export const PAPER = new THREE.Color('#e8dcc4');

const NOISE_GLSL = /* glsl */ `
float inkHash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float inkNoise3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(inkHash3(i + vec3(0,0,0)), inkHash3(i + vec3(1,0,0)), f.x),
                 mix(inkHash3(i + vec3(0,1,0)), inkHash3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(inkHash3(i + vec3(0,0,1)), inkHash3(i + vec3(1,0,1)), f.x),
                 mix(inkHash3(i + vec3(0,1,1)), inkHash3(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

let gradientMap: THREE.DataTexture | null = null;
function toonGradient(): THREE.DataTexture {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array([105, 105, 105, 255, 178, 178, 178, 255, 236, 236, 236, 255, 255, 255, 255, 255]);
  gradientMap = new THREE.DataTexture(data, 4, 1, THREE.RGBAFormat);
  gradientMap.minFilter = THREE.NearestFilter;
  gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.generateMipmaps = false;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

export interface InkUniforms {
  uFlash: { value: THREE.Vector4 };
  uRim: { value: number };
  uTint: { value: THREE.Vector4 };
}

/**
 * Toon "ink & wash" material made from a glTF material.
 * Characters carry an albedo atlas (baseColorTexture) and an ink-control map in the emissive slot:
 *   R = light bias (0.5 neutral, lower forces ink shadow), G = sheen mask, B = inner ink lines.
 * Without textures it falls back to the material's flat colour.
 */
export function makeInkMaterial(src: THREE.Material, shared: InkUniforms): THREE.MeshToonMaterial {
  const s = src as THREE.MeshStandardMaterial;
  const map = s.map ?? null;
  const ink = map ? (s.emissiveMap ?? null) : null;
  if (ink) {
    ink.colorSpace = THREE.NoColorSpace;
    ink.needsUpdate = true;
  }
  const color = map ? new THREE.Color(1, 1, 1) : (s.color?.clone() ?? new THREE.Color(0.8, 0.8, 0.8));
  const mat = new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), map });
  mat.name = src.name;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFlash = shared.uFlash;
    sh.uniforms.uRim = shared.uRim;
    sh.uniforms.uTint = shared.uTint;
    sh.uniforms.uInk = { value: ink };
    if (ink) sh.defines = { ...(sh.defines ?? {}), USE_INKMAP: '' };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vInkPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvInkPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vInkPos;
uniform vec4 uFlash;
uniform float uRim;
uniform vec4 uTint;
${NOISE_GLSL}`,
      )
      .replace(
        '#include <gradientmap_pars_fragment>',
        `#ifdef USE_GRADIENTMAP
          uniform sampler2D gradientMap;
        #endif
        float inkBias = 0.0;
        vec3 getGradientIrradiance( vec3 normal, vec3 lightDirection ) {
          float dotNL = dot( normal, lightDirection );
          vec2 coord = vec2( clamp( dotNL * 0.5 + 0.5 + inkBias, 0.0, 1.0 ), 0.0 );
          #ifdef USE_GRADIENTMAP
            return vec3( texture2D( gradientMap, coord ).r );
          #else
            vec2 fw = fwidth( coord ) * 0.5;
            return mix( vec3( 0.7 ), vec3( 1.0 ), smoothstep( 0.7 - fw.x, 0.7 + fw.x, coord.x ) );
          #endif
        }
        #ifdef USE_INKMAP
          uniform sampler2D uInk;
        #endif`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 inkS = vec3(0.5, 0.0, 0.0);
        #if defined( USE_INKMAP ) && defined( USE_MAP )
          inkS = texture2D( uInk, vMapUv ).rgb;
          inkBias = ( inkS.r - 0.5 ) * 0.9;
        #endif`,
      )
      .replace(
        '#include <tonemapping_fragment>',
        `{
          vec3 V = normalize(vViewPosition);
          float rim = 1.0 - clamp(dot(normalize(normal), V), 0.0, 1.0);
          float wash = inkNoise3(vInkPos * 7.0) * 0.6 + inkNoise3(vInkPos * 23.0) * 0.4;
          vec3 col = gl_FragColor.rgb;
          col *= 0.92 + 0.12 * wash;
          col = mix(col, col * 1.28 + vec3(0.04), inkS.g * 0.55 * (0.4 + 0.6 * rim));
          col *= 1.0 - smoothstep(0.62, 0.98, rim) * uRim;
          col = mix(col, vec3(0.075, 0.07, 0.065), clamp(inkS.b, 0.0, 1.0) * 0.85);
          col = mix(col, uTint.rgb * col * 1.6, uTint.a);
          col = mix(col, uFlash.rgb, uFlash.a);
          gl_FragColor.rgb = col;
        }
        #include <tonemapping_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => (ink ? 'inkfist-ink-1' : 'inkfist-ink-0');
  return mat;
}

/**
 * Inverted-hull brush outline. Uses the character's `_OUTLINE` attribute when present (smoothed normal xyz so
 * seams don't crack, painted width w stored halved so it quantizes to bytes) and follows skinning + morph targets.
 */
export function makeOutlineMaterial(
  thicknessPx: { value: number },
  res: { value: THREE.Vector2 },
  color = INK,
  useAttr = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uThickness: thicknessPx, uRes: res, uColor: { value: color.clone() } },
    defines: useAttr ? { USE_OUTLINE_ATTR: '' } : {},
    side: THREE.BackSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <morphtarget_pars_vertex>
      #include <skinning_pars_vertex>
      uniform float uThickness;
      uniform vec2 uRes;
      #ifdef USE_OUTLINE_ATTR
        attribute vec4 _outline;
      #endif
      ${NOISE_GLSL}
      void main() {
        #include <morphinstance_vertex>
        #include <beginnormal_vertex>
        float wmul = 1.0;
        #ifdef USE_OUTLINE_ATTR
          objectNormal = _outline.xyz;
          wmul = _outline.w * 2.0;
        #endif
        #include <skinbase_vertex>
        #include <skinnormal_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
        vec3 nView = normalize(normalMatrix * objectNormal);
        vec2 dir = nView.xy;
        float l = length(dir);
        dir = l > 1e-4 ? dir / l : vec2(0.0);
        float n = inkNoise3(position * 11.0);
        float px = uThickness * (0.45 + 1.1 * n) * wmul;
        clip.xy += dir * px * 2.0 / uRes * clip.w;
        clip.z += 0.0005 * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }`,
  });
}

// ------------------------------------------------------------------ post process

export class InkPost {
  rt: THREE.WebGLRenderTarget;
  scene = new THREE.Scene();
  cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  mat: THREE.ShaderMaterial;
  u: Record<string, THREE.IUniform>;

  constructor(paper: THREE.Texture | undefined, speed: THREE.Texture | undefined, samples = 4) {
    this.rt = new THREE.WebGLRenderTarget(4, 4, { samples, type: THREE.HalfFloatType });
    if (paper) {
      paper.wrapS = paper.wrapT = THREE.RepeatWrapping;
      paper.needsUpdate = true;
    }
    this.u = {
      tColor: { value: this.rt.texture },
      tPaper: { value: paper ?? null },
      tSpeed: { value: speed ?? null },
      uHasPaper: { value: paper ? 1 : 0 },
      uHasSpeed: { value: speed ? 1 : 0 },
      uRes: { value: new THREE.Vector2(4, 4) },
      uTime: { value: 0 },
      uImpact: { value: 0 },
      uImpactInv: { value: 0 },
      uSpeed: { value: 0 },
      uSpeedCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uFlash: { value: 0 },
      uFlashColor: { value: new THREE.Color(1, 1, 1) },
      uBoil: { value: 1.0 },
      uRedKeep: { value: 1.0 },
      uGrey: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      depthTest: false,
      depthWrite: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tColor; uniform sampler2D tPaper; uniform sampler2D tSpeed;
        uniform float uHasPaper; uniform float uHasSpeed;
        uniform vec2 uRes; uniform float uTime; uniform float uImpact; uniform float uImpactInv;
        uniform float uSpeed; uniform vec2 uSpeedCenter; uniform float uFlash; uniform vec3 uFlashColor;
        uniform float uBoil; uniform float uGrey;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1.,0.)), f.x), mix(hash(i+vec2(0.,1.)), hash(i+vec2(1.,1.)), f.x), f.y); }
        float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
        void main(){
          float boil = floor(uTime * 8.0);
          vec2 wob = vec2(vnoise(vUv*vec2(11.0, 7.0) + boil*1.7), vnoise(vUv*vec2(8.0, 12.0) - boil*2.3)) - 0.5;
          vec2 uv = vUv + wob * uBoil * 2.4 / uRes;
          vec3 c = texture2D(tColor, uv).rgb;
          vec2 px = 1.6 / uRes;
          float l = luma(c);
          float lb = 0.0;
          lb += luma(texture2D(tColor, uv + vec2( px.x, 0.0)).rgb);
          lb += luma(texture2D(tColor, uv + vec2(-px.x, 0.0)).rgb);
          lb += luma(texture2D(tColor, uv + vec2(0.0,  px.y)).rgb);
          lb += luma(texture2D(tColor, uv + vec2(0.0, -px.y)).rgb);
          lb += luma(texture2D(tColor, uv + px * 2.0).rgb);
          lb += luma(texture2D(tColor, uv - px * 2.0).rgb);
          lb += luma(texture2D(tColor, uv + vec2(px.x, -px.y) * 2.0).rgb);
          lb += luma(texture2D(tColor, uv + vec2(-px.x, px.y) * 2.0).rgb);
          lb /= 8.0;
          float edge = clamp((lb - l) * 2.6, 0.0, 1.0);
          c *= 1.0 - edge * 0.32;
          float g = vnoise(gl_FragCoord.xy * 0.33) * 0.6 + vnoise(gl_FragCoord.xy * 1.4) * 0.4;
          c *= mix(1.0, 0.88 + 0.16 * g, smoothstep(0.75, 0.05, l));
          float redness = smoothstep(0.04, 0.2, c.r - max(c.g, c.b));
          vec3 grey = vec3(luma(c));
          c = mix(mix(grey, c, 0.78), c, redness);
          c = mix(c, grey, uGrey * (1.0 - redness));
          if (uHasPaper > 0.5) {
            vec3 paper = texture2D(tPaper, gl_FragCoord.xy / 1024.0).rgb;
            c *= mix(vec3(1.0), paper, 0.55);
          }
          c *= vec3(1.02, 1.0, 0.955);
          if (uSpeed > 0.001 && uHasSpeed > 0.5) {
            vec2 d = (vUv - uSpeedCenter) * vec2(uRes.x / uRes.y, 1.0);
            vec2 suv = d * 0.58 + 0.5;
            float a = texture2D(tSpeed, suv).a;
            c = mix(c, vec3(0.03, 0.028, 0.025), a * uSpeed);
          }
          vec2 q = vUv - 0.5;
          c *= 1.0 - dot(q, q) * 0.6;
          if (uImpact > 0.001) {
            float t = smoothstep(0.16, 0.24, luma(c));
            vec3 bw = mix(vec3(0.035, 0.03, 0.028), vec3(0.86, 0.80, 0.70), t);
            bw = mix(bw, vec3(0.9, 0.86, 0.78) - bw + vec3(0.03), uImpactInv);
            bw = mix(bw, vec3(0.55, 0.06, 0.05), redness * 0.85);
            c = mix(c, bw, uImpact);
          }
          c = mix(c, uFlashColor, uFlash);
          gl_FragColor = linearToOutputTexel(vec4(c, 1.0));
        }`,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setSize(w: number, h: number, pr: number): void {
    this.rt.setSize(Math.floor(w * pr), Math.floor(h * pr));
    (this.u.uRes.value as THREE.Vector2).set(Math.floor(w * pr), Math.floor(h * pr));
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.cam);
  }
}
