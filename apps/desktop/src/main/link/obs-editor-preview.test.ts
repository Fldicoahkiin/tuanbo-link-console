import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ObsEditorPreview } from './obs-editor-preview';
const requestSchema = z.object({ session: z.string(), sources: z.array(z.object({ name: z.string(), nonce: z.string() })) });

describe('OBS 编辑预览心跳', () => {
  it('导出文件不代表已加载，必须收到当前 OBS 的新鲜状态回读', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-preview-'));
    const preview = new ObsEditorPreview(directory, () => Promise.resolve(123));
    preview.configure('ws://127.0.0.1:4455');
    await preview.exportScript();
    const unloaded = await preview.getStatus();
    expect(unloaded.ready).toBe(false);
    expect(unloaded.message).toContain('还没加载');
    const statusPath = join(directory, '123.status.json');
    await writeFile(statusPath, JSON.stringify({ version: 1, pid: 123, error: '' }));
    expect((await preview.getStatus()).ready).toBe(true);
    await writeFile(statusPath, JSON.stringify({ version: 1, pid: 123, error: '读取来源失败' }));
    expect(await preview.getStatus()).toEqual({ ready: false, message: 'OBS 预览脚本错误：读取来源失败' });
    await utimes(statusPath, new Date(0), new Date(0));
    const expired = await preview.getStatus();
    expect(expired.ready).toBe(false);
    expect(expired.message).toContain('没有运行');
    await writeFile(statusPath, JSON.stringify({ version: 1, pid: 456, error: '' }));
    expect((await preview.getStatus()).ready).toBe(false);
  });
  it('并发来源保持同一会话，刷新心跳且断开后不再写入', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-preview-'));
    const preview = new ObsEditorPreview(directory, () => Promise.resolve(123));
    preview.configure('ws://127.0.0.1:4455');
    await Promise.all([preview.touch('摄像头'), preview.touch('显示器')]);
    const first = requestSchema.parse(JSON.parse(await readFile(join(directory, '123.json'), 'utf8')));
    expect(first.sources.map((item: { name: string }) => item.name)).toEqual(['摄像头', '显示器']);
    await preview.touch('摄像头');
    const next = requestSchema.parse(JSON.parse(await readFile(join(directory, '123.json'), 'utf8')));
    expect(next.session).toBe(first.session);
    expect(next.sources[0]?.nonce).not.toBe(first.sources[0]?.nonce);
    preview.clear();
    await preview.touch('其他来源');
    expect(JSON.parse(await readFile(join(directory, '123.json'), 'utf8'))).toEqual(next);
  });

  it('远程 OBS 不向本机采集桥发送请求', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-preview-'));
    const preview = new ObsEditorPreview(directory);
    preview.configure('ws://192.0.2.10:4455');
    await preview.touch('摄像头');
    expect(await readdir(directory)).toEqual([]);
  });

  it('切换连接时拒绝迟到的旧目标查询', async () => {
    let resolvePid: (pid: number) => void = () => { throw new Error('查询尚未开始'); };
    const directory = await mkdtemp(join(tmpdir(), 'tblink-preview-'));
    const lookup = vi.fn(() => new Promise<number>((resolve) => { resolvePid = resolve; }));
    const preview = new ObsEditorPreview(directory, lookup);
    preview.configure('ws://127.0.0.1:4455');
    const pending = preview.touch('摄像头');
    preview.clear();
    resolvePid(123);
    await pending;
    expect(await readdir(directory)).toEqual([]);
  });

  it('目标验证失败明确报错，不写入其他 OBS 进程', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tblink-preview-'));
    const preview = new ObsEditorPreview(directory, () => Promise.reject(new Error('端口不属于 OBS')));
    preview.configure('ws://127.0.0.1:4455');
    await expect(preview.touch('摄像头')).rejects.toThrow('端口不属于 OBS');
    expect(await readdir(directory)).toEqual([]);
  });
});
