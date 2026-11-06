import { defineConfig } from 'vite';
import react from "@vitejs/plugin-react";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { plugin } from 'postcss';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
    open: true,
    proxy: {
      '/api/gtimg-web': {
        target: 'https://web.ifzq.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gtimg-web/, '')
      },
      '/api/gtimg-ifzq': {
        target: 'https://ifzq.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gtimg-ifzq/, '')
      },
      '/api/gtimg-qt': {
        target: 'https://qt.gtimg.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gtimg-qt/, '')
      },
      '/api/proxy-qq': {
        target: 'https://proxy.finance.qq.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/proxy-qq/, '')
      },
      '/api/em-dcw': {
        target: 'https://datacenter-web.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/em-dcw/, '')
      }
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    target: 'esnext'
  },
  plugins: [
    {
      name: 'copy-data-dir',
      closeBundle() {
        const srcDir = path.resolve(__dirname, 'data');
        const destDir = path.resolve(__dirname, 'dist', 'data');
        if (fs.existsSync(srcDir)) {
          fs.mkdirSync(destDir, { recursive: true });
          fs.readdirSync(srcDir).forEach(file => {
            fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
          });
          console.log('[Vite] 已将 data/ 目录复制到 dist/data/');
        }
      }
    },
    react(),
  ]
});
