import type { API } from 'homebridge' with { 'resolution-mode': 'import' };

import { MorphPlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Homebridge entry point.
 *
 * Uses `export =` so the compiled CommonJS sets `module.exports` to the
 * function itself. Homebridge loads plugins with a dynamic `import()`, which
 * surfaces that as the namespace's `default` — the shape it checks first.
 * A plain `export default` would instead nest it one level deeper.
 */
const initializer = (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MorphPlatform);
};

export = initializer;
