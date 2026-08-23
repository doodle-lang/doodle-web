import { defineConfig } from 'vite';

// The demo is a plain static site (index.html entry). `build:app` bundles it into
// dist/app/ (under the git-ignored dist/); the wasm-bindgen glue's
// `new URL('doodle_wasm_bg.wasm', import.meta.url)` is picked up by Vite as an asset, so
// `loadEngine()` fetches the co-located wasm with no extra wiring.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist/app',
    emptyOutDir: true,
  },
});
