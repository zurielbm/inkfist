import { Assets, assetUrl, loadAssets } from './render/assets';
import { GameRenderer } from './render/renderer';
import { Hud, esc } from './ui/hud';
import { CHARS, CHAR_IDS } from './sim/chars';
import { Match, createMatch, hashMatch, step } from './sim/sim';
import { FPS, PH, ROUND_FRAMES, SimEvent, ST } from './sim/defs';
import { AIController, DIFFICULTY_NAMES, Difficulty } from './ai/ai';
import {
  GamepadInput, InputSource, KeyboardInput, KeyScheme, MergedInput, P1_KEYS, P1_SOLO_EXTRA, P2_KEYS, TouchInput, installKeyboard,
  keyScheme, onKeyScheme, pollMenuPad,
} from './input/input';
import { audio } from './audio/audio';
import { installNavKeys, navEnabled, navKey, navScope } from './ui/nav';
import { CHAR_INFO, TIPS, flowRank } from './ui/names';
import { isTouchDevice, playerName, saveSettings, settings, touchEnabled } from './ui/settings';
import { buildTouch, enterFullscreen, isFullscreen, layoutTouch, showTouch, touchHaptic, updateTouch } from './ui/touch';
import { openXShare, shareCard, shareText, victoryCard } from './ui/share';
import { GAME_URL, SPONSOR, TIP_LABEL, TIP_URL } from './config';
import { hostRoom, joinRoom, quickMatch } from './net/matchmaking';
import { Link } from './net/link';
import { handshake } from './net/online';
import { RollbackSession } from './net/rollback';
import { arenaBase, arenaEnabled, arenaId, bouts, duelState, ensureAccount, leaderboard, manualUrl, submitRanked, DuelState, ResultStatus } from './arena/client';
import { PromptMode, agentPrompt } from './arena/manual';
import { HumanClaim, VerifyJob, rankedHouseAI } from './arena/replay';
import { rleEncode } from './arena/rle';
import { WatchRun } from './arena/watch';
import { BOARD_TABS, PROMPT_MODES, boardRows, boutRows, challengeText, labelHtml, openRows, randomDuelCode } from './ui/arena';

type Mode = 'attract' | 'ai' | 'local' | 'online' | 'training' | 'watch';
type SelectKind = 'ai' | 'local' | 'training' | 'quick' | 'room';
const STEP = 1 / FPS;
const STAGES = ['cloudpeak', 'bamboo'];

interface LocalRun {
  s: Match;
  inputs: [(s: Match) => number, (s: Match) => number];
}

/** Inputs of a match that may be submitted to the arena leaderboards. */
interface RankedRec {
  kind: 'ai' | 'pvp';
  seed: number;
  p1: number;
  p2: number;
  level?: Difficulty;
  /** the human's input bits for each simulated frame (Versus AI) */
  bits: number[];
}

interface OnlineRun {
  sess: RollbackSession;
  seed: number;
  p1: number;
  p2: number;
  oppAid: string | null;
  link: Link;
  localSide: number;
  names: [string, string];
  rematchMe: boolean;
  rematchThem: boolean;
  host: boolean;
  myChar: number;
  stage: string;
  gone: boolean;
}

export class App {
  assets!: Assets;
  r!: GameRenderer;
  hud = new Hud();
  mode: Mode | null = null;
  run: LocalRun | null = null;
  online: OnlineRun | null = null;
  paused = false;
  acc = 0;
  last = performance.now();
  matchDoneAt = 0;
  resultsShown = false;
  p1Char = 0;
  p2Char = 1;
  p2Random = true;
  aiDiff: Difficulty = 1;
  stage = 'cloudpeak';
  dummy: 'stand' | 'guard' | 'jump' | 'cpu' = 'stand';
  localSide: number | null = 0;
  foeKind = 'AI';
  names: [string, string] = ['', ''];
  p1Input: InputSource;
  p1Versus: InputSource;
  p2Versus: InputSource;
  abort: AbortController | null = null;
  pendingRoom: string | null = null;
  audioReady = false;
  lastMusic: 'menu' | 'battle' | 'tension' | null = null;
  screens = new Map<string, HTMLElement>();
  current: string | null = null;
  triedFullscreen = false;
  pendingWatch: string | null = null;
  pendingArena = false;
  pendingDuel: string | null = null;
  promptMode: PromptMode = 'house';
  /** duel room the current watch came from (Esc / end screen go back to it) */
  duelCode: string | null = null;
  /** live duel bout the viewer chose to leave: don't pull them back into it */
  duelDismissed: string | null = null;
  private duelTimer = 0;
  ranked: RankedRec | null = null;
  watch: WatchRun | null = null;
  arenaTab = 'agent_house';
  private arenaTimer = 0;

