import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

// The whole suite on timers as coarse as Windows has them (vitest.windows-timers.ts): `pnpm test:windows-timers`.
export default mergeConfig(base, { test: { setupFiles: ['./vitest.windows-timers.ts'] } });
