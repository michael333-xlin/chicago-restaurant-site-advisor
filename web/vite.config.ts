import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // maplibre-gl 6 loads its worker relative to its own module URL; pre-bundling breaks that path.
  optimizeDeps: { exclude: ['maplibre-gl'] },
  server: { port: 5180 },
})