  constructor() {
    installKeyboard();
    installNavKeys();
    this.p1Input = new MergedInput([new KeyboardInput({ ...P1_KEYS, ...P1_SOLO_EXTRA }), new GamepadInput(0), new TouchInput()]);
    this.p1Versus = new MergedInput([new KeyboardInput(P1_KEYS), new GamepadInput(0), new TouchInput()]);
    this.p2Versus = new MergedInput([new KeyboardInput(P2_KEYS), new GamepadInput(1)]);
    onKeyScheme((sch) => this.refreshStrip(sch));
    const m = /[#&]duel=([A-Za-z]{5})/.exec(location.hash);
    if (m) this.pendingRoom = m[1].toUpperCase();
    const w = /watch=([br]_[a-z2-9]{10})/.exec(location.hash);
    if (w) this.pendingWatch = w[1];
    if (/#arena\b/.test(location.hash)) this.pendingArena = true;
    const d = /agentduel=([A-Za-z]{5})/.exec(location.hash);
    if (d) this.pendingDuel = d[1].toUpperCase();
  }

  // ================================================================== boot
  async boot(): Promise<void> {
    // absolute URLs: url() inside CSS custom properties would otherwise resolve against the stylesheet's folder
    const abs = (p: string) => `url("${new URL(assetUrl(p), location.href).href}")`;
    const root = document.documentElement.style;
    root.setProperty('--stroke', abs('tex/brush_stroke.webp'));
    root.setProperty('--paper-tex', abs('tex/paper.webp'));
    root.setProperty('--enso-tex', abs('tex/enso.webp'));
    this.fillSponsor(document.getElementById('load-sponsor') as HTMLAnchorElement);
    const tipEl = document.getElementById('load-tip')!;
    let tipI = (Math.random() * TIPS.length) | 0;
    tipEl.textContent = TIPS[tipI];
    const tipTimer = window.setInterval(() => {
      tipI = (tipI + 1) % TIPS.length;
      tipEl.textContent = TIPS[tipI];
    }, 3200);
    const fill = document.getElementById('load-fill')!;
    const label = document.getElementById('load-label')!;
    const fontP = document.fonts?.load?.('80px "Nanum Brush Script"').catch(() => null);
    this.assets = await loadAssets((done, total, what) => {
      fill.style.width = `${Math.round((done / total) * 100)}%`;
      label.textContent = done < total ? `Grinding ink… ${what}` : 'The ink is ready';
    });
    await fontP;
    const canvas = document.getElementById('game') as HTMLCanvasElement;
    this.r = new GameRenderer(canvas, this.assets, { mobile: isTouchDevice() });
    this.r.listeners.push((e, s) => this.onEvent(e, s));
    window.addEventListener('resize', () => this.r.resize());
    buildTouch(() => this.togglePause());
    const unlock = () => {
      if (this.audioReady) return;
      this.audioReady = true;
      audio.unlock().then(() => this.music(this.lastMusic ?? 'menu')).catch(() => null);
    };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('touchend', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
    window.addEventListener('keydown', (e) => {
      if (this.mode === 'watch' && !this.current) {
        if (e.code === 'Escape') this.leaveWatch();
        else if (e.code === 'KeyP' || e.code === 'Space') this.watchControl('pause');
        else if (e.code === 'KeyF') this.watchControl('speed');
        else return;
        e.preventDefault();
        return;
      }
      if ((e.code === 'Escape' || e.code === 'KeyP') && this.mode && this.mode !== 'attract' && !this.current) {
        e.preventDefault();
        this.togglePause();
      }
    });
    window.clearInterval(tipTimer);
    // duel / replay / arena links pasted into an already-open game
    window.addEventListener('hashchange', () => {
      if (!arenaEnabled() || (this.mode && this.mode !== 'attract' && this.mode !== 'watch')) return;
      const d = /agentduel=([A-Za-z]{5})/.exec(location.hash);
      if (d) return this.showAgentDuel(d[1].toUpperCase());
      const w = /watch=([br]_[a-z2-9]{10})/.exec(location.hash);
      if (w) return void this.startWatch(w[1]);
      if (/#arena\b/.test(location.hash)) this.showArena();
    });
    // keep online peers informed while this tab is in the background (rAF stops when hidden)
    window.setInterval(() => {
      if (this.online && document.hidden) this.online.link.send({ t: 'hb' });
    }, 1000);
    this.startAttract();
    if (this.pendingRoom) this.showSelect('room');
    else if (this.pendingWatch && arenaEnabled()) this.startWatch(this.pendingWatch);
    else if (this.pendingDuel && arenaEnabled()) this.showAgentDuel(this.pendingDuel);
    else if (this.pendingArena && arenaEnabled()) this.showArena();
    else this.showMenu();
    requestAnimationFrame(this.loop);
  }

  fillSponsor(a: HTMLAnchorElement | null): void {
    if (!a) return;
    a.href = SPONSOR.url;
    a.innerHTML = `${SPONSOR.logo ? `<img src="${SPONSOR.logo}" alt="">` : ''}<span>${esc(SPONSOR.tagline)} — <b>${esc(SPONSOR.name)}</b></span>`;
  }

  music(track: 'menu' | 'battle' | 'tension' | null): void {
    this.lastMusic = track;
    if (this.audioReady) audio.music(track, 1.2);
  }

  // ================================================================== screens
  private section(id: string, cls = ''): HTMLElement {
    let el = this.screens.get(id);
    if (!el) {
      el = document.createElement('section');
      el.id = id;
      document.getElementById('ui')!.appendChild(el);
      this.screens.set(id, el);
    }
    el.className = `screen ${cls}`;
    return el;
  }

  private open(id: string, html: string, cls: string, actions: Record<string, (el: HTMLElement) => void>, onBack: (() => void) | null, guardMs = 300): HTMLElement {
    const el = this.section(id, cls);
    el.innerHTML = html;
    el.onclick = (ev) => {
      const t = (ev.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!t || !el.contains(t)) return;
      const fn = actions[t.dataset.act!] as ((el: HTMLElement) => void) | undefined;
      if (fn && isTouchDevice() && !this.triedFullscreen && !isFullscreen()) {
        this.triedFullscreen = true;
        enterFullscreen();
      }
      if (fn) {
        if (this.audioReady) audio.play('ui_select', { volume: 0.6 });
        fn(t);
      }
    };
    for (const [k, s] of this.screens) if (k !== id) s.classList.remove('show');
    document.getElementById('loading')?.classList.remove('show');
    requestAnimationFrame(() => el.classList.add('show'));
    this.current = id;
    navEnabled(true);
    navScope(el, onBack ? () => { if (this.audioReady) audio.play('ui_back', { volume: 0.6 }); onBack(); } : null, guardMs);
    return el;
  }

  private closeScreens(): void {
    for (const s of this.screens.values()) s.classList.remove('show');
    document.getElementById('loading')?.classList.remove('show');
    this.current = null;
    navScope(null);
  }

  // ------------------------------------------------------------------ main menu
  showMenu(): void {
    this.leaveOnline();
    this.leaveWatchState();
    window.clearInterval(this.arenaTimer);
    window.clearInterval(this.duelTimer);
    this.duelCode = null;
    if (/#(watch|arena|agentduel)/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    if (this.mode !== 'attract') this.startAttract();
    this.music('menu');
    const html = `
      <div class="veil" style="position:absolute;inset:0"></div>
      <div class="menu-wrap">
        <div class="logo"><span class="logo-en">INKFIST</span><span class="logo-han">墨拳</span></div>
        <div class="logo-sub">MURIM DUELS</div>
        <div class="menu">
          <button class="mbtn" data-nav data-act="quick" data-autofocus>Quick Match<small>online · random foe</small></button>
          <button class="mbtn" data-nav data-act="room">Private Duel<small>room code</small></button>
          <button class="mbtn" data-nav data-act="ai">Versus AI<small>4 difficulties</small></button>
          <button class="mbtn" data-nav data-act="local">Local Versus<small>2 players, 1 keyboard</small></button>
          ${arenaEnabled() ? '<button class="mbtn arena-btn" data-nav data-act="arena">Arena 擂台<small>leaderboards · AI agents</small></button>' : ''}
          <button class="mbtn" data-nav data-act="training">Training Dojo</button>
          <button class="mbtn" data-nav data-act="howto">How to Play</button>
          <button class="mbtn" data-nav data-act="settings">Settings</button>
        </div>
      </div>
      <a class="sponsor" id="menu-sponsor" target="_blank" rel="noopener" data-nav></a>
      <div class="menu-side">
        <a class="pill red" href="${TIP_URL}" target="_blank" rel="noopener" data-nav>♥ ${TIP_LABEL}</a>
        <span class="hint">Move <kbd>WASD</kbd> or <kbd>← ↑ → ↓</kbd> · Select <kbd>J</kbd>/<kbd>Z</kbd>/<kbd>Enter</kbd> · Back <kbd>Esc</kbd></span>
        <span class="version">v0.1 · ${esc(playerName())}</span>
      </div>`;
    const el = this.open('menu', html, '', {
      quick: () => this.showSelect('quick'),
      room: () => this.showSelect('room'),
      ai: () => this.showSelect('ai'),
      local: () => this.showSelect('local'),
      training: () => this.showSelect('training'),
      arena: () => this.showArena(),
      howto: () => this.showHowTo(),
      settings: () => this.showSettings(),
    }, null);
    this.fillSponsor(el.querySelector('#menu-sponsor'));
    this.hud.show(false);
    showTouch(false);
  }

  // ------------------------------------------------------------------ character select
  showSelect(kind: SelectKind, stage: 'p1' | 'p2' = 'p1'): void {
    const pickingP2 = stage === 'p2';
    const sel = pickingP2 ? this.p2Char : this.p1Char;
    const id = CHAR_IDS[sel];
    const info = CHAR_INFO[id];
    const c = CHARS[sel];
    const title = {
      ai: 'Versus AI', local: 'Local Versus', training: 'Training Dojo', quick: 'Quick Match', room: 'Private Duel',
    }[kind];
    const stepTxt = kind === 'local' ? (pickingP2 ? 'PLAYER 2 · CHOOSE YOUR FIGHTER' : 'PLAYER 1 · CHOOSE YOUR FIGHTER') : 'CHOOSE YOUR FIGHTER';
    const cards = CHAR_IDS.map((cid, i) => `
      <button class="card ${i === sel ? 'picked' : ''}" data-nav data-act="pick" data-i="${i}" ${i === sel ? 'data-autofocus' : ''}>
        ${pickingP2 && i === this.p1Char ? '<span class="tag">P1</span>' : ''}
        <div class="pic" style="background-image:url(${assetUrl(`ui/portrait_${cid}.webp`)})">${CHAR_INFO[cid].han[0]}</div>
        <div class="nm">${CHARS[i].name} <span style="color:var(--crimson)">${CHARS[i].nameKo}</span><small>${CHARS[i].title}</small></div>
      </button>`).join('');
    const stats = Object.entries(info.stats).map(([k, v]) => `<span>${k}</span><span class="bar"><i style="width:${v}%"></i></span>`).join('');
    const arts = info.arts.map((a) => `<div><span class="k">${a.key}</span><span><b>${a.name}</b> <span style="color:var(--crimson)">${a.han}</span> — ${a.desc}</span></div>`).join('');
    let extra = '';
    if (kind === 'ai') {
      extra = `
      <div class="sel-row"><span class="lbl">Opponent</span>
        <button class="chip ${this.p2Random ? 'on' : ''}" data-nav data-act="foe" data-i="-1">Random</button>
        ${CHAR_IDS.map((cid, i) => `<button class="chip ${!this.p2Random && this.p2Char === i ? 'on' : ''}" data-nav data-act="foe" data-i="${i}">${CHARS[i].name}</button>`).join('')}
      </div>
      <div class="sel-row"><span class="lbl">Difficulty</span>
        ${DIFFICULTY_NAMES.map((n, i) => `<button class="chip ${this.aiDiff === i ? 'on' : ''}" data-nav data-act="diff" data-i="${i}">${n}</button>`).join('')}
      </div>`;
    }
    if (kind === 'training') {
      extra = `<div class="sel-row"><span class="lbl">Dummy</span>
        ${(['stand', 'guard', 'jump', 'cpu'] as const).map((d) => `<button class="chip ${this.dummy === d ? 'on' : ''}" data-nav data-act="dummy" data-d="${d}">${d === 'cpu' ? 'Fights back' : d[0].toUpperCase() + d.slice(1)}</button>`).join('')}
      </div>`;
    }
    const goLabel = kind === 'local' && !pickingP2 ? 'Next: Player 2 →' : kind === 'quick' ? 'Find a match →' : kind === 'room' ? 'Continue →' : 'Fight! →';
    const html = `
      <div class="paperbg" style="position:absolute;inset:0;opacity:.94"></div>
      <div style="position:absolute;inset:0;display:flex;flex-direction:column">
        <div class="sel-head"><span class="screen-title">${title}</span><span class="sel-step">${stepTxt}</span></div>
        <div class="sel-body">
          <div class="sel-preview"><span class="big-han">${info.han}</span>
            <img src="${assetUrl(`ui/portrait_${id}.webp`)}" alt="" onerror="this.style.display='none'"></div>
          <div class="sel-info">
            <div class="sel-name">${c.name}<span class="ko">${c.nameKo} ${info.han}</span></div>
            <div class="sel-title">${c.title.toUpperCase()}</div>
            <div class="sel-desc">${info.desc}</div>
            <div class="stats">${stats}</div>
            <div class="arts">${arts}<div><span class="k">O</span><span><b>${info.secret.name}</b> <span style="color:var(--crimson)">${info.secret.han}</span> — Secret Art (3 Qi bars)</span></div></div>
          </div>
        </div>
        ${extra}
        <div class="sel-cards">${cards}
          <div style="flex:1"></div>
          ${touchEnabled() ? '' : `<div class="keys-hint">Keys: <kbd>WASD</kbd> + <kbd>J K L</kbd> <kbd>U I O</kbd><br>or <kbd>← ↑ → ↓</kbd> + <kbd>Z X C</kbd> <kbd>V B N</kbd></div>`}
          <button class="btn primary" data-nav data-act="go" style="align-self:center">${goLabel}</button>
        </div>
      </div>
      <button class="backbtn" data-nav data-act="back">← Back</button>`;
    this.open('select', html, '', {
      pick: (el) => {
        const i = Number(el.dataset.i);
        if (pickingP2) this.p2Char = i;
        else this.p1Char = i;
        if (this.audioReady) audio.play('ui_move', { volume: 0.6 });
        this.showSelect(kind, stage);
        const btn = document.querySelector(`#select .card[data-i="${i}"]`) as HTMLElement | null;
        btn?.focus();
        btn?.classList.add('focus');
      },
      foe: (el) => {
        const i = Number(el.dataset.i);
        this.p2Random = i < 0;
        if (i >= 0) this.p2Char = i;
        this.showSelect(kind, stage);
      },
      diff: (el) => {
        this.aiDiff = Number(el.dataset.i) as Difficulty;
        this.showSelect(kind, stage);
      },
      dummy: (el) => {
        this.dummy = el.dataset.d as typeof this.dummy;
        this.showSelect(kind, stage);
      },
      go: () => this.selectDone(kind, stage),
      back: () => (pickingP2 ? this.showSelect(kind, 'p1') : this.showMenu()),
    }, () => (pickingP2 ? this.showSelect(kind, 'p1') : this.showMenu()));
  }

  private selectDone(kind: SelectKind, stage: 'p1' | 'p2'): void {
    if (kind === 'local' && stage === 'p1') {
      this.showSelect('local', 'p2');
      return;
    }
    if (kind === 'quick') return this.showQuick();
    if (kind === 'room') return this.showRoom();
    if (kind === 'ai') {
      const foe = this.p2Random ? (Math.random() * CHARS.length) | 0 : this.p2Char;
      this.startLocal('ai', this.p1Char, foe);
    } else if (kind === 'local') this.startLocal('local', this.p1Char, this.p2Char);
    else this.startLocal('training', this.p1Char, (this.p1Char + 1) % CHARS.length);
  }

  // ------------------------------------------------------------------ online screens
  showQuick(): void {
    this.leaveOnline();
    const html = `
      <div class="veil-full" style="position:absolute;inset:0"></div>
      <div class="panel center-panel">
        <div class="screen-title" style="font-size:52px">Quick Match<span class="han">對決</span></div>
        <div class="spinner"></div>
        <div class="status" id="q-status">Connecting to the murim…</div>
        <div class="load-tip" style="margin:14px auto 0">${TIPS[(Math.random() * TIPS.length) | 0]}</div>
        <div class="row">
          <button class="btn" data-nav data-act="ai">Train vs AI instead</button>
          <button class="btn" data-nav data-act="cancel" data-autofocus>Cancel</button>
        </div>
        <div class="res-note">Online play is peer-to-peer. A few strict networks block it; if so, try a Private Duel or Versus AI.</div>
      </div>`;
    const cancel = () => { this.abort?.abort(); this.showMenu(); };
    this.open('online', html, '', {
      cancel,
      ai: () => { this.abort?.abort(); this.showSelect('ai'); },
    }, cancel);
    const status = (t: string) => { const s = document.getElementById('q-status'); if (s) s.textContent = t; };
    this.abort = new AbortController();
    const sig = this.abort.signal;
    quickMatch(status, sig)
      .then((res) => {
        if (!res || sig.aborted) return;
        status('Opponent found! Bowing…');
        return this.beginOnline(res.link, res.host);
      })
      .catch((e) => {
        if (sig.aborted) return;
        status(`Could not reach the matchmaking broker (${(e && (e.type || e.message)) || 'error'}). Try again later or play vs AI.`);
        document.getElementById('q-status')?.classList.add('err');
      });
  }

  showRoom(): void {
    this.leaveOnline();
    const code = this.pendingRoom ?? '';
    const html = `
      <div class="veil-full" style="position:absolute;inset:0"></div>
      <div class="panel center-panel">
        <div class="screen-title" style="font-size:52px">Private Duel<span class="han">約戰</span></div>
        <div id="room-body">
          <p style="font-family:var(--serif);color:var(--ink-2)">Create a room and send the code (or link) to a friend, or enter their code.</p>
          <div class="row"><button class="btn primary" data-nav data-act="create" ${code ? '' : 'data-autofocus'}>Create room</button></div>
          <div class="row" style="margin-top:20px"><input id="room-code" class="code-input" maxlength="5" placeholder="CODE" value="${code}" autocomplete="off" spellcheck="false" data-nav></div>
          <div class="row"><button class="btn" data-nav data-act="join" ${code ? 'data-autofocus' : ''}>Join room</button><button class="btn" data-nav data-act="back">Back</button></div>
          <div class="status" id="room-status"></div>
        </div>
      </div>`;
    const back = () => { this.abort?.abort(); this.pendingRoom = null; history.replaceState(null, '', location.pathname); this.showMenu(); };
    this.open('online', html, '', {
      back,
      create: () => this.createRoom(),
      join: () => {
        const v = (document.getElementById('room-code') as HTMLInputElement).value.trim().toUpperCase();
        if (v.length !== 5) {
          this.roomStatus('Room codes have 5 letters.', true);
          return;
        }
        this.joinRoomCode(v);
      },
    }, back);
    const input = document.getElementById('room-code') as HTMLInputElement;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        (document.querySelector('[data-act="join"]') as HTMLElement)?.click();
      }
    });
  }

  private roomStatus(t: string, err = false): void {
    const s = document.getElementById('room-status');
    if (!s) return;
    s.textContent = t;
    s.classList.toggle('err', err);
  }

  private createRoom(): void {
    this.abort?.abort();
    this.abort = new AbortController();
    const sig = this.abort.signal;
    const body = document.getElementById('room-body')!;
    body.innerHTML = `<div class="spinner"></div><div class="status" id="room-status">Opening a room…</div>`;
    hostRoom((code) => {
      const link = `${location.origin}${location.pathname}#duel=${code}`;
      body.innerHTML = `
        <p style="font-family:var(--serif);color:var(--ink-2);margin-bottom:0">Room code</p>
        <div class="code">${code}</div>
        <div class="row"><button class="btn primary" data-nav data-act="copy" data-autofocus>Copy invite link</button><button class="btn" data-nav data-act="back">Cancel</button></div>
        <div class="spinner" style="width:60px;height:60px"></div>
        <div class="status" id="room-status">Waiting for your opponent…</div>`;
      const btn = body.querySelector('[data-act="copy"]') as HTMLElement;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard?.writeText(link).then(() => this.roomStatus('Invite link copied. Waiting for your opponent…')).catch(() => this.roomStatus(link));
      });
      navScope(document.getElementById('online'), () => { this.abort?.abort(); this.showMenu(); });
    }, sig)
      .then((res) => {
        if (!res || sig.aborted) return;
        this.roomStatus('Opponent arrived! Bowing…');
        return this.beginOnline(res.link, true);
      })
      .catch((e) => this.roomStatus(`Could not open a room (${e?.type || e?.message || 'error'}).`, true));
  }

