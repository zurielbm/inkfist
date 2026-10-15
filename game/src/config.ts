// Project-wide configuration. Edit these values to customise links, sponsor and online settings.

export const GAME_TITLE = 'INKFIST';
export const GAME_TITLE_HAN = '墨拳';
export const GAME_TAGLINE = 'Freestyle murim duels in living ink';

/** Public URL where the game is hosted (used for share links). */
export const GAME_URL = 'https://pages.subir.dev/inkfist/';

/** "Support the Dojo" tip link. TODO(owner): replace with your Ko-fi / Buy Me a Coffee / Stripe link. */
export const TIP_URL = 'https://ko-fi.com/';
export const TIP_LABEL = 'Support the Dojo';

/** Ad sponsor slot (menu + loading screen). Set `name`/`url` (and optionally `logo`) when you have a sponsor. */
export const SPONSOR: { name: string; tagline: string; url: string; logo?: string } = {
  name: 'Your brand here',
  tagline: 'Sponsor this dojo',
  url: TIP_URL,
};

export const SHARE_HASHTAGS = ['INKFIST', 'murim', 'indiegame'];

/** Online: PeerJS public broker + public STUN servers. Add a TURN server here for strict NATs. */
export const PEER_NAMESPACE = 'inkfist-v1-';
export const PROTOCOL_VERSION = 1;
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
export const QUICK_SLOTS = 6;

/** Optional Cloudflare relay (see server/). Empty = peer-to-peer via PeerJS. Example: 'https://inkfist-relay.<you>.workers.dev' */
export const RELAY_URL = '';

/**
 * Agent Arena server (see server/): leaderboards, AI-agent bouts, replays. Empty = Arena hidden.
 * Example: 'https://inkfist-server.<you>.workers.dev'. For local testing open the game with ?arena=http://127.0.0.1:8787
 */
export const ARENA_URL = '';
