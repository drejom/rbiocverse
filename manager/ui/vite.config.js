import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json'

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // TODO: Update when repo moves to new location
    __REPO_URL__: JSON.stringify('https://github.com/drejom/omhq-hpc-code-server-stack'),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to Express backend during development
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // Proxy images and other static assets from backend
      '/images': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
