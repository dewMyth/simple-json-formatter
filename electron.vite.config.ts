import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // CodeMirror injects <style> elements at runtime.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Vite's dev server needs inline scripts (React refresh preamble), websockets for HMR and
// cross-origin fetches to the jsonlens:// file protocol.
const DEV_CSP = PROD_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
  .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:* jsonlens:")
  .replace("worker-src 'self'", "worker-src 'self' blob:");

function cspPlugin(): Plugin {
  return {
    name: 'jsonlens-csp',
    transformIndexHtml(html, ctx) {
      return html.replace('__CSP__', ctx.server ? DEV_CSP : PROD_CSP);
    },
  };
}

export default defineConfig({
  main: {
    // DECISION: electron-store v12 is ESM-only; bundle it into the CJS main output
    // instead of externalising it, so we don't depend on require(esm) behaviour.
    build: { externalizeDeps: { exclude: ['electron-store'] } },
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@shared': resolve('src/shared'), '@worker': resolve('src/worker') } },
    plugins: [react(), cspPlugin()],
    worker: { format: 'es' },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } },
    },
  },
});
