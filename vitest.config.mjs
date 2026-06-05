import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // obsidian has "main": "" so vite can't resolve it — point to our stub.
      obsidian: resolve(__dirname, 'src/__mocks__/obsidian.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
