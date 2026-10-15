import { Match } from '../sim/sim';
import { CHARS } from '../sim/chars';
import { FPS, PH, QI_BAR, ROUNDS_TO_WIN, SimEvent, ST } from '../sim/defs';
import { CHAR_INFO, flowRank, moveDisplay } from './names';

interface SideEls {
  fill: HTMLElement;
  lag: HTMLElement;
  hp: HTMLElement;
  qi: HTMLElement;
  qiB: HTMLElement[];
  qiI: HTMLElement[];
  combo: HTMLElement;
  pips: HTMLElement[];
}

export class Hud {
  root = document.getElementById('hud')!;
  sides: SideEls[] = [];
  timer!: HTMLElement;
  announce!: HTMLElement;
  net!: HTMLElement;
  warn!: HTMLElement;
  extra!: HTMLElement;
  lag = [1, 1];
  lagHold = [0, 0];
  comboT = [0, 0];
  last = { timer: -1 };
  names: [string, string] = ['', ''];
  /** which side(s) are local players, for VICTORY/DEFEAT wording */
  localSide: number | null = null;

  build(s: Match, names: [string, string], localSide: number | null): void {
    this.names = names;
    this.localSide = localSide;
    const side = (i: number) => {
      const c = CHARS[s.f[i].ch];
      const label = names[i] ? `<small>${esc(names[i])}</small>` : '';
      return `
      <div class="hside ${i === 0 ? 'l' : 'r'}">
        <div class="hp"><div class="clip"><i class="lag"></i><i class="fill"></i></div></div>
        <div class="hname">${i === 0 ? `${c.name} <span style="color:var(--crimson)">${c.nameKo}</span> ${label}` : `${label} <span style="color:var(--crimson)">${c.nameKo}</span> ${c.name}`}</div>
        <div class="qi"><b><i></i></b><b><i></i></b><b><i></i></b></div>
      </div>`;
    };
    const pips = (i: number) => Array.from({ length: ROUNDS_TO_WIN }, () => `<i data-p="${i}"></i>`).join('');
    this.root.innerHTML = `
      <div class="hud-top">
        ${side(0)}
        <div><div class="timer">60</div><div class="pips">${pips(0)}<span class="gap"></span>${pips(1)}</div></div>
        ${side(1)}
      </div>
      <div class="combo l"></div><div class="combo r"></div>
      <div class="announce"></div>
      <div class="netinfo"></div>
      <div class="netwarn hidden"></div>
      <div class="hud-extra"></div>`;
    this.sides = [0, 1].map((i) => {
      const el = this.root.querySelectorAll('.hside')[i] as HTMLElement;
      return {
        fill: el.querySelector('.fill') as HTMLElement,
        lag: el.querySelector('.lag') as HTMLElement,
        hp: el.querySelector('.hp') as HTMLElement,
        qi: el.querySelector('.qi') as HTMLElement,
        qiB: [...el.querySelectorAll('.qi b')] as HTMLElement[],
        qiI: [...el.querySelectorAll('.qi b i')] as HTMLElement[],
        combo: this.root.querySelectorAll('.combo')[i] as HTMLElement,
        pips: [...this.root.querySelectorAll(`.pips i[data-p="${i}"]`)] as HTMLElement[],
      };
    });
    this.timer = this.root.querySelector('.timer') as HTMLElement;
    this.announce = this.root.querySelector('.announce') as HTMLElement;
    this.net = this.root.querySelector('.netinfo') as HTMLElement;
    this.warn = this.root.querySelector('.netwarn') as HTMLElement;
    this.extra = this.root.querySelector('.hud-extra') as HTMLElement;
    this.lag = [1, 1];
    this.last.timer = -1;
  }

  show(on: boolean): void {
    this.root.classList.toggle('hidden', !on);
  }

