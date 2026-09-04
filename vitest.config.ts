import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['Backend', 'Extension'],
  },
});