import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The built app is served by the backend at /viewer/terminal (see
// backend/api/viewer.py), so production assets need that base. In dev the
// Vite server owns the root on :5177 and proxies /viewer/* (HTTP +
// WebSocket) to the backend. `python -m backend.dev` sets
// BRAIN_TERMINAL_BACKEND_PORT; standalone `npm run dev` falls back to 8011.
// https://vite.dev/config/
const BACKEND_PORT = process.env.BRAIN_TERMINAL_BACKEND_PORT ?? '8011'
const FRONTEND_PORT = Number(process.env.VIZ_FRONTEND_PORT ?? 5177)

export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/viewer/terminal/' : '/',
  plugins: [react()],
  server: {
    port: FRONTEND_PORT,
    strictPort: true,
    proxy: {
      '/viewer': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
}))
