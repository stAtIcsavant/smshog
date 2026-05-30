/**
 * smshog-twilio — ESM entry point
 * Re-exports everything from the CJS module via createRequire.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { patchTwilio, unpatchTwilio, createSmshogClient } = require('./index.js');
export { patchTwilio, unpatchTwilio, createSmshogClient };
