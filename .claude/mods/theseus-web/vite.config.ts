import react from '@vitejs/plugin-react'
import { transform } from 'esbuild'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// The plugin's core files the page imports (its view model, its events) sit under the plugin's own tsconfig, which
// extends the types the engine writes and a build has not: they are compiled here with these options alone
const CORE = /[\\/]theseus[\\/](core|types)[\\/].*\.ts$/

const core = (): Plugin => ({
  name: 'theseus-core',
  enforce: 'pre',
  async transform(code, id) {
    if (!CORE.test(id)) return null
    const done = await transform(code, { loader: 'ts', format: 'esm', target: 'es2022', sourcefile: id, tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } } })

    return { code: done.code, map: done.map || null }
  },
})

// One self-contained page: its script and its styles inline, so it loads nothing from anywhere, and the same file
// opened alone, its run's data in it, is the run's report
export default defineConfig({
  plugins: [core(), react(), viteSingleFile()],
  esbuild: { exclude: CORE },
  build: { outDir: '../theseus/ui/dist', emptyOutDir: true, assetsInlineLimit: Number.MAX_SAFE_INTEGER, cssCodeSplit: false },
})
