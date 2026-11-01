import { defineConfig } from 'vite';
import { resolve } from 'path';

const __dirname = import.meta.dirname;

export default defineConfig(({ mode }) => {
  const contentBuild = mode === 'content';
  const developmentWatch = process.env.ANSWERSENSE_DEV_WATCH === '1';

  return {
    build: {
      rollupOptions: {
        input: contentBuild
          ? resolve(__dirname, 'src/Content/Content.ts')
          : {
              background: resolve(__dirname, 'src/Background/ServiceWorker.ts'),
            },
        output: contentBuild
          ? {
              format: 'iife',
              entryFileNames: 'content/content.js',
            }
          : {
              entryFileNames: '[name]/[name].js',
              chunkFileNames: 'shared/[name].[hash].js',
              assetFileNames: 'assets/[name].[hash][extname]',
            },
      },
      outDir: 'dist',
      emptyOutDir: !contentBuild && !developmentWatch,
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
  };
});
