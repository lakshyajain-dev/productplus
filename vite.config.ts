import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:4000' } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/\/(react|react-dom|react-router|@tanstack)\//.test(id)) return 'framework';
          if (/\/(recharts|d3-[^/]+)\//.test(id)) return 'charts';
          if (id.includes('/framer-motion/')) return 'motion';
          if (id.includes('/lucide-react/')) return 'icons';
        },
      },
    },
  },
});
