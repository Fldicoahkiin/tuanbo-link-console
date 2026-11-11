import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test run gets a temp folder of its own and removes it when the run ends.
 *
 * About sixty test files make folders under the system temp folder (`mkdtemp(join(tmpdir(), …))`) and a third of them
 * never remove what they made. One run leaves tens of megabytes of decoded audio behind, and a few hundred runs filled
 * the disk of the machine they ran on (2026-11-11). `os.tmpdir()` reads these variables and the workers start after
 * this, so whatever a test, or a program a test starts, writes to "the temp folder" lands in this one folder.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-vitest-'));
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = directory;
  return async () => {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      // A file something still holds open (Windows) must not fail a run whose tests passed: say where the leftovers are.
      console.warn(`[vitest] could not remove this run's temp folder: ${directory}`, error);
    }
  };
}
