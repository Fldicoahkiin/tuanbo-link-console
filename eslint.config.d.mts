import type { Linter } from 'eslint';

/** The types of eslint.config.mjs for the tests that read it (key-routing-scan.test.ts, 04 设计 K9). */
export declare const KEY_LISTENER_RESTRICTIONS: readonly { selector: string; message: string }[];
export declare const KEY_LISTENER_FILES: readonly string[];
export declare const KEY_LISTENER_EXCEPTIONS: readonly string[];
declare const config: Linter.Config[];
export default config;
