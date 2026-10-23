import { resolve } from 'node:path';
import { DEFAULT_PROGRAM_PATHS, type IntegrationProfile } from '@tb/schema';

/**
 * Absolute paths the operator chose in this session, which the window may hand
 * back: a main-process dialog's answer, a detection result, or a file dropped or
 * picked in the window (the preload reports those from a real File).
 */
export class ChosenPaths {
  private readonly keys = new Set<string>();

  constructor(private readonly refusal: string) {}

  choose(path: string): void {
    this.keys.add(pathKey(path));
  }

  has(path: string): boolean {
    return this.keys.has(pathKey(path));
  }

  require(path: string): void {
    if (!this.has(path)) throw new Error(`${this.refusal}，已拒绝：${path}`);
  }
}

/** A saved profile names only programs the operator chose, detection found, the stored profile
 * already had, or the default install locations; starting a program runs exactly these. */
export function requireChosenPrograms(profile: IntegrationProfile, stored: IntegrationProfile | null, chosen: Pick<ChosenPaths, 'require'>): void {
  for (const id of ['obs', 'p1', 'ma2', 'ma3d'] as const) {
    const path = profile[id]?.executablePath;
    if (path === undefined || path === stored?.[id]?.executablePath || (id === 'obs' || id === 'p1') && path === DEFAULT_PROGRAM_PATHS[id]) continue;
    chosen.require(path);
  }
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
