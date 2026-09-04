import path from 'node:path';
import { defineConfig } from 'vitest/config';

// The card codec is deliberately free of any DOM/React dependency, so the whole
// suite runs in plain Node. `DecompressionStream` (used for zTXt chunks) and
// `atob`/`btoa` are native from Node 18 on.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
