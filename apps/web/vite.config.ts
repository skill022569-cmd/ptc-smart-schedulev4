import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react-vendor', test: /node_modules[\\/](react|react-dom|scheduler)/, priority: 20 },
            { name: 'charts-vendor', test: /node_modules[\\/](recharts|d3-|victory-vendor)/, priority: 15 },
            { name: 'dnd-vendor', test: /node_modules[\\/]@dnd-kit/, priority: 15 },
            { name: 'icons-vendor', test: /node_modules[\\/]lucide-react/, priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
