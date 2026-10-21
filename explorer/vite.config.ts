import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` proxies the API to a running `nori explore --no-open --port 4310`.
const API = process.env['NORI_EXPLORER_API'] ?? 'http://127.0.0.1:4310';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: '../dist/ui', emptyOutDir: true },
  server: { proxy: { '/api': { target: API, changeOrigin: true } } },
});
