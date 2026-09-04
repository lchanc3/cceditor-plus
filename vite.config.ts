import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

// `base` is the only thing that differs between hosts:
//   Vercel / Cloudflare Workers -> "/"            (default)
//   GitHub Pages project site   -> "/<repo>/"     (set VITE_BASE in CI)
//
// No `define` of any API key here, on purpose. Keys are supplied by the user at
// runtime and live only in their browser's localStorage, which is what lets the
// exact same build be served from a fully static host like GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    // Loopback only (Vite's default). The old config forced host 0.0.0.0, which
    // AI Studio's container needed but which exposes the dev server to the whole
    // LAN and is the binding a local firewall is most likely to block.
    // Use `npm run dev -- --host` if you deliberately want to reach it from a phone.
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
