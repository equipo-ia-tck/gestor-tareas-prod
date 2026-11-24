import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // El service worker se actualiza solo; los datos viven en IndexedDB y no se ven afectados.
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Marea',
        short_name: 'Marea',
        description: 'Marea, el gestor de tareas del equipo.',
        lang: 'es',
        start_url: './#/today',
        scope: './',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#1B2B4B',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Hoy', url: './#/today' },
          { name: 'Bandeja', url: './#/inbox' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // La IA del Asistente (WebLLM, embeddings) pesa varios MB: solo la descarga quien la activa.
        globIgnores: ['**/llmWorker-*.js', '**/embedWorker-*.js', '**/webllm-*.js'],
        // Rutas por hash: cualquier navegación sirve index.html desde la caché.
        navigateFallback: 'index.html',
        // La API del servidor (conectores) nunca se sirve desde la caché.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  base: './',
  // En desarrollo (5173), los conectores los da el servidor (npm start, 4173; GESTOR_API para otro).
  server: { proxy: { '/api': process.env.GESTOR_API ?? 'http://localhost:4173' } },
  // App local y cacheada como PWA: ~220 kB gzip es aceptable y no merece trocear el bundle.
  build: { chunkSizeWarningLimit: 1000 },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
});
