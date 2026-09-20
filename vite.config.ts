import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(import.meta.dirname, 'src/ui'),
  // Electron 은 dist/ui/index.html 을 file:// 로 연다. 절대 경로 자산은 file:// 에서 깨진다.
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/ui'),
    emptyOutDir: true,
  },
});
