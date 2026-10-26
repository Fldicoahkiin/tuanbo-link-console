import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ffmpegDeadline, watchOutputGrowth } from './ffmpeg-deadline';

// Node stands in for a stalled FFmpeg: it never finishes on its own.
const stalled = (answersQuit: boolean) => spawn(process.execPath, ['-e', answersQuit
  ? "process.stdin.on('data', data => { if (String(data).includes('q')) process.exit(0); }); setInterval(() => {}, 1000);"
  : 'setInterval(() => {}, 1000);'], { stdio: ['pipe', 'ignore', 'ignore'] });

describe('ffmpegDeadline', () => {
  it('超时后明确报错并请求 FFmpeg 正常退出', async () => {
    const child = stalled(true), fail = vi.fn();
    ffmpegDeadline(child, '提取音轨', 200, fail);
    const [code] = await once(child, 'close') as [number | null];
    expect(fail).toHaveBeenCalledOnce();
    expect((fail.mock.calls[0]?.[0] as Error).message).toBe('提取音轨超过 1 秒仍未完成，已停止 FFmpeg');
    expect(code).toBe(0);
  });

  it('请求退出后仍不结束的进程在 5 秒后被结束', async () => {
    const child = stalled(false); child.stdin.end();
    const fail = vi.fn();
    ffmpegDeadline(child, '生成编辑预览', 200, fail);
    const [, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    expect(fail).toHaveBeenCalledOnce();
    expect(signal ?? 'exited').not.toBe('exited');
  }, 15_000);

  it('按时完成不报错', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'ignore', 'ignore'] }), fail = vi.fn();
    ffmpegDeadline(child, '读取媒体信息', 5_000, fail);
    await once(child, 'close');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(fail).not.toHaveBeenCalled();
  });
});

describe('watchOutputGrowth', () => {
  it('输出文件持续增长时不报停滞，停止增长超过时限才报', async () => {
    const output = join(await mkdtemp(join(tmpdir(), 'tblink-growth-')), 'decode.pcm');
    await writeFile(output, 'a');
    const stalled = vi.fn();
    const stop = watchOutputGrowth(output, { intervalMs: 50, stallMs: 300 }, stalled);
    for (let index = 0; index < 8; index++) { await new Promise(resolve => setTimeout(resolve, 50)); await appendFile(output, 'a'); }
    expect(stalled).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledOnce(), { timeout: 2_000 });
    stop();
  });

  it('输出文件一直没有出现也算停滞', async () => {
    const stalled = vi.fn();
    const stop = watchOutputGrowth(join(tmpdir(), `tblink-missing-${crypto.randomUUID()}.pcm`), { intervalMs: 50, stallMs: 200 }, stalled);
    await vi.waitFor(() => expect(stalled).toHaveBeenCalledOnce(), { timeout: 2_000 });
    stop();
  });
});
