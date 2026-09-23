import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config: il frontend gira su http://127.0.0.1:3000 durante lo sviluppo,
// mentre Tauri lo carica dentro la WebView2 di Windows.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
});
