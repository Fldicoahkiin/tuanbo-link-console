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

const programNames = { obs: 'OBS', p1: 'P1', ma2: 'MA2 onPC', ma3d: 'MA 3D' } as const;
/** OBS switches that only change how OBS opens; switches that start output (--startstreaming and the like) are left out. */
const obsSwitches = new Set(['--portable', '-p', '--multi', '-m', '--minimize-to-tray', '--disable-updater', '--disable-missing-files-check',
  '--disable-shutdown-check', '--verbose', '--unfiltered_log', '--always-on-top', '--studio-mode', '--safe-mode', '--only-bundled-plugins', '--disable-high-dpi-scaling']);
/** OBS options followed by a profile, scene collection or scene name. */
const obsNamedOptions = new Set(['--profile', '--collection', '--scene']);
const obsName = /^[^-"\u0000-\u001f\u007f][^"\u0000-\u001f\u007f]{0,255}$/;

/** A saved profile starts only programs the operator chose, detection found, the stored profile
 * already had, or the default install locations; from their own folder, a folder the stored
 * profile had or the operator chose (`folders`); with OBS's whitelisted switches and nothing for the others. */
export function requireChosenPrograms(profile: IntegrationProfile, stored: IntegrationProfile | null, chosen: Pick<ChosenPaths, 'require'>, folders: Pick<ChosenPaths, 'require'>): void {
  for (const id of ['obs', 'p1', 'ma2', 'ma3d'] as const) {
    const program = profile[id];
    if (!program) continue;
    const before = stored?.[id];
    const path = program.executablePath;
    if (path !== before?.executablePath && !((id === 'obs' || id === 'p1') && path === DEFAULT_PROGRAM_PATHS[id])) chosen.require(path);
    const folder = program.workingDirectory;
    if (folder !== before?.workingDirectory && pathKey(folder) !== pathKey(path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))))) folders.require(folder);
    requireArguments(id, program.arguments);
  }
}

function requireArguments(id: keyof typeof programNames, args: readonly string[]): void {
  if (id !== 'obs') {
    if (args.length > 0) throw new Error(`${programNames[id]} 不接受启动参数，已拒绝：${args.join(' ')}`);
    return;
  }
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (obsSwitches.has(argument)) continue;
    if (obsNamedOptions.has(argument) && obsName.test(args[index + 1] ?? '')) { index++; continue; }
    throw new Error(`OBS 启动参数不在允许范围内，已拒绝：${argument}`);
  }
}

function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
