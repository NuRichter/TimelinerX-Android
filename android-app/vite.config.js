import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    outDir: 'dist',
    target: 'chrome90',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
