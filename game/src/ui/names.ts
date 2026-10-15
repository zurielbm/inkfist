export interface ArtInfo {
  key: string;
  name: string;
  han: string;
  desc: string;
}

export interface CharInfo {
  han: string;
  desc: string;
  stats: { Speed: number; Power: number; Reach: number; Health: number };
  arts: ArtInfo[];
  secret: { name: string; han: string };
  win: string[];
}

export const CHAR_INFO: Record<string, CharInfo> = {
  mujin: {
    han: '無盡',
    desc: 'A scarred wanderer who learned to fight in back alleys and on mountain roads. Relentless pressure, fast fists, whirling kicks.',
    stats: { Speed: 80, Power: 65, Reach: 45, Health: 60 },
    arts: [
      { key: 'I', name: 'Tiger Palm', han: '虎掌', desc: 'Twin-palm shock that bounces foes off walls.' },
      { key: '→ I', name: 'Shadow Step', han: '影步', desc: 'Vanish through your foe and strike from behind.' },
      { key: '↓ I', name: 'Rising Dragon', han: '昇龍', desc: 'Invincible rising uppercut. Beats jump-ins.' },
    ],
    secret: { name: 'Heaven-Splitting Fist', han: '天裂拳' },
    win: ['Is that all the murim has?', 'Next.', 'Not even a scratch… almost.'],
  },
  seolhwa: {
    han: '雪花',
    desc: 'Heir of the Crimson Plum sect. Her sleeves strike like whips from far away, and she moves like falling snow.',
    stats: { Speed: 70, Power: 50, Reach: 90, Health: 45 },
    arts: [
      { key: 'I', name: 'Silk Lash', han: '絲鞭', desc: 'Hurl a crimson sleeve across the arena.' },
      { key: '→ I', name: 'Floating Step', han: '浮步', desc: 'Glide in with an airborne kick.' },
      { key: '↓ I', name: 'Earth Bloom', han: '地花', desc: 'A stomp that cracks the earth all around her.' },
    ],
    secret: { name: 'Blood-Plum Storm', han: '血梅風' },
    win: ['Your stance was crooked.', 'Plum blossoms fall for no one.', 'Again? How tiresome.'],
  },
  hyeongong: {
    han: '玄功',
    desc: 'A temple guardian whose body is hard as bronze. Slow, armoured, and devastating up close.',
    stats: { Speed: 35, Power: 95, Reach: 50, Health: 95 },
    arts: [
      { key: 'I', name: 'Diamond Body', han: '金剛身', desc: 'Counter stance: absorb a blow and answer with a palm.' },
      { key: '→ I', name: 'Mountain Toss', han: '擲山', desc: 'Unblockable grab, lift and slam.' },
      { key: '↓ I', name: 'Bell Strike', han: '鐘擊', desc: 'Earth-shaking slam that hits downed foes.' },
    ],
    secret: { name: 'Tathāgata Palm', han: '如來掌' },
    win: ['Amitābha.', 'The mountain does not move.', 'Return when your heart is calm.'],
  },
};

export function moveDisplay(charId: string, move: string): { name: string; han: string } | null {
  const c = CHAR_INFO[charId];
  if (!c) return null;
  if (move === 'art_n') return c.arts[0];
  if (move === 'art_f') return c.arts[1];
  if (move === 'art_d') return c.arts[2];
  if (move === 'secret') return c.secret;
  if (move === 'focus_release') return { name: 'Focus Strike', han: '蓄勁' };
  if (move === 'counter') return { name: 'Diamond Counter', han: '反擊' };
  return null;
}

export function flowRank(hits: number, unique: number): { name: string; han: string } | null {
  const score = unique * 1.5 + hits * 0.5;
  if (score >= 18) return { name: 'GOSU', han: '高手' };
  if (score >= 14) return { name: 'Tempest', han: '嵐' };
  if (score >= 10) return { name: 'Torrent', han: '濤' };
  if (score >= 7) return { name: 'Current', han: '流' };
  if (score >= 4) return { name: 'Ripple', han: '波' };
  return null;
}

export const TIPS = [
  'Deflect beats Focus. Read the red glow.',
  'Prefer the arrow keys? Move with ← ↑ → ↓ and fight with Z X C V B N.',
  'Two layouts, always on: WASD + J K L U I O, or arrows + Z X C V B N. Gamepads work too.',
  'Tap Guard just before a hit lands to Deflect, and leave them open.',
  'Never repeat yourself: stale moves lose damage. Vary your chains to rise in Flow.',
  'Hold Heavy to charge a Focus strike. It crushes any guard.',
  'Strikes interrupt a charging Focus. Hit them before they glow.',
  'Double jump, air-dash and kick off the cliff walls. Qinggong is freedom.',
  'Down + Heavy in the air is a meteor dive. It leaves a crater.',
  'Stuck in a long combo? With two Qi bars, press Dodge to Burst free.',
  'Dodge can cancel a move after contact for half a Qi bar.',
  'Up + Strike launches. Hold Up after it connects to jump and chase.',
  'Three Qi bars unlock your Secret Art. Make it count.',
];
