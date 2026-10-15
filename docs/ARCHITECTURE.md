# INKFIST 墨拳 — architecture & conventions

Browser 1v1 murim fighting game. Ink-wash / watercolour manhwa look (reference: *Gosu* manhwa).
Plan: https://pages.subir.dev/8b5438bd-f1e6-44ae-a621-9fc8b3e0c109/

## Layout

```
blender/            Blender 5.2 Python scripts that generate every art asset (run headless)
  rig/              shared skeleton, mesh helpers, pose library, glTF export (characters)
  stage/            stage background layers, floor, textures
game/               Vite + TypeScript + Three.js client
  public/assets/    generated assets (committed): chars/, stage/, tex/, ui/
  src/sim/          deterministic simulation (integer math, no Math.sin/cos/random)
  src/net/          PeerJS transport, matchmaking, rollback session
  src/render/       Three.js scene, ink shaders, effects, camera
  src/ui/           DOM screens (loading, menu, select, HUD, results)
  src/audio/        procedural WebAudio (no audio files)
  src/input/        keyboard / gamepad / touch → 16-bit input masks
server/             self-hosted server: agent arena, leaderboards, replays, optional relay (Docker)
docs/               plan + this file
```

Blender: `"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P <script.py> -- <args>`
GPU: RTX 3060 (Cycles OPTIX/CUDA available, EEVEE works headless). numpy is available inside Blender.

## World units (render side)

- Metres. Y up (glTF/Three). Fighters stand on y = 0 and fight along the X axis on the line z = 0.
- Arena walls at x = ±8 (cliff edges / rock pillars). Typical camera view width at z = 0 is 7–10 m.
- Camera: perspective, vertical FOV ≈ 30°, at z ≈ +10, y ≈ 1.7, looking at y ≈ 1.2 (slightly down).
  It pans in X (clamped) and zooms on big hits.
- Stage backdrop = painted layers on quads behind the arena, with parallax:
  sky ~z=-60, far ~z=-40, mid ~z=-20, near ~z=-9. Floor = textured plane y=0 from z=-9 to z=+4.
  Described by `game/public/assets/stage/<stage>/stage.json` (see stage README).

## Sim units

- Integer only. 1 unit = 0.1 mm (10000 units per metre). 60 Hz fixed step.

## Palette

| name | hex | use |
|---|---|---|
| paper | #e8dcc4 | rice paper base |
| paper-light | #efe6d2 | highlights / UI panels |
| ink | #1b1a17 | lines, deepest wash |
| ink-2 | #3a3730 | |
| wash | #8a8578 | mid wash grey |
| crimson | #a3262a | accents, blood, robes |
| gold | #b8893a | Qi, trim |
| steel | #5d6a73 | Mu-jin coat |
| lavender | #a99bbd | Seol-hwa dress |
| saffron | #c77b2b | monk robe |
| jade | #4f7a62 | rare accent |

Scenes are mostly desaturated (paper + ink washes); saturated crimson/gold are reserved for accents.

## Characters (glTF)

- One `.glb` per character in `game/public/assets/chars/<id>.glb` (meshopt + quantized, ≤ 1.6 MB), plus `<id>.json`
  metadata (clip timing markers, spring chains, collider capsules).
- Bodies derive from the CC0 Blender Studio Human Base Meshes (see `blender/README.md`); three meshes per fighter
  (`<id>_body`, `<id>_head`, `<id>_hair`) sharing one material.
- Shared skeleton bone names (no dots — Three sanitises them): `root, hips, spine, chest, neck, head,
  shoulder_L, upper_arm_L, forearm_L, hand_L, thigh_L, shin_L, foot_L` (+ `_R`), finger bones
  `{thumb,index,middle,ring,pinky}_{1,2,3}_{L,R}`, `forearm_twist_{L,R}`, plus per-character secondary chains
  (`hair_*`, `cloth_*`, `scarf_*`, `sleeve_*`, `sash_*`, `beads_*`…) driven by springs in-game.
- Clips key only the deform bones (sampled LINEAR, rest-pose channels dropped); grips are baked into finger channels.
- The head mesh carries morph targets `blink, glare, pain, shout, smirk`, driven by the fighter's state
  (`fighterView.updateExpression`).
- Material: base colour = 2048 albedo; the emissive slot carries the 1024 **ink map** (R light bias shifting the toon
  ramp, G sheen, B inner lines), read by `render/ink.ts`. Vertex attribute `_OUTLINE` = smoothed normal xyz +
  halved outline width (normalized bytes) for the inverted-hull outline, which follows skinning and morphs.
- `colliders` in the metadata: capsules on body bones (radius, bone length) that hair/cloth chains are pushed out of.
- Character faces Blender −Y (glTF +Z). Character's left is Blender +X.

## Character ids

`mujin` (Mu-jin 무진, the Wild Fist), `seolhwa` (Seol-hwa 설화, the Crimson Sleeve),
`hyeongong` (Hyeon-gong 현공, the Iron Monk). Stretch: `baekun` (Elder Baek-un 백운).
