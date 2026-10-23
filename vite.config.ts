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
  // maplibre-gl pèse ~800 Ko minifié, c'est attendu.
  build: { chunkSizeWarningLimit: 1200 },
});
