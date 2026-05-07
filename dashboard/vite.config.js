import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const configuredDevPort = Number.parseInt(process.env.TORQUE_DASHBOARD_DEV_PORT || process.env.VITE_PORT || '', 10)
const devPort = Number.isFinite(configuredDevPort) && configuredDevPort > 0 ? configuredDevPort : 5173
const proxyTarget = process.env.TORQUE_DASHBOARD_PROXY_TARGET
  || `http://127.0.0.1:${process.env.TORQUE_DASHBOARD_PORT || '3456'}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: devPort,
    strictPort: Boolean(process.env.TORQUE_DASHBOARD_DEV_PORT || process.env.VITE_PORT),
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
