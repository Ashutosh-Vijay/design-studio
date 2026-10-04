import { defineConfig } from 'vite';
// spec/ (git-ignored) holds a private spec copy; it's served as the public dir.
export default defineConfig({
  publicDir: 'spec',
  build: { target: 'es2022', rollupOptions: { input: { index: 'index.html', monaco: 'monaco.html', cm: 'cm.html' } } },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
