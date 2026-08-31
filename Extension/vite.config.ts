import { defineConfig } from 'vite';
import { resolve } from 'path';

const __dirname = import.meta.dirname;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/Popup/Popup.html'),
        background: resolve(__dirname, 'src/Background/ServiceWorker.ts'),
        content: resolve(__dirname, 'src/Content/Content.ts'),
      },
      output: {
        entryFileNames: '[name]/[name].js',
        chunkFileNames: 'shared/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
