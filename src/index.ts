import type { API } from 'homebridge';

import { MorphPlatform } from './platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/** Homebridge entry point. */
export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MorphPlatform);
};
