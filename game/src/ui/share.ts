import { GAME_TITLE, GAME_TITLE_HAN, GAME_URL, SHARE_HASHTAGS } from '../config';

export interface ShareResult {
  won: boolean;
  me: string;
  foe: string;
  foeKind: string; // 'AI (Gosu)' | 'online' | 'local'
  maxCombo: number;
  rank: string | null;
  deflects: number;
  perfect: boolean;
}

export function shareText(r: ShareResult): string {
  const brush = '🖌️';
  if (r.won) {
    const combo = r.maxCombo >= 3 ? ` with a ${r.maxCombo}-hit${r.rank ? ' ' + r.rank : ''} combo` : '';
    const perfect = r.perfect ? ' — PERFECT' : '';
    const foe = r.foeKind === 'online' ? `${r.foe} online` : r.foeKind.startsWith('AI') ? `${r.foe} (${r.foeKind})` : r.foe;
    return `${brush} I defeated ${foe} as ${r.me}${combo} in ${GAME_TITLE} ${GAME_TITLE_HAN}${perfect}.\nThink you're a real gosu? Come fight me 👊`;
  }
  return `${brush} ${r.foe} beat my ${r.me} in ${GAME_TITLE} ${GAME_TITLE_HAN}… but my best combo was ${r.maxCombo} hits. Rematch soon. Who's next? 👊`;
}

export function openXShare(text: string, link = GAME_URL, tags = SHARE_HASHTAGS): void {
  const url = new URL('https://x.com/intent/post');
  url.searchParams.set('text', text);
  url.searchParams.set('url', link);
  url.searchParams.set('hashtags', tags.join(','));
  window.open(url.toString(), '_blank', 'noopener,noreferrer,width=600,height=520');
}

/** Builds a 1200x675 victory card from a game frame. */
export async function victoryCard(frame: HTMLCanvasElement, title: string, lines: string[]): Promise<Blob | null> {
  const W = 1200, H = 675;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const sw = frame.width, sh = frame.height;
  const scale = Math.max(W / sw, H / sh);
  g.drawImage(frame, (W - sw * scale) / 2, (H - sh * scale) / 2, sw * scale, sh * scale);
  const grd = g.createLinearGradient(0, 0, W * 0.6, 0);
  grd.addColorStop(0, 'rgba(232,220,196,0.95)');
  grd.addColorStop(1, 'rgba(232,220,196,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#a3262a';
  g.font = '150px "Nanum Brush Script", serif';
  g.fillText(title, 50, 190);
  g.fillStyle = '#1b1a17';
  g.font = '700 30px "Noto Serif KR", serif';
  lines.forEach((l, i) => g.fillText(l, 56, 260 + i * 44));
  g.font = '90px "Nanum Brush Script", serif';
  g.fillText(`${GAME_TITLE} ${GAME_TITLE_HAN}`, 50, H - 50);
  g.font = '600 22px Inter, sans-serif';
  g.fillStyle = '#3a3730';
  g.fillText(GAME_URL.replace(/^https?:\/\//, ''), 56, H - 22);
  return new Promise((res) => c.toBlob((b) => res(b), 'image/jpeg', 0.9));
}

export async function shareCard(blob: Blob, text: string): Promise<boolean> {
  const file = new File([blob], 'inkfist-victory.jpg', { type: 'image/jpeg' });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], text: `${text}\n${GAME_URL}` });
      return true;
    } catch {
      return false;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'inkfist-victory.jpg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return true;
}
