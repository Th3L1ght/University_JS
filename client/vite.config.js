import { defineConfig } from 'vite';

/**
 * Збірка для запуску подвійним кліком (file://).
 * Chrome/Edge вважають file:// джерелом "null" і блокують <script type="module">
 * та ресурси з атрибутом crossorigin. Тому в продакшен-збірці бандл віддається
 * одним класичним IIFE-скриптом, а index.html очищається від type="module" і crossorigin.
 * У режимі розробки (npm run dev) використовуються звичайні ES-модулі.
 */
function fileProtocolCompat() {
  return {
    name: 'file-protocol-compat',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/<script type="module" crossorigin/g, '<script defer')
          .replace(/ crossorigin(="[^"]*")?/g, '');
      },
    },
  };
}

// Адреса Node-сервера, на який dev-режим проксує /api і /ws.
const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:3000';

export default defineConfig({
  base: './',
  plugins: [fileProtocolCompat()],
  server: {
    proxy: {
      '/api': SERVER_URL,
      '/ws': { target: SERVER_URL.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    modulePreload: false,
    rollupOptions: {
      // hex-хеш: імена файлів лише в нижньому регістрі (регістрозалежні ФС, Linux, GitHub Pages).
      output: { format: 'iife', hashCharacters: 'hex' },
    },
  },
});
