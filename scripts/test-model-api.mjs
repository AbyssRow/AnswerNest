import { build } from 'vite'
import { spawnSync } from 'node:child_process'

// Test the minified code as well: protocol templates embed self-contained runtime functions.
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: 'tmp/model-api-tests',
    emptyOutDir: true,
    minify: 'esbuild',
    lib: { entry: 'tests/model-api.test.ts', formats: ['es'], fileName: () => 'model-api.test.mjs' },
    rollupOptions: { external: ['node:assert/strict', 'node:test', 'node:fs', 'node:path'] },
  },
})
const result = spawnSync(process.execPath, ['--test', 'tmp/model-api-tests/model-api.test.mjs'], { stdio: 'inherit' })
process.exitCode = result.status ?? 1
