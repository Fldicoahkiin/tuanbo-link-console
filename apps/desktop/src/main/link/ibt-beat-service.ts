import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, unlink, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseIbtBeats } from '@tb/core/link';
import type { AudioBeatAnalysis } from '@tb/schema';
import { hasAudiblePcm } from './pcm-audibility';

export function ibtExecutable(resourcesPath?: string): string {
  return resourcesPath ? join(resourcesPath, 'ibt', 'ibt.exe') : resolve(__dirname, '../../../../tools/ibt/bin/ibt.exe');
}

export async function analyzeIbtAudio(input: string, durationMs: number, decode: (input: string, output: string) => Promise<void>, executable = ibtExecutable()): Promise<AudioBeatAnalysis> {
  await access(executable).catch((cause: unknown) => { throw new Error('IBT 检测引擎无法读取，请重新构建或安装联动台', { cause }); });
  if (durationMs < 1000) throw new Error('音频不足一秒，无法可靠分析节拍');
  const directory = await mkdtemp(join(tmpdir(), 'tblink-ibt-'));
  try {
    await decode(input, join(directory, 'input.wav'));
    if (!await hasAudiblePcm(join(directory, 'input.wav'))) return { dense: [], standard: [], sparse: [] };
    await runIbt(executable, directory);
    const result = join(directory, 'beats.txt');
    if ((await stat(result)).size > 8_000_000) throw new Error('IBT 返回的节拍文件过大');
    return parseIbtBeats(await readFile(result, 'utf8'), durationMs);
  } finally {
    // Only our unique workspace and its immediate files are removed.
    for (const file of await readdir(directory, { withFileTypes: true })) {
      if (file.isFile()) await unlink(join(directory, file.name));
    }
    await rmdir(directory);
  }
}

function runIbt(executable: string, cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, ['-off', '-o', 'beats', 'input.wav', 'beats.txt'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const capture = (data: Buffer): void => { output = (output + data.toString('utf8')).slice(-8000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.stdout.on('error', reject); child.stderr.on('error', reject); child.on('error', reject);
    child.on('close', code => { if (code === 0) resolveRun(); else reject(new Error(`IBT 节拍检测失败（${String(code)}）：${output}`)); });
  });
}
