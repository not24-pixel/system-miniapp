import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    build: {
      target: 'es2020',
      rollupOptions: {
        output: {
          manualChunks(id) {
            const norm = id.replace(/\\/g, '/');
            if (!norm.includes('/node_modules/')) return;
            if (norm.includes('/node_modules/react/') || norm.includes('/node_modules/react-dom/')) {
              return 'vendor-react';
            }
            if (norm.includes('/node_modules/motion/') || norm.includes('/node_modules/framer-motion/')) {
              return 'vendor-motion';
            }
            if (norm.includes('/node_modules/recharts/') || norm.includes('/node_modules/d3-')) {
              return 'vendor-charts';
            }
            if (norm.includes('/node_modules/lucide-react/')) {
              return 'vendor-icons';
            }
          },
        },
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
