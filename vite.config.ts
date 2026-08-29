import { defineConfig } from 'vite';

/**
 * Vite configuration for the audio-to-text POC.
 *
 * Transcription runs server-side via Groq; the browser only handles UI,
 * media capture and AudioContext work, none of which need SharedArrayBuffer.
 * COOP/COEP headers were previously set so crossOriginIsolated would unlock
 * pthreads for the in-browser whisper.cpp WASM build; that path has been
 * removed, so the headers are no longer needed (and would block embedding
 * the app in an iframe on other origins).
 */
export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
  },
});
