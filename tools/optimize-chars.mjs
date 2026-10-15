// Optimise raw Blender character exports (game/assets-src/chars/*.glb) into game/public/assets/chars/:
// drop redundant animation keys, then meshopt-compress + quantise. Run: npm run optimize
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'game');
const src = join(root, 'assets-src', 'chars');
const dst = join(root, 'public', 'assets', 'chars');
const tmp = join(root, 'node_modules', '.cache', 'glb');
mkdirSync(tmp, { recursive: true });
const cli = join(root, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');
for (const f of readdirSync(src).filter((n) => n.endsWith('.glb'))) {
  const mid = join(tmp, f);
  execFileSync(process.execPath, [cli, 'resample', join(src, f), mid, '--tolerance', '0.0005'], { stdio: 'ignore' });
  // the `_OUTLINE` attribute (normal xyz + halved width, all in [-1, 1]) as normalized bytes: meshopt's 'high'
  // level leaves custom attributes as floats
  execFileSync(process.execPath, [cli, 'quantize', mid, mid, '--pattern', '_OUTLINE', '--quantize-generic', '8'],
    { stdio: 'ignore' });
  execFileSync(process.execPath, [cli, 'meshopt', mid, join(dst, f), '--level', 'high'], { stdio: 'ignore' });
  console.log(`${f}: ${(statSync(join(src, f)).size / 1024).toFixed(0)} KB -> ${(statSync(join(dst, f)).size / 1024).toFixed(0)} KB`);
}
