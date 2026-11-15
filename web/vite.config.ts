import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development the Python server (server/app.py, port 8000) serves /data (block exports) and /api.
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react()],
  // maplibre-gl 6 loads its worker relative to its own module URL; pre-bundling breaks that path.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  server: {
    port: 5180,
    proxy: { '/api': BACKEND, '/data': BACKEND },
  },
  // Map / WebGL libraries in their own chunks: the app shell renders first and the vendor chunks cache across
  // deploys. Storefront3D (three.js) is already lazy-loaded by SiteDeepDive.
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'maplibre', test: /node_modules[\\/](maplibre-gl|react-map-gl|@vis\.gl[\\/]react-maplibre)/ },
            { name: 'deckgl', test: /node_modules[\\/](@deck\.gl|@luma\.gl|@math\.gl|@loaders\.gl|@probe\.gl|h3-js)/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
})
