// @doodle-lang/engine — the JS/TS embedding of the Doodle engine: the wasm loader, the
// re-exported wasm facade (DoodleInstance/DriveResult), and the fuel-sliced pump.

import init, { DoodleInstance, DriveResult, version } from '../wasm/doodle_wasm.js';
import type { InitInput } from '../wasm/doodle_wasm.js';

export { DoodleInstance, DriveResult, version };
export type { InitInput };
export * from './pump.js';

let ready: Promise<void> | undefined;

/**
 * Initializes the wasm engine (idempotent). In **Node** pass the wasm bytes
 * (`fs.readFileSync(...)`); in the **browser** pass a URL/Response, or nothing to fetch
 * `doodle_wasm_bg.wasm` relative to the module. Must resolve before constructing an
 * instance.
 */
export function loadEngine(wasm?: InitInput): Promise<void> {
  ready ??= init(wasm === undefined ? undefined : { module_or_path: wasm })
    .then(() => undefined)
    .catch((err: unknown) => {
      // Don't cache a rejected init — a transient failure (e.g. a fetch error) must be
      // retryable, and the wasm-bindgen loader itself latches only on success.
      ready = undefined;
      throw err;
    });
  return ready;
}