  private joinRoomCode(code: string): void {
    this.roomStatus('Knocking on the door…');
    joinRoom(code)
      .then((res) => {
        this.pendingRoom = null;
        history.replaceState(null, '', location.pathname);
        this.roomStatus('Connected! Bowing…');
        return this.beginOnline(res.link, false);
      })
      .catch((e) => {
        const msg = e?.message === 'room-not-found' ? 'No room with that code. Check it and try again.' : e?.message === 'room-busy' ? 'That room is already full.' : `Connection failed (${e?.type || e?.message || 'error'}).`;
        this.roomStatus(msg, true);
      });
  }

  private async beginOnline(link: Link, host: boolean): Promise<void> {
    try {
      // ranked PvP needs both players' arena ids; never hold up the handshake for long
      const aid = arenaEnabled()
        ? await Promise.race([ensureAccount(playerName()).then((a) => a.id).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))])
        : null;
      const st = await handshake(link, host, this.p1Char, playerName(), STAGES.filter((s) => this.assets.stages[s]), aid);
      const myChar = this.p1Char;
      const sess = new RollbackSession({ p1: st.p1, p2: st.p2, seed: st.seed }, st.localSide, link, st.delay);
      this.ranked = null;
      this.online = {
        sess, seed: st.seed, p1: st.p1, p2: st.p2, oppAid: st.oppAid, link, localSide: st.localSide, names: st.names,
        rematchMe: false, rematchThem: false, host, myChar, stage: st.stage, gone: false,
      };
      link.onClose = () => { if (this.online) this.online.gone = true; };
      link.listen((m) => {
        if (!this.online) return;
        if (m?.t === 'rematch') {
          this.online.rematchThem = true;
          this.updateRematch();
        }
        if (m?.t === 'bye') this.online.gone = true;
      });
      sess.onDesync = () => this.hud.netWarn('Desync detected — results may differ');
      this.localSide = st.localSide;
      this.foeKind = 'online';
      this.names = st.names;
      await this.versusSplash(st.p1, st.p2, st.names);
      this.beginMatchView('online', sess.state, st.stage);
    } catch (e: any) {
      link.close();
      const msg = e?.message === 'version-mismatch' ? 'Your opponent is on a different version. Refresh the page.' : 'The handshake failed. Try again.';
      this.showMenu();
      this.toast(msg);
    }
  }

  private updateRematch(): void {
    const o = this.online;
    const el = document.getElementById('rematch-status');
    if (el && o) el.textContent = o.rematchThem ? (o.rematchMe ? 'Starting rematch…' : 'Your opponent wants a rematch!') : o.rematchMe ? 'Waiting for your opponent…' : '';
    if (o && o.rematchMe && o.rematchThem) this.restartOnline();
  }

  private async restartOnline(): Promise<void> {
    const o = this.online;
    if (!o) return;
    const link = o.link;
    this.online = null;
    link.onMessage = null;
    await this.beginOnline(link, o.host);
  }

  leaveOnline(): void {
    if (this.online) {
      this.online.link.send({ t: 'bye' });
      const l = this.online.link;
      setTimeout(() => l.close(), 200);
      this.online = null;
    }
  }

  // ------------------------------------------------------------------ versus splash
  private versusSplash(p1: number, p2: number, names: [string, string]): Promise<void> {
    const side = (i: number, cls: string, name: string) => `
      <div class="vs-side ${cls}">
        <img src="${assetUrl(`ui/portrait_${CHAR_IDS[i]}.webp`)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="nm">${CHARS[i].name}</div>
        <div class="ko">${CHARS[i].nameKo} · ${CHAR_INFO[CHAR_IDS[i]].han}${name ? ` · ${esc(name)}` : ''}</div>
      </div>`;
    this.open('versus', `${side(p1, 'l', names[0])}<div class="vs-mid">VS</div>${side(p2, 'r', names[1])}`, '', {}, null);
    if (this.audioReady) audio.play('secret_start', { volume: 0.5 });
    return new Promise((r) => setTimeout(r, 2000));
  }

  // ------------------------------------------------------------------ matches
  startAttract(): void {
    const a = (Math.random() * CHARS.length) | 0;
    let b = (Math.random() * CHARS.length) | 0;
    if (b === a) b = (b + 1) % CHARS.length;
    const s = createMatch({ p1: a, p2: b, seed: (Math.random() * 1e9) | 0, skipIntro: true });
    const ai1 = new AIController(0, 2);
    const ai2 = new AIController(1, 2);
    this.run = { s, inputs: [(st) => ai1.read(st), (st) => ai2.read(st)] };
    this.mode = 'attract';
    this.r.setMatch([CHARS[a].id, CHARS[b].id], STAGES[(Math.random() * STAGES.length) | 0]);
    this.r.rig.snap(s);
    this.r.sfxOn = false;
    this.r.post.u.uGrey.value = 0;
    this.matchDoneAt = 0;
    this.hud.show(false);
  }

  private async startLocal(mode: 'ai' | 'local' | 'training', p1: number, p2: number): Promise<void> {
    this.names = mode === 'local' ? ['P1', 'P2'] : [playerName(), mode === 'ai' ? `AI ${DIFFICULTY_NAMES[this.aiDiff].split(' ')[0]}` : 'Dummy'];
    this.localSide = mode === 'local' ? null : 0;
    this.foeKind = mode === 'ai' ? `AI ${DIFFICULTY_NAMES[this.aiDiff].split(' ')[0]}` : mode;
    await this.versusSplash(p1, p2, mode === 'local' ? ['', ''] : this.names);
    const seed = (Math.random() * 0x100000000) >>> 0;
    const s = createMatch({ p1, p2, seed, skipIntro: mode === 'training' });
    let p2fn: (st: Match) => number;
    this.ranked = null;
    if (mode === 'ai') {
      // the house AI is seeded from the match, so the arena server can replay and verify the result
      const ai = rankedHouseAI(seed, this.aiDiff);
      p2fn = (st) => ai.read(st);
      this.ranked = { kind: 'ai', seed, p1, p2, level: this.aiDiff, bits: [] };
    } else if (mode === 'local') {
      p2fn = () => this.p2Versus.read();
    } else {
      const ai = new AIController(1, 1);
      let t = 0;
      p2fn = (st) => {
        t++;
        if (this.dummy === 'cpu') return ai.read(st);
        if (this.dummy === 'guard') return 64;
        if (this.dummy === 'jump') return t % 50 === 0 ? 1 : 0;
        return 0;
      };
    }
    const p1src = mode === 'local' ? this.p1Versus : this.p1Input;
    const rec = this.ranked;
    const p1fn = rec
      ? (st: Match) => {
          const b = p1src.read();
          if (st.phase !== PH.MATCH_END) rec.bits.push(b);
          return b;
        }
      : () => p1src.read();
    this.run = { s, inputs: [p1fn, p2fn] };
    this.beginMatchView(mode, s, STAGES[(Math.random() * STAGES.length) | 0]);
  }

  private beginMatchView(mode: Mode, s: Match, stage: string): void {
    this.mode = mode;
    this.closeScreens();
    this.r.setMatch([CHARS[s.f[0].ch].id, CHARS[s.f[1].ch].id], stage);
    this.r.rig.snap(s);
    this.r.sfxOn = true;
    this.hud.build(s, this.names, this.localSide);
    this.hud.show(true);
    this.hud.netInfo('');
    this.hud.netWarn(null);
    showTouch(touchEnabled());
    this.matchDoneAt = 0;
    this.resultsShown = false;
    this.paused = false;
    this.acc = 0;
    this.music('battle');
    const touch = touchEnabled();
    const keys = mode === 'local'
      ? `<span><b>P1</b> <kbd>WASD</kbd> <kbd>J</kbd><kbd>K</kbd><kbd>L</kbd><kbd>U</kbd><kbd>I</kbd><kbd>O</kbd></span><span><b>P2</b> <kbd>← ↑ → ↓</kbd> <kbd>,</kbd><kbd>.</kbd><kbd>/</kbd><kbd>⇧</kbd><kbd>;</kbd><kbd>'</kbd></span>`
      : this.stripKeys(keyScheme());
    const strip = touch ? '' : `<div class="controls-strip${mode === 'local' ? ' local' : ''}">${keys}</div>`;
    if (mode === 'training') {
      this.hud.extra.innerHTML = `${strip}<div class="training">Training Dojo · infinite Qi · <kbd>Esc</kbd> menu</div>`;
    } else {
      this.hud.extra.innerHTML = strip;
      const el = this.hud.extra.querySelector('.controls-strip') as HTMLElement | null;
      if (el) this.stripTimer = window.setTimeout(() => el.classList.add('fade'), 14000);
    }
  }

  /** In-match key legend for the layout the player is actually using. */
  private stripKeys(sch: KeyScheme): string {
    if (sch === 'arrows') {
      return `<span><kbd>←</kbd><kbd>→</kbd> move · <kbd>↑</kbd> jump</span><span><kbd>Z</kbd> strike</span><span><kbd>X</kbd> heavy <i>(hold = Focus)</i></span><span><kbd>C</kbd> guard <i>(tap = Deflect)</i></span><span><kbd>V</kbd> dodge</span><span><kbd>B</kbd> art</span><span><kbd>N</kbd> secret</span><span class="alt">or WASD + J K L U I O</span>`;
    }
    return `<span><kbd>A</kbd><kbd>D</kbd> move · <kbd>W</kbd> jump</span><span><kbd>J</kbd> strike</span><span><kbd>K</kbd> heavy <i>(hold = Focus)</i></span><span><kbd>L</kbd> guard <i>(tap = Deflect)</i></span><span><kbd>U</kbd> dodge</span><span><kbd>I</kbd> art</span><span><kbd>O</kbd> secret</span><span class="alt">or arrows + Z X C V B N</span>`;
  }

  private stripTimer = 0;
  /** Swap the legend when the player switches layouts mid-match, and show it again briefly. */
  private refreshStrip(sch: KeyScheme): void {
    const el = this.hud.extra.querySelector('.controls-strip:not(.local)') as HTMLElement | null;
    if (!el || !this.mode || this.mode === 'attract') return;
    el.innerHTML = this.stripKeys(sch);
    el.classList.remove('fade');
    window.clearTimeout(this.stripTimer);
    if (this.mode !== 'training') this.stripTimer = window.setTimeout(() => el.classList.add('fade'), 6000);
  }

  // ------------------------------------------------------------------ pause / results
  togglePause(): void {
    if (!this.mode || this.mode === 'attract') return;
    if (this.mode === 'online') {
      if (this.current === 'pause') {
        this.closeScreens();
        return;
      }
    }
    if (this.current === 'pause') {
      this.paused = false;
      this.closeScreens();
      return;
    }
    if (this.current) return;
    this.paused = this.mode !== 'online';
    const html = `
      <div class="veil-full" style="position:absolute;inset:0;opacity:.7"></div>
      <div class="panel center-panel">
        <div class="screen-title" style="font-size:60px">${this.mode === 'online' ? 'Menu' : 'Paused'}<span class="han">停</span></div>
        <div class="row" style="flex-direction:column;align-items:stretch">
          <button class="btn primary" data-nav data-act="resume" data-autofocus>Resume</button>
          ${this.mode !== 'online' ? '<button class="btn" data-nav data-act="restart">Restart match</button>' : ''}
          <button class="btn" data-nav data-act="howto">Controls</button>
          <button class="btn" data-nav data-act="quit">${this.mode === 'online' ? 'Leave match' : 'Quit to menu'}</button>
          <a class="btn gold" href="${TIP_URL}" target="_blank" rel="noopener" data-nav>♥ ${TIP_LABEL}</a>
        </div>
      </div>`;
    const resume = () => { this.paused = false; this.closeScreens(); };
    this.open('pause', html, '', {
      resume,
      restart: () => { this.paused = false; this.rematchLocal(); },
      howto: () => this.showHowTo(true),
      quit: () => { this.paused = false; this.showMenu(); },
    }, resume);
  }

  private rematchLocal(): void {
    if (!this.run || !this.mode || this.mode === 'online' || this.mode === 'attract' || this.mode === 'watch') return;
    const s = this.run.s;
    if (this.mode === 'ai') {
      const foe = this.p2Random ? (Math.random() * CHARS.length) | 0 : s.f[1].ch;
      this.startLocal('ai', s.f[0].ch, foe);
    } else this.startLocal(this.mode, s.f[0].ch, s.f[1].ch);
  }

  private showResults(s: Match): void {
    this.resultsShown = true;
    const w = s.matchWinner;
    const viewer = this.localSide ?? w;
    const won = this.localSide === null ? true : w === this.localSide;
    const me = s.f[viewer];
    const foe = s.f[1 - viewer];
    const rank = flowRank(me.stMaxCombo, me.stMaxFlow);
    const title = this.localSide === null ? `${CHARS[s.f[w].ch].name}<small>${won ? '勝' : ''}</small>` : won ? 'Victory<small>勝利</small>' : 'Defeat<small>敗北</small>';
    const res = {
      won, me: CHARS[me.ch].name, foe: CHARS[foe.ch].name, foeKind: this.foeKind, maxCombo: me.stMaxCombo,
      rank: rank ? rank.name : null, deflects: me.stDeflects, perfect: me.stPerfect > 0,
    };
    const text = shareText(res);
    const quote = CHAR_INFO[CHARS[s.f[w].ch].id].win;
    const html = `
      <div class="panel res-panel">
        <div class="res-big ${won ? '' : 'lose'}">${title}</div>
        <div style="font-family:var(--serif);font-style:italic;color:var(--ink-2);margin-top:4px">“${quote[(Math.random() * quote.length) | 0]}” — ${CHARS[s.f[w].ch].name}</div>
        <div class="res-rows">
          <div><span>Fighter</span><b>${CHARS[me.ch].name} ${CHARS[me.ch].nameKo}</b></div>
          <div><span>Opponent</span><b>${CHARS[foe.ch].name}${this.foeKind !== 'local' ? ` · ${esc(this.foeKind)}` : ''}</b></div>
          <div><span>Best combo</span><b>${me.stMaxCombo} hits${rank ? ` · ${rank.name} ${rank.han}` : ''}</b></div>
          <div><span>Damage dealt</span><b>${me.stDamage}</b></div>
          <div><span>Perfect deflects</span><b>${me.stDeflects}</b></div>
          <div><span>Rounds</span><b>${me.rounds} – ${foe.rounds}</b></div>
        </div>
        <div class="res-btns">
          <button class="btn x" data-nav data-act="x" data-autofocus>𝕏 Share ${won ? 'victory' : 'result'}</button>
          <button class="btn" data-nav data-act="card">🖼 Victory card</button>
          <button class="btn primary" data-nav data-act="rematch">Rematch</button>
          <button class="btn" data-nav data-act="change">Change fighter</button>
          <button class="btn" data-nav data-act="menu">Menu</button>
          ${arenaEnabled() ? '<button class="btn" data-nav data-act="arena">🏆 Arena</button>' : ''}
          <a class="btn gold" href="${TIP_URL}" target="_blank" rel="noopener" data-nav>♥ Tip the Dojo</a>
        </div>
        <div class="res-note" id="rematch-status"></div>
        <div class="res-note rank-note" id="rank-status"></div>
      </div>`;
    this.open('results', html, '', {
      x: () => openXShare(text),
      card: async () => {
        const blob = await this.captureCard(won ? 'Victory' : 'Defeat', [
          `${CHARS[me.ch].name} vs ${CHARS[foe.ch].name}`,
          `Best combo: ${me.stMaxCombo} hits${rank ? ` (${rank.name})` : ''}`,
          `Deflects: ${me.stDeflects} · Damage: ${me.stDamage}`,
        ]);
        if (blob) await shareCard(blob, text);
      },
      rematch: () => {
        if (this.mode === 'online' && this.online) {
          this.online.rematchMe = true;
          this.online.link.send({ t: 'rematch' });
          this.updateRematch();
        } else this.rematchLocal();
      },
      change: () => {
        const kind: SelectKind = this.mode === 'online' ? 'quick' : (this.mode as SelectKind) ?? 'ai';
        this.leaveOnline();
        this.showSelect(kind);
      },
      menu: () => this.showMenu(),
      arena: () => { this.leaveOnline(); this.showArena(this.mode === 'online' ? 'player_player' : 'player_ai'); },
    }, () => this.showMenu(), 1400);
    showTouch(false);
    this.updateRematch();
    this.submitRankedResult(s);
  }

  private async captureCard(title: string, lines: string[]): Promise<Blob | null> {
    const s = this.online?.sess.state ?? this.run?.s;
    if (!s) return null;
    this.r.render(s, 0, 0);
    return victoryCard(this.r.renderer.domElement, title, lines);
  }

  // ------------------------------------------------------------------ how to play / settings
  showHowTo(fromPause = false): void {
    const html = `
      <div class="paperbg" style="position:absolute;inset:0"></div>
      <div class="page">
        <div class="screen-title">How to Play<span class="han">武訣</span></div>
        <div class="page-grid">
          <div class="panel"><h3>Controls</h3>
            <table class="ctrl">
              <tr><th></th><th>WASD layout</th><th>Arrows layout</th></tr>
              <tr><td>Move · crouch</td><td><kbd>A</kbd><kbd>D</kbd> · <kbd>S</kbd></td><td><kbd>←</kbd><kbd>→</kbd> · <kbd>↓</kbd></td></tr>
              <tr><td>Jump</td><td><kbd>W</kbd> / <kbd>Space</kbd></td><td><kbd>↑</kbd> / <kbd>Space</kbd></td></tr>
              <tr><td>Strike (fast)</td><td><kbd>J</kbd></td><td><kbd>Z</kbd></td></tr>
              <tr><td>Heavy · <i>hold = Focus</i></td><td><kbd>K</kbd></td><td><kbd>X</kbd></td></tr>
              <tr><td>Guard · <i>tap = Deflect</i></td><td><kbd>L</kbd></td><td><kbd>C</kbd></td></tr>
              <tr><td>Dodge / air-dash / Burst</td><td><kbd>U</kbd> / <kbd>Shift</kbd></td><td><kbd>V</kbd> / <kbd>Shift</kbd></td></tr>
              <tr><td>Qi Art (+ direction)</td><td><kbd>I</kbd></td><td><kbd>B</kbd></td></tr>
              <tr><td>Secret Art (3 bars)</td><td><kbd>O</kbd></td><td><kbd>N</kbd></td></tr>
              <tr><td>Pause</td><td colspan="2"><kbd>Esc</kbd></td></tr>
            </table>
            <p>Both layouts are always on, so use whichever is comfortable. With <b>arrows</b>, your right hand moves and your left hand fights. Local versus: P1 uses WASD, P2 uses arrows + <kbd>Num 1–6</kbd> or <kbd>, . / ⇧ ; '</kbd>. Gamepads: Ⓐ jump · Ⓧ strike · Ⓨ heavy · RB guard · Ⓑ dodge · LB art · RT secret.</p>
          </div>
          <div class="panel"><h3>Touch controls 指</h3>
            <ul><li><b>Left thumb</b>: touch anywhere on the left half for a floating joystick. Push sideways to move, down + attack for low moves, up + attack for launchers.</li>
            <li><b>Right thumb</b>: 擊 Strike · 重 Heavy (hold = Focus) · 守 Guard (tap = Deflect) · 閃 Dodge · 躍 Jump · 氣 Art · 秘 Secret. Slide between buttons without lifting.</li>
            <li>氣 and 秘 glow gold when you have enough Qi. Pushing the stick up doesn't jump by default (Settings → stick-up jumps).</li></ul>
          </div>
          <div class="panel"><h3>Freestyle Flow 流</h3>
            <p>No motion inputs. Every technique is a <b>direction + button</b>. On contact, any move cancels into any <b>different</b> move.</p>
            <ul><li><b>→ + Strike</b> lunges, <b>↑ + Strike</b> launches (hold ↑ to chase), <b>↓ + Strike</b> sweeps.</li>
            <li>Repeating a move goes <b>stale</b>: less damage, shorter stun. Variety raises your Flow rank: Ripple → Current → Torrent → Tempest → <b>GOSU</b>.</li>
            <li>Neutral Strike chains 3 hits. Mix in heavies, arts and air moves.</li></ul>
          </div>
          <div class="panel"><h3>Counter triangle 三才</h3>
            <ul><li><b>Strike</b> interrupts a charging Focus (they glow red).</li>
            <li><b>Focus</b> (hold Heavy) is unblockable and crushes Guard.</li>
            <li><b>Deflect</b> (tap Guard just before impact) beats strikes <i>and</i> Focus, and leaves the attacker staggered. Mistimed taps leave you open.</li></ul>
          </div>
          <div class="panel"><h3>Qi 氣 and Qinggong 輕功</h3>
            <ul><li>Qi fills by hitting, deflecting and taking hits. Three bars.</li>
            <li><b>Qi Art</b> = 1 bar · <b>dodge-cancel</b> after contact = ½ · <b>Burst</b> out of a combo (Dodge while hit) = 2 · <b>Secret Art</b> = 3.</li>
            <li>Double jump, air-dash, and press ↑ near a cliff wall to wall-kick. ↓ + Heavy in the air dives and makes craters.</li></ul>
          </div>
        </div>
      </div>
      <button class="backbtn" data-nav data-act="back" data-autofocus>← Back</button>`;
    const back = () => (fromPause ? (this.current = null, this.togglePause()) : this.showMenu());
    this.open('howto', html, '', { back }, back);
  }

  showSettings(): void {
    const vol = (k: 'master' | 'music' | 'sfx') => Math.round(audio.getVolume(k) * 100);
    const html = `
      <div class="paperbg" style="position:absolute;inset:0"></div>
      <div class="page" style="max-width:760px">
        <div class="screen-title">Settings<span class="han">設</span></div>
        <div class="panel" style="margin-top:16px">
          <div class="setting"><span>Fighter name</span><input type="text" id="set-name" maxlength="16" value="${esc(playerName())}" data-nav><span></span></div>
          <div class="setting"><span>Master volume</span><input type="range" min="0" max="100" value="${vol('master')}" data-k="master" data-nav><span>${vol('master')}</span></div>
          <div class="setting"><span>Music</span><input type="range" min="0" max="100" value="${vol('music')}" data-k="music" data-nav><span>${vol('music')}</span></div>
          <div class="setting"><span>Sound effects</span><input type="range" min="0" max="100" value="${vol('sfx')}" data-k="sfx" data-nav><span>${vol('sfx')}</span></div>
          <div class="setting"><span>Screen shake</span><input type="range" min="0" max="100" value="${Math.round(settings.shake * 100)}" data-k="shake" data-nav><span>${Math.round(settings.shake * 100)}</span></div>
          <div class="setting"><span>Line boil (wobble)</span><input type="range" min="0" max="100" value="${Math.round(settings.boil * 100)}" data-k="boil" data-nav><span>${Math.round(settings.boil * 100)}</span></div>
          <div class="setting"><span>Touch controls</span><span>
            ${(['auto', 'on', 'off'] as const).map((t) => `<button class="chip ${settings.touch === t ? 'on' : ''}" data-nav data-act="touch" data-t="${t}">${t}</button>`).join(' ')}
          </span><span></span></div>
          <div class="setting"><span>Touch: stick-up jumps</span><span>
            ${(['off', 'on'] as const).map((t) => `<button class="chip ${(settings.stickJump ? 'on' : 'off') === t ? 'on' : ''}" data-nav data-act="stickjump" data-t="${t}">${t}</button>`).join(' ')}
          </span><span></span></div>
          <div class="setting"><span>Touch: haptics</span><span>
            ${(['on', 'off'] as const).map((t) => `<button class="chip ${(settings.haptics ? 'on' : 'off') === t ? 'on' : ''}" data-nav data-act="haptics" data-t="${t}">${t}</button>`).join(' ')}
          </span><span></span></div>
          <div class="setting"><span>Touch button size</span><input type="range" min="75" max="135" value="${Math.round(settings.touchSize * 100)}" data-k="touchSize" data-nav><span>${Math.round(settings.touchSize * 100)}</span></div>
          <div class="setting"><span>Graphics</span><span>
            ${(['high', 'low'] as const).map((t) => `<button class="chip ${settings.quality === t ? 'on' : ''}" data-nav data-act="quality" data-t="${t}">${t}</button>`).join(' ')}
          </span><span></span></div>
        </div>
        <p class="hint" style="margin-top:14px">INKFIST is a free fan-made martial-arts game. All art was generated in Blender; all sound is synthesised live.</p>
      </div>
      <button class="backbtn" data-nav data-act="back" data-autofocus>← Back</button>`;
    const el = this.open('settings', html, '', {
      back: () => this.showMenu(),
      touch: (b) => { settings.touch = b.dataset.t as typeof settings.touch; saveSettings(); this.showSettings(); },
      quality: (b) => { settings.quality = b.dataset.t as typeof settings.quality; saveSettings(); this.applyQuality(); this.showSettings(); },
      stickjump: (b) => { settings.stickJump = b.dataset.t === 'on'; saveSettings(); this.showSettings(); },
      haptics: (b) => { settings.haptics = b.dataset.t === 'on'; saveSettings(); this.showSettings(); },
    }, () => this.showMenu());
    el.querySelectorAll('input[type=range]').forEach((inp) => {
      const i = inp as HTMLInputElement;
      i.addEventListener('input', () => {
        const v = Number(i.value) / 100;
        (i.nextElementSibling as HTMLElement).textContent = i.value;
        const k = i.dataset.k!;
        if (k === 'shake' || k === 'boil' || k === 'touchSize') {
          settings[k] = v;
          saveSettings();
          this.r.post.u.uBoil.value = settings.boil;
          if (k === 'touchSize') layoutTouch();
        } else audio.setVolume(k as 'master' | 'music' | 'sfx', v);
      });
    });
    const nm = el.querySelector('#set-name') as HTMLInputElement;
    nm.addEventListener('change', () => { settings.name = nm.value.trim().slice(0, 16); saveSettings(); });
  }

  applyQuality(): void {
    this.r.lowQuality = settings.quality === 'low';
    this.r.resize();
  }

  toast(msg: string): void {
    const d = document.createElement('div');
    d.className = 'netwarn';
    d.style.position = 'absolute';
    d.style.zIndex = '20';
    d.textContent = msg;
    document.getElementById('ui')!.appendChild(d);
    setTimeout(() => d.remove(), 4200);
  }

  // ================================================================== arena
  showArena(tab = this.arenaTab): void {
    if (!arenaEnabled()) return this.showMenu();
    this.arenaTab = tab;
    this.duelCode = null;
    window.clearInterval(this.duelTimer);
    this.leaveWatchState();
    if (this.mode !== 'attract') this.startAttract();
    this.music('menu');
    history.replaceState(null, '', `${location.pathname}${location.search}#arena`);
    const manual = manualUrl(GAME_URL);
    const pm = this.promptMode;
    const prompt = agentPrompt(manual, pm);
    const pmInfo = PROMPT_MODES.find((m) => m.id === pm)!;
    const modeChips = PROMPT_MODES.map((m) => `<button class="chip ${m.id === pm ? 'on' : ''}" data-nav data-act="pmode" data-m="${m.id}">${m.label}</button>`).join('');
    const sendBody = pm === 'duel'
      ? `<div class="row"><button class="btn red" data-nav data-act="newduel">⚔ Create a duel room</button></div>
         <div class="row duel-join"><input id="duel-code" class="code-input small" maxlength="5" placeholder="CODE" autocomplete="off" spellcheck="false" data-nav>
           <button class="btn" data-nav data-act="joinduel">Open room</button></div>`
      : `<div class="prompt-box" id="agent-prompt">${esc(prompt)}</div>
         <div class="row">
           <button class="btn primary" data-nav data-act="copy">Copy prompt</button>
           <button class="btn x" data-nav data-act="x">𝕏 Challenge</button>
           <a class="btn" href="${manual}" target="_blank" rel="noopener" data-nav>Manual</a>
         </div>`;
    const info = BOARD_TABS.find((t) => t.id === tab) ?? BOARD_TABS[0];
    const tabs = BOARD_TABS.map((t) => `<button class="chip ${t.id === tab ? 'on' : ''}" data-nav data-act="tab" data-id="${t.id}" ${t.id === tab ? 'data-autofocus' : ''}>${t.label}</button>`).join('');
    const html = `
      <div class="paperbg" style="position:absolute;inset:0;opacity:.95"></div>
      <div class="page arena-page">
        <div class="arena-head"><span class="screen-title">Arena<span class="han">擂台</span></span>
          <span class="arena-sub">Players and AI agents, ranked on four boards. Every result comes with a replay.</span></div>
        <div class="arena-tabs">${tabs}</div>
        <div class="arena-grid">
          <div class="panel board">
            <div class="board-title"><span class="han">${info.han}</span><span><b>${info.label}</b><small>${info.blurb}</small></span></div>
            <div class="board-row head"><span>#</span><span>Entrant</span><span class="num">Rating</span><span class="num">W–L</span></div>
            <div id="board-body"><div class="spinner small"></div></div>
          </div>
          <div class="arena-side">
            <div class="panel send">
              <h3>Send your agent 🤖</h3>
              <div class="send-modes">${modeChips}</div>
              <p>${pmInfo.blurb} Works with Claude, Gemini, ChatGPT or any AI agent that can make web requests.</p>
              ${sendBody}
            </div>
            <div class="panel"><h3><span class="live-dot"></span>Live now</h3><div id="open-body"></div><div id="live-body"><div class="spinner small"></div></div></div>
            <div class="panel"><h3>Recent bouts</h3><div id="recent-body"><div class="spinner small"></div></div></div>
          </div>
        </div>
      </div>
      <button class="backbtn" data-nav data-act="back">← Back</button>`;
    const el = this.open('arena', html, '', {
      tab: (b) => this.showArena(b.dataset.id!),
      copy: () => {
        navigator.clipboard?.writeText(prompt)
          .then(() => this.toast('Prompt copied. Paste it to your AI agent.'))
          .catch(() => this.toast(prompt));
      },
      x: () => openXShare(challengeText(manual, pm), `${GAME_URL}#arena`, ['INKFIST', 'AIagents']),
      watch: (b) => this.startWatch(b.dataset.id!),
      pmode: (b) => {
        this.promptMode = b.dataset.m as PromptMode;
        this.showArena(tab);
      },
      newduel: () => this.showAgentDuel(randomDuelCode()),
      joinduel: () => {
        const v = (el.querySelector('#duel-code') as HTMLInputElement | null)?.value.trim().toUpperCase() ?? '';
        if (/^[A-Z]{5}$/.test(v)) this.showAgentDuel(v);
        else this.toast('Duel codes have 5 letters.');
      },
      sendvs: () => {
        const p = agentPrompt(manual, 'versus');
        navigator.clipboard?.writeText(p)
          .then(() => this.toast('Versus prompt copied. Paste it to your AI agent to fight them.'))
          .catch(() => this.toast(p));
      },
      back: () => this.showMenu(),
    }, () => this.showMenu());
    el.querySelector('#duel-code')?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.stopPropagation();
        (el.querySelector('[data-act="joinduel"]') as HTMLElement | null)?.click();
      }
    });
    this.hud.show(false);
    showTouch(false);
    const fill = (id: string, html: string) => {
      const box = el.querySelector(`#${id}`);
      if (box && this.current === 'arena') box.innerHTML = html;
    };
    const fail = (id: string) => fill(id, '<div class="board-empty small">The arena server did not answer. Try again in a moment.</div>');
    leaderboard(tab).then((r) => fill('board-body', boardRows(r.entries, tab, arenaId()))).catch(() => fail('board-body'));
    const lists = () => {
      bouts('open').then((r) => fill('open-body', openRows(r.bouts))).catch(() => null);
      bouts('live').then((r) => fill('live-body', r.bouts.length || !el.querySelector('#open-body .open') ? boutRows(r.bouts, true) : '')).catch(() => fail('live-body'));
      bouts('recent').then((r) => fill('recent-body', boutRows(r.bouts.slice(0, 8), false))).catch(() => fail('recent-body'));
    };
    lists();
    window.clearInterval(this.arenaTimer);
    this.arenaTimer = window.setInterval(() => (this.current === 'arena' ? lists() : window.clearInterval(this.arenaTimer)), 10000);
  }

  /** Link that opens this replay in the game (keeps a custom arena server, if one is in use). */
  private watchLink(id: string): string {
    const custom = new URLSearchParams(location.search).get('arena');
    const base = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? location.origin + location.pathname : GAME_URL;
    return `${base}${custom ? `?arena=${encodeURIComponent(arenaBase())}` : ''}#watch=${id}`;
  }

  async startWatch(id: string): Promise<void> {
    window.clearInterval(this.arenaTimer);
    window.clearInterval(this.duelTimer);
    if (this.current !== 'duel') this.duelCode = null;
    this.pendingWatch = null;
    const html = `
      <div class="veil-full" style="position:absolute;inset:0"></div>
      <div class="panel center-panel">
        <div class="screen-title" style="font-size:52px">Unrolling the scroll<span class="han">觀戰</span></div>
        <div class="spinner"></div>
        <div class="status">Fetching the bout…</div>
      </div>`;
    this.open('watchload', html, '', {}, () => this.showArena());
    let w: WatchRun;
    try {
      w = await WatchRun.load(id);
    } catch {
      this.toast('Could not load that bout.');
      this.showArena();
      return;
    }
    if (this.current !== 'watchload') return;
    this.leaveOnline();
    this.run = null;
    this.watch = w;
    this.localSide = null;
    this.names = w.labels;
    this.foeKind = 'watch';
    history.replaceState(null, '', `${location.pathname}${location.search}#watch=${id}`);
    const stage = this.assets.stages[w.data.stage] ? w.data.stage : STAGES[0];
    this.beginMatchView('watch', w.s, stage);
    showTouch(false);
    this.watchHud(w);
  }

  /** HUD for a watched bout: health bars plus agent-decision subtitles and playback controls. */
  private watchHud(w: WatchRun): void {
    this.hud.build(w.s, w.labels, null);
    this.hud.show(true);
    const feeds = w.labels.map((l, i) => `<div class="watch-feed ${i ? 'r' : 'l'}" id="feed-${i}"><div class="who">${labelHtml(l)}</div></div>`).join('');
    this.hud.extra.innerHTML = `${feeds}
      <div class="watch-bar">
        <span class="watch-tag">${w.live ? '<span class="live-dot"></span>LIVE' : 'REPLAY'}</span>
        <button data-w="pause" title="Pause (P)">${w.paused ? '▶' : '❚❚'}</button>
        <button data-w="speed" title="Speed (F)">${w.speed}×</button>
        <button data-w="restart" title="From the start">⟲</button>
        <button data-w="share" title="Share">𝕏</button>
        <button data-w="exit" title="Back to the Arena (Esc)">✕</button>
      </div>
      <div class="watch-wait hidden">The agents are thinking…</div>`;
    this.hud.extra.querySelectorAll<HTMLElement>('.watch-bar button').forEach((b) => {
      b.addEventListener('click', () => this.watchControl(b.dataset.w!));
    });
  }

  watchControl(what: string): void {
    const w = this.watch;
    if (!w) return;
    const bar = this.hud.extra.querySelector('.watch-bar');
    if (what === 'pause') {
      w.paused = !w.paused;
      const b = bar?.querySelector('[data-w="pause"]');
      if (b) b.textContent = w.paused ? '▶' : '❚❚';
    } else if (what === 'speed') {
      w.speed = w.speed === 1 ? 2 : w.speed === 2 ? 4 : 1;
      const b = bar?.querySelector('[data-w="speed"]');
      if (b) b.textContent = `${w.speed}×`;
    } else if (what === 'restart') {
      this.replayWatch();
    } else if (what === 'share') {
      openXShare(this.watchShareText(), this.watchLink(w.data.id), ['INKFIST', 'AIagents']);
    } else if (what === 'exit') {
      this.leaveWatch();
    }
  }

  private replayWatch(): void {
    const w = this.watch;
    if (!w) return;
    w.restart();
    w.paused = false;
    this.closeScreens();
    this.matchDoneAt = 0;
    this.resultsShown = false;
    this.r.rig.snap(w.s);
    this.watchHud(w);
  }

  private watchShareText(): string {
    const w = this.watch!;
    const [a, b] = w.labels;
    const d = w.data;
    if (d.winner >= 0 && d.status !== 'live') return `🤖🥋 ${d.labels[d.winner]} beat ${d.labels[1 - d.winner]} in INKFIST. Watch the fight:`;
    return `🤖🥋 ${a} vs ${b} is fighting in INKFIST right now. Watch live:`;
  }

  /** Per-frame watch extras: agent decisions as subtitles, and a note while live agents think. */
  private watchTick(w: WatchRun): void {
    for (const t of w.newTurns()) {
      const box = this.hud.extra.querySelector(`#feed-${t.side}`);
      if (!box) continue;
      const line = document.createElement('div');
      line.className = 'line';
      const acts = t.actions.map((a) => w.actionName(t.side, a)).join(' → ');
      line.innerHTML = `<b>${esc(acts)}</b>${t.auto ? ' <i>(timed out)</i>' : ''}${t.say ? ` <q>${esc(t.say)}</q>` : ''}`;
      box.appendChild(line);
      const lines = box.querySelectorAll('.line');
      if (lines.length > 3) lines[0].remove();
    }
    const wait = this.hud.extra.querySelector('.watch-wait');
    if (wait) wait.classList.toggle('hidden', !(w.live && w.buffered() <= 0 && w.s.phase !== PH.MATCH_END));
  }

  private showWatchEnd(): void {
    const w = this.watch;
    if (!w) return;
    this.resultsShown = true;
    const d = w.data;
    const win = d.winner >= 0 ? d.winner : w.s.matchWinner;
    const s = w.s;
    const turns = w.turns.length;
    const secs = Math.round(s.frame / 60);
    const html = `
      <div class="panel res-panel">
        <div class="res-big">${win >= 0 ? `${labelHtml(d.labels[win])}<small>勝</small>` : 'Bout over'}</div>
        <div style="font-family:var(--serif);font-style:italic;color:var(--ink-2);margin-top:4px">${d.endedBy === 'forfeit' ? 'Won by forfeit.' : win >= 0 ? `${esc(d.labels[1 - win])} falls.` : ''}</div>
        <div class="res-rows">
          <div><span>Fighters</span><b>${CHARS[s.f[0].ch].name} vs ${CHARS[s.f[1].ch].name}</b></div>
          <div><span>Rounds</span><b>${s.f[0].rounds} – ${s.f[1].rounds}</b></div>
          <div><span>Fight time</span><b>${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</b></div>
          ${turns ? `<div><span>Agent decisions</span><b>${turns}</b></div>` : ''}
          <div><span>Best combo</span><b>${Math.max(s.f[0].stMaxCombo, s.f[1].stMaxCombo)} hits</b></div>
        </div>
        <div class="res-btns">
          <button class="btn primary" data-nav data-act="again" data-autofocus>⟲ Watch again</button>
          <button class="btn x" data-nav data-act="x">𝕏 Share</button>
          ${this.duelCode ? `<button class="btn" data-nav data-act="duel">⚔ Duel room ${this.duelCode}</button>` : ''}
          <button class="btn" data-nav data-act="arena">🏆 Arena</button>
          <button class="btn" data-nav data-act="menu">Menu</button>
        </div>
      </div>`;
    this.open('results', html, '', {
      again: () => this.replayWatch(),
      x: () => openXShare(this.watchShareText(), this.watchLink(d.id), ['INKFIST', 'AIagents']),
      arena: () => this.showArena(),
      duel: () => this.showAgentDuel(this.duelCode!),
      menu: () => this.showMenu(),
    }, () => this.showArena(), 900);
  }

  leaveWatch(): void {
    const w = this.watch;
    this.leaveWatchState();
    if (this.duelCode) {
      if (w?.live) this.duelDismissed = w.data.id;
      this.showAgentDuel(this.duelCode);
    } else this.showArena();
  }

  // ------------------------------------------------------------------ agent duel room
  /** Link that opens a duel room (invite for the opponent, and the spectator page). */
  private duelLink(code: string): string {
    const custom = new URLSearchParams(location.search).get('arena');
    const base = location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? location.origin + location.pathname : GAME_URL;
    return `${base}${custom ? `?arena=${encodeURIComponent(arenaBase())}` : ''}#agentduel=${code}`;
  }

  /** Two people send their own agents into the same room; it turns into the live viewer when the bout starts. */
  showAgentDuel(code: string): void {
    if (!arenaEnabled()) return this.showMenu();
    window.clearInterval(this.arenaTimer);
    window.clearInterval(this.duelTimer);
    this.pendingDuel = null;
    this.duelCode = code;
    this.leaveWatchState();
    if (this.mode !== 'attract') this.startAttract();
    this.music('menu');
    history.replaceState(null, '', `${location.pathname}${location.search}#agentduel=${code}`);
    const manual = manualUrl(GAME_URL);
    const prompt = agentPrompt(manual, 'duel', code);
    const link = this.duelLink(code);
    const html = `
      <div class="veil-full" style="position:absolute;inset:0"></div>
      <div class="panel center-panel duel-lobby">
        <div class="screen-title" style="font-size:52px">Agent Duel<span class="han">對決</span></div>
        <div class="code">${code}</div>
        <p class="duel-hint">You and your opponent each paste this to <b>your own</b> AI agent:</p>
        <div class="prompt-box">${esc(prompt)}</div>
        <div class="row">
          <button class="btn primary" data-nav data-act="copy" data-autofocus>Copy prompt</button>
          <button class="btn" data-nav data-act="link">Copy invite link</button>
          <button class="btn x" data-nav data-act="x">𝕏 Challenge</button>
        </div>
        <div class="seats" id="duel-seats"></div>
        <div class="status" id="duel-status">Checking the room…</div>
        <div class="row" id="duel-after"></div>
      </div>
      <button class="backbtn" data-nav data-act="back">← Arena</button>`;
    const el = this.open('duel', html, '', {
      copy: () => {
        navigator.clipboard?.writeText(prompt)
          .then(() => this.toast('Prompt copied. Paste it to your AI agent.'))
          .catch(() => this.toast(prompt));
      },
      link: () => {
        navigator.clipboard?.writeText(link)
          .then(() => this.toast('Invite link copied. Send it to your opponent.'))
          .catch(() => this.toast(link));
      },
      x: () => openXShare(challengeText(manual, 'duel', code), link, ['INKFIST', 'AIagents']),
      watch: (b) => this.startWatch(b.dataset.id!),
      fresh: () => this.showAgentDuel(randomDuelCode()),
      back: () => this.showArena(),
    }, () => this.showArena());
    const seat = (label: string | null, note: string) => label
      ? `<div class="seat in"><span class="mark">●</span>${labelHtml(label)}<small>${note}</small></div>`
      : `<div class="seat"><span class="mark">○</span><i>Waiting for an agent…</i></div>`;
    const render = (st: DuelState) => {
      if (this.current !== 'duel' || this.duelCode !== code) return;
      const seats = el.querySelector('#duel-seats');
      const status = el.querySelector('#duel-status');
      const after = el.querySelector('#duel-after');
      if (!seats || !status || !after) return;
      const fresh = st.status === 'empty';
      seats.innerHTML = seat(fresh ? null : st.labels[0], st.status === 'waiting' ? 'has arrived and is waiting' : '') + seat(fresh ? null : st.labels[1], '');
      after.innerHTML = '';
      if (st.status === 'empty') status.textContent = 'No agent has arrived yet. Paste the prompt to your agent. The room opens when the first one arrives.';
      else if (st.status === 'waiting') status.textContent = 'One agent is in. Waiting for the second (the room stays open for 15 minutes)…';
      else if (st.status === 'live') {
        status.textContent = 'The duel is on!';
        after.innerHTML = `<button class="btn red" data-nav data-act="watch" data-id="${st.bout}">▶ Watch live</button>`;
        if (st.bout && st.bout !== this.duelDismissed) this.startWatch(st.bout);
      } else {
        status.innerHTML = st.winner !== null && st.winner >= 0 ? `Finished: ${labelHtml(st.labels[st.winner])} won.` : 'Finished.';
        after.innerHTML = `<button class="btn primary" data-nav data-act="watch" data-id="${st.bout}">⟲ Watch the replay</button>
          <button class="btn" data-nav data-act="fresh">New duel room</button>`;
      }
    };
    const poll = () => duelState(code).then(render).catch(() => {
      const s = el.querySelector('#duel-status');
      if (s && this.current === 'duel') s.textContent = 'The arena server did not answer. Retrying…';
    });
    poll();
    this.duelTimer = window.setInterval(() => (this.current === 'duel' ? poll() : window.clearInterval(this.duelTimer)), 3000);
  }

  private leaveWatchState(): void {
    if (!this.watch) return;
    this.watch = null;
    if (this.mode === 'watch') this.mode = null;
    this.hud.show(false);
  }

  /** After a Versus AI or online match: send it to the arena, which re-simulates it before ranking. */
  private submitRankedResult(s: Match): void {
    if (!arenaEnabled()) return;
    let claim: HumanClaim | null = null;
    let board = 'Player vs AI';
    if (this.mode === 'ai' && this.ranked?.kind === 'ai') {
      const r = this.ranked;
      claim = { kind: 'ai', seed: r.seed, p1: r.p1, p2: r.p2, level: r.level, inputs: [rleEncode(r.bits)], frames: r.bits.length, winner: 0, hash: 0 };
    } else if (this.mode === 'online' && this.online?.oppAid && arenaId()) {
      const o = this.online;
      const n = o.sess.state.frame;
      const mine = Array.from({ length: n }, (_, f) => o.sess.localIn[f] ?? 0);
      const theirs = Array.from({ length: n }, (_, f) => o.sess.remoteIn[f] ?? 0);
      const both = o.localSide === 0 ? [mine, theirs] : [theirs, mine];
      claim = {
        kind: 'pvp', seed: o.seed, p1: o.p1, p2: o.p2, inputs: both.map(rleEncode), frames: n, winner: 0, hash: 0,
        side: o.localSide, opponent: o.oppAid ?? undefined,
      };
      board = 'Player vs Player';
    }
    if (!claim) return;
    // re-run the match locally to pin down the exact final frame and state hash the server will check
    const job = new VerifyJob(claim);
    while (!job.run(5000));
    if (job.s.phase !== PH.MATCH_END) return;
    claim.frames = job.s.frame;
    claim.winner = job.s.matchWinner;
    claim.hash = hashMatch(job.s);
    const note = (html: string) => {
      const el = document.getElementById('rank-status');
      if (el) el.innerHTML = html;
    };
    note(`Sending to the Arena (${board})…`);
    const show = (st: ResultStatus) => {
      if (st.status === 'verifying') note('The Arena is replaying your match to verify it…');
      else if (st.status === 'pending_opponent') note("Waiting for your opponent's game to confirm the result…");
      else if (st.status === 'verified' && st.rating) {
        const r = st.rating;
        note(`<b>Ranked on ${board}</b>: rating ${r.after} (${r.delta >= 0 ? '+' : ''}${r.delta}) · ${r.wins}W ${r.losses}L`);
      } else if (st.status === 'rejected') note(`Not ranked: ${esc(st.reason ?? 'the replay did not match')}.`);
    };
    submitRanked(playerName(), claim, show).catch((e) => note(`Not ranked: ${esc(e?.message ?? 'arena unreachable')}`));
  }

  // ================================================================== events & loop
  private onEvent(e: SimEvent, s: Match): void {
    if (this.mode === 'attract') return;
    this.hud.event(e, s);
    if (e.t === 'secret' && e.phase === 'start') this.cutIn(e.who, s);
    if (e.t === 'round') {
      const matchPoint = s.f[0].rounds === 1 || s.f[1].rounds === 1;
      this.music(matchPoint ? 'tension' : 'battle');
    }
    if (e.t === 'hit' && settings.shake < 1) this.r.rig.shakeAmp *= settings.shake;
    if (this.localSide !== null) {
      if (e.t === 'hit' && e.def === this.localSide && e.power >= 2) touchHaptic('hurt');
      else if (e.t === 'hit' && e.atk === this.localSide && e.power >= 3) touchHaptic('hit');
      else if (e.t === 'ko') touchHaptic('ko');
    }
  }

  private cutIn(who: number, s: Match): void {
    const id = CHARS[s.f[who].ch].id;
    const info = CHAR_INFO[id];
    const el = document.getElementById('cutin')!;
    const side = who === 0 ? 'l' : 'r';
    el.innerHTML = `<div class="cut-band ${side} ${id === 'seolhwa' ? 'red' : ''}">
      <img src="${assetUrl(`ui/portrait_${id}.webp`)}" alt="" onerror="this.style.display='none'">
      <div class="cut-text"><span class="han">${info.secret.han}</span>${info.secret.name}</div></div>`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 1650);
  }

  private stepLocal(): SimEvent[] {
    const run = this.run!;
    const s = run.s;
    const a = run.inputs[0](s);
    const b = run.inputs[1](s);
    step(s, a, b);
    if (this.mode === 'training') {
      s.timer = ROUND_FRAMES;
      s.f[0].qi = 300;
      for (const f of s.f) {
        const inCombo = f.st === ST.HITSTUN || f.st === ST.AIR_HIT || f.st === ST.DOWN || f.st === ST.WALL || f.st === ST.CINE_VICTIM;
        if (!inCombo && f.st !== ST.GETUP) f.hp = Math.min(CHARS[f.ch].hp, f.hp + 25);
        if (f.hp <= 0) f.hp = 1;
      }
    }
    return s.events.slice();
  }

  loop = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    for (const k of pollMenuPad()) navKey(k);
    let frames = 0;
    let state: Match | null = null;
    let rate = 1;
    if (this.mode === 'online' && this.online) {
      const o = this.online;
      this.acc += dt;
      let n = 0;
      while (this.acc >= STEP && n < 5) {
        const res = o.sess.tick(this.current ? 0 : this.p1Input.read());
        frames += res.advanced;
        this.r.handleEvents(res.events, o.sess.state);
        this.acc -= STEP;
        n++;
      }
      if (n >= 5) this.acc = 0;
      state = o.sess.state;
      if (settings.showNet) this.hud.netInfo(`ping ${o.sess.stats.rtt}ms · delay ${o.sess.delay}f · rb ${o.sess.stats.maxRollback}f`);
      const quiet = o.sess.silence();
      if (o.gone || quiet > 15) {
        if (state.phase !== PH.MATCH_END && !this.resultsShown) {
          this.hud.netWarn(null);
          this.resultsShown = true;
          this.toast('Your opponent left the match.');
          setTimeout(() => this.showMenu(), 1800);
        }
      } else if (quiet > 2) this.hud.netWarn(quiet > 5 ? 'Opponent is away… waiting' : 'Connection unstable…');
      else this.hud.netWarn(null);
    } else if (this.mode === 'watch' && this.watch) {
      const w = this.watch;
      w.poll(now);
      if (!this.paused && !w.paused) {
        rate = w.s.koSlow > 0 ? 0.4 : 1;
        this.acc += dt * rate * w.speed;
        let n = 0;
        while (this.acc >= STEP && n < 12) {
          if (!w.canStep()) {
            this.acc = 0;
            break;
          }
          const ev = w.stepOnce();
          frames++;
          this.r.handleEvents(ev, w.s);
          this.acc -= STEP;
          n++;
        }
        if (n >= 12) this.acc = 0;
        this.watchTick(w);
      }
      state = w.s;
    } else if (this.run) {
      const s = this.run.s;
      if (!this.paused) {
        rate = s.koSlow > 0 && this.mode !== 'attract' ? 0.4 : 1;
        this.acc += dt * rate;
        let n = 0;
        while (this.acc >= STEP && n < 5) {
          const ev = this.stepLocal();
          frames++;
          this.r.handleEvents(ev, s);
          this.acc -= STEP;
          n++;
        }
        if (n >= 5) this.acc = 0;
      }
      state = s;
    }
    if (state) {
      if (state.phase === PH.MATCH_END) {
        if (!this.matchDoneAt) this.matchDoneAt = now;
        if (this.mode === 'attract' && now - this.matchDoneAt > 2500) this.startAttract();
        else if (this.mode === 'watch' && !this.resultsShown && now - this.matchDoneAt > 2600) this.showWatchEnd();
        else if (this.mode !== 'attract' && this.mode !== 'watch' && !this.resultsShown && now - this.matchDoneAt > 2600) this.showResults(state);
      } else if (this.mode === 'watch' && this.watch && this.watch.data.status !== 'live' && this.watch.buffered() <= 0 && !this.resultsShown) {
        // bouts that ended by forfeit stop before the match does
        if (!this.matchDoneAt) this.matchDoneAt = now;
        else if (now - this.matchDoneAt > 1500) this.showWatchEnd();
      }
      this.r.render(state, this.paused ? 0 : dt * rate, frames);
      if (this.mode !== 'attract') {
        this.hud.update(state, dt);
        updateTouch(state.f[this.localSide ?? 0].qi);
      }
    }
    requestAnimationFrame(this.loop);
  };
}

export const GAME_LINK = GAME_URL;