  update(s: Match, dt: number): void {
    if (!this.sides.length) return;
    for (let i = 0; i < 2; i++) {
      const f = s.f[i];
      const c = CHARS[f.ch];
      const hp = f.hp / c.hp;
      const el = this.sides[i];
      el.fill.style.width = `${(hp * 100).toFixed(2)}%`;
      el.hp.classList.toggle('low', hp < 0.25);
      const inCombo = f.comboHits > 0 && (f.st === ST.HITSTUN || f.st === ST.AIR_HIT || f.st === ST.WALL || f.st === ST.DOWN || f.st === ST.CINE_VICTIM || f.st === ST.CRUMPLE);
      if (inCombo) this.lagHold[i] = 0.5;
      else this.lagHold[i] -= dt;
      if (this.lagHold[i] <= 0 || hp > this.lag[i]) this.lag[i] += (hp - this.lag[i]) * Math.min(1, dt * 4);
      if (this.lag[i] < hp) this.lag[i] = hp;
      el.lag.style.width = `${(this.lag[i] * 100).toFixed(2)}%`;
      for (let b = 0; b < 3; b++) {
        const v = Math.max(0, Math.min(1, (f.qi - b * QI_BAR) / QI_BAR));
        el.qiI[b].style.width = `${v * 100}%`;
        el.qiB[b].classList.toggle('full', v >= 1);
      }
      el.qi.classList.toggle('max', f.qi >= 3 * QI_BAR);
      el.pips.forEach((p, k) => p.classList.toggle('w', k < f.rounds));
      // combo visibility (shown on the attacker's side)
      const victim = s.f[1 - i];
      const ce = this.sides[i].combo;
      if (victim.comboHits >= 2 && this.comboT[i] > 0) {
        ce.classList.add('show');
      }
      this.comboT[i] -= dt;
      if (this.comboT[i] <= 0) ce.classList.remove('show');
    }
    const secs = Math.ceil(s.timer / FPS);
    if (secs !== this.last.timer) {
      this.last.timer = secs;
      this.timer.textContent = String(Math.max(0, secs));
      this.timer.classList.toggle('urgent', secs <= 10 && s.phase === PH.FIGHT);
    }
  }

  netInfo(text: string): void {
    this.net.textContent = text;
  }

  netWarn(text: string | null): void {
    this.warn.classList.toggle('hidden', !text);
    if (text) this.warn.textContent = text;
  }

  big(html: string, cls = '', ms = 1300): void {
    const d = document.createElement('div');
    d.className = `big ${cls}`;
    d.innerHTML = html;
    this.announce.innerHTML = '';
    this.announce.appendChild(d);
    if (!cls.includes('stay')) setTimeout(() => d.remove(), ms);
  }

  clearAnnounce(): void {
    this.announce.innerHTML = '';
  }

  callout(side: number, name: string, han: string): void {
    const d = document.createElement('div');
    d.className = `callout ${side === 0 ? 'l' : 'r'}`;
    d.innerHTML = `<span class="han">${han}</span>${name}`;
    this.root.appendChild(d);
    setTimeout(() => d.remove(), 1500);
  }

  event(e: SimEvent, s: Match): void {
    switch (e.t) {
      case 'hit': {
        if (e.hits >= 2) {
          const i = e.atk;
          const ce = this.sides[i]?.combo;
          if (!ce) break;
          const rank = flowRank(e.hits, e.flow);
          const dmg = s.f[e.def].comboDmg;
          ce.innerHTML = `<div class="n">${e.hits}<small>HITS</small></div>${rank ? `<div class="rank">${rank.name} ${rank.han}</div>` : ''}<div class="dmg">${dmg} dmg · ${e.flow} styles</div>`;
          ce.classList.remove('bump');
          void ce.offsetWidth;
          ce.classList.add('bump', 'show');
          this.comboT[i] = 1.6;
        }
        break;
      }
      case 'art': {
        const id = CHARS[s.f[e.who].ch].id;
        const d = moveDisplay(id, e.move);
        if (d && e.move !== 'secret') this.callout(e.who, d.name, d.han);
        break;
      }
      case 'deflect':
        this.callout(e.def, 'Deflect', '化勁');
        break;
      case 'crush':
        this.callout(1 - e.def, 'Guard Crush', '破防');
        break;
      case 'burst':
        this.callout(e.who, 'Qi Burst', '爆氣');
        break;
      case 'round':
        this.big(`Round ${e.n}<small>第${['一', '二', '三', '四', '五'][e.n - 1] ?? e.n}合</small>`);
        break;
      case 'fight':
        this.big('Fight!<small>싸워라</small>', 'red', 900);
        break;
      case 'ko': {
        const L = s.f[e.loser];
        this.big(e.perfect ? 'Perfect<small>完勝</small>' : 'K.O.<small>擊破</small>', 'red', 1600);
        void L;
        break;
      }
      case 'timeout':
        this.big('Time<small>時間</small>', '', 1400);
        break;
      case 'match': {
        const w = s.f[e.winner];
        const id = CHARS[w.ch].id;
        let title: string;
        if (this.localSide === null) title = `${CHARS[w.ch].name} Wins<small>${CHAR_INFO[id]?.han ?? ''} 勝</small>`;
        else title = e.winner === this.localSide ? 'Victory<small>勝利</small>' : 'Defeat<small>敗北</small>';
        this.big(title, e.winner === this.localSide || this.localSide === null ? 'red stay' : 'stay');
        break;
      }
    }
  }
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
