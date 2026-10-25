import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { FeedbackEnvironment } from '@tb/schema';

export type CrashDumpEntry = { file: string; bytes: number; modifiedAt: string };

/**
 * The newest crash dumps Electron left (name, size, time only; the contents are never packaged), so a
 * diagnostic package shows whether and when the app crashed. Looks two folders deep, as crashpad nests
 * reports under `reports/`.
 */
export async function recentCrashDumps(directory: string, limit = 10): Promise<CrashDumpEntry[]> {
  const found: CrashDumpEntry[] = [];
  const walk = async (folder: string, depth: number): Promise<void> => {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth < 2) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) {
        const info = await stat(path);
        found.push({ file: relative(directory, path), bytes: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
  };
  await walk(directory, 0);
  return found.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, limit);
}

export type EnvironmentFacts = {
  windowsRelease: string; arch: string; cpu: string; totalMemoryBytes: number;
  obs: { status: string; obsVersion: string | null };
  ma2: { state: string; version: string | null };
  runtimeActive: boolean; playerStatus: string | null;
};

const obsStates: Record<string, string> = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', disconnected: '未连接', error: '异常' };
const ma2States: Record<string, string> = { connected: '已连接', connecting: '连接中', authenticating: '登录中', disconnected: '未连接' };

/** The few lines the operations console shows beside a report, without opening its diagnostic package. */
export function feedbackEnvironment(facts: EnvironmentFacts): Omit<FeedbackEnvironment, 'license'> {
  const cut = (text: string, max: number) => text.length > max ? text.slice(0, max) : text;
  return {
    os: cut(`Windows ${facts.windowsRelease} · ${facts.arch} · ${facts.cpu} · 内存 ${(facts.totalMemoryBytes / 1024 ** 3).toFixed(0)} GB`, 160),
    obs: cut(`OBS ${obsStates[facts.obs.status] ?? facts.obs.status}${facts.obs.obsVersion ? ` · ${facts.obs.obsVersion}` : ''}`, 80),
    ma2: cut(`MA2 ${ma2States[facts.ma2.state] ?? facts.ma2.state}${facts.ma2.version ? ` · ${facts.ma2.version}` : ''}`, 80),
    playback: cut(`${facts.runtimeActive ? '演出运行中' : '未在演出'}${facts.playerStatus ? ` · 播放器 ${facts.playerStatus}` : ''}`, 160)
  };
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
