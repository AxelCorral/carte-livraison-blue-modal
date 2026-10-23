import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// En dev, /api/distance est servi par le même handler que la fonction Vercel.
function devApi(): Plugin {
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use('/api/distance', async (req, res) => {
        const { GET } = await server.ssrLoadModule('/api/distance.ts');
        const response: Response = await GET(new Request(`http://localhost${req.originalUrl}`));
        res.statusCode = response.status;
        response.headers.forEach((v, k) => res.setHeader(k, v));
        res.end(await response.text());
      });
    },
  };
}

export default defineConfig({
  plugins: [devApi()],
  build: {
    // maplibre-gl pèse ~800 Ko minifié, c'est attendu.
    chunkSizeWarningLimit: 1200,
    // 3 pages : calculateur (départ par défaut), comparaison des départs, carte seule.
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        comparer: resolve(import.meta.dirname, 'comparer.html'),
        carte: resolve(import.meta.dirname, 'carte.html'),
      },
    },
  },
});
