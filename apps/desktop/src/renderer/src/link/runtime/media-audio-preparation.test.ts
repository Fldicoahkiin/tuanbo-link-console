import { expect, it, vi } from 'vitest';
import type { LinkMediaAsset } from '@tb/schema';
import { MediaAudioPreparation } from './media-audio-preparation';

const video = (id: string): LinkMediaAsset => ({ id, name: `${id}.mp4`, kind: 'video', folderId: null, relativePath: `assets/${id}.mp4`,
  sha256: 'a'.repeat(64), byteLength: 100, durationMs: 40000 });
const input = { documentId: 1, projectPath: 'D:/show/test.tblink', assets: [video('one'), video('two')], idle: true };

it('打开旧工程提前逐个准备；更新、切页和重复渲染不重复提取', async () => {
  let finish: (() => void) | undefined;
  const prepare = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; })).mockResolvedValue(undefined);
  const report = vi.fn(); const service = new MediaAudioPreparation(prepare, report);
  service.update(input); service.update({ ...input });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledWith({ projectPath: input.projectPath, sourcePath: 'D:/show/assets/one.mp4', durationMs: 40000 });
  finish!(); await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  service.update({ ...input });
  expect(prepare).toHaveBeenCalledTimes(2); expect(report).not.toHaveBeenCalled(); service.dispose();
});

it('播放开始不再发起下一项；停止后继续未准备项，不重试失败项', async () => {
  let reject: ((error: Error) => void) | undefined;
  const prepare = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const report = vi.fn(); const service = new MediaAudioPreparation(prepare, report);
  service.update(input); service.update({ ...input, idle: false });
  reject!(new Error('磁盘读取失败')); await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  expect(prepare).toHaveBeenCalledTimes(1);
  service.update(input); await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  service.update(input); expect(prepare).toHaveBeenCalledTimes(2); service.dispose();
});

it('切工程丢弃旧队列和迟到提示，卸载后不继续后台解码', async () => {
  let reject: ((error: Error) => void) | undefined;
  const prepare = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const report = vi.fn(); const service = new MediaAudioPreparation(prepare, report);
  service.update(input);
  service.update({ ...input, documentId: 2, projectPath: 'D:/other/show.tblink', assets: [video('new')] });
  reject!(new Error('旧工程失败')); await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
  expect(prepare.mock.calls[1]?.[0]).toMatchObject({ sourcePath: 'D:/other/assets/new.mp4' });
  expect(report).not.toHaveBeenCalled(); service.dispose(); service.update(input); expect(prepare).toHaveBeenCalledTimes(2);
});

it('无音轨是已准备结果；改变源身份才重新准备，图片不解码', async () => {
  const prepare = vi.fn().mockRejectedValueOnce(new Error('素材不包含音频轨道')).mockResolvedValue(undefined);
  const report = vi.fn(); const service = new MediaAudioPreparation(prepare, report);
  service.update({ ...input, assets: [video('one'), { ...video('image'), kind: 'image' }] });
  await Promise.resolve(); service.update({ ...input, assets: [video('one')] }); expect(prepare).toHaveBeenCalledTimes(1);
  service.update({ ...input, assets: [{ ...video('one'), sha256: 'b'.repeat(64) }] });
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2)); expect(report).not.toHaveBeenCalled(); service.dispose();
});
