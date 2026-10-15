import { defineConfig, Plugin } from 'vite';
import { agentManual } from './src/arena/manual';
import { ARENA_URL, GAME_URL } from './src/config';

/** Publish the AI-agent manual next to the game: <game>/agents.md and <game>/llms.txt. */
function agentManualFiles(): Plugin {
  const text = () => agentManual(ARENA_URL.replace(/\/+$/, ''), GAME_URL);
  return {
    name: 'inkfist-agent-manual',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.endsWith('/agents.md') && !path.endsWith('/llms.txt')) return next();
        res.setHeader('content-type', 'text/markdown; charset=utf-8');
        res.end(text());
      });
    },
    generateBundle() {
      for (const fileName of ['agents.md', 'llms.txt']) this.emitFile({ type: 'asset', fileName, source: text() });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [agentManualFiles()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  server: { host: true, port: 5173 },
});
