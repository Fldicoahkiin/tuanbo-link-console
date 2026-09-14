import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { allocateP1TimecodeRanges, frameNumberToTimecode, type MtcSample } from '@tb/core/link';
import { P1AutoFollowController } from './p1-auto-follow-controller';

function setup(prepare = vi.fn<(_id: string) => Promise<void>>().mockResolvedValue(), ids = ['a', 'b']) {
  const project = parseLinkProject({ ...createEmptyLinkProject('自动跟随'), rundown: ids.map((id) => ({
    id, title: id, referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/${id}.wav`, sha256: 'a'.repeat(64), durationMs: 30_000 }
  })) });
  project.p1AutoFollow = allocateP1TimecodeRanges(project);
  const dependencies = { prepare, ingest: vi.fn<(_sample: MtcSample) => Promise<void>>().mockResolvedValue(), fail: vi.fn(), interrupt: vi.fn() };
  return { controller: new P1AutoFollowController(project, dependencies), ...dependencies };
}
function sample(seconds: number): MtcSample {
  return { totalFrames: Math.round(seconds * 30), timecode: frameNumberToTimecode(Math.round(seconds * 30), '30'),
    frameRate: '30', direction: 'forward', receivedAtMs: performance.now() };
}
describe('P1 自动选歌控制器', () => {
  it('十首歌连续循环十轮，时间码不串歌、不重复准备、不丢样本', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `song-${index}`);
    const test = setup(undefined, ids);
    const expected: string[] = [];
    let samples = 0;
    for (let round = 0; round < 10; round += 1) {
      for (const [index, id] of ids.entries()) {
        expected.push(id);
        test.controller.push(sample(60 + index * 40));
        await vi.waitFor(() => expect(test.prepare).toHaveBeenCalledTimes(expected.length), { interval: 1 });
        await Promise.resolve();
        for (let frame = 2; frame < 900; frame += 2) test.controller.push(sample(60 + index * 40 + frame / 30));
        samples += 450;
        expect(test.ingest).toHaveBeenCalledTimes(samples);
        expect(test.ingest.mock.calls.slice(-450).map(([value]) => value.totalFrames))
          .toEqual(Array.from({ length: 450 }, (_, frame) => frame * 2));
      }
    }
    expect(test.prepare.mock.calls.map(([id]) => id)).toEqual(expected);
    expect(test.fail).not.toHaveBeenCalled();
    expect(test.interrupt).toHaveBeenCalledTimes(100);
  });
  it('上一首请求延迟失败不能中断正在准备的下一首', async () => {
    let rejectOld: (error: Error) => void = () => { throw new Error('旧请求未开始'); };
    let finishNext = (): void => { throw new Error('新准备未开始'); };
    const prepare = vi.fn<(_id: string) => Promise<void>>().mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishNext = resolve; }));
    const test = setup(prepare);
    test.ingest.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; }));
    test.controller.push(sample(60));
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(1));
    test.controller.push(sample(100));
    rejectOld(new Error('上一首 OBS 请求超时'));
    await Promise.resolve();
    finishNext();
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(2));
    expect(test.fail).not.toHaveBeenCalled();
  });
  it('停止监听期间完成的准备不会播放，恢复后重新点击才能开始', async () => {
    let finish = (): void => { throw new Error('准备未开始'); };
    const prepare = vi.fn<(_id: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue(undefined);
    const test = setup(prepare);
    test.controller.push(sample(60));
    test.controller.suspend();
    finish();
    await Promise.resolve();
    expect(test.ingest).not.toHaveBeenCalled();
    test.controller.enable();
    test.controller.push(sample(100));
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(1));
    expect(test.prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });
  it('OBS 媒体尚在解码时仍持续传递最新时间码', async () => {
    const test = setup();
    let release = (): void => { throw new Error('媒体请求未开始'); };
    test.ingest.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    test.controller.push(sample(60.1));
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(1));
    test.controller.push(sample(60.2));
    test.controller.push(sample(60.3));
    expect(test.ingest).toHaveBeenCalledTimes(3);
    release();
    expect(test.fail).not.toHaveBeenCalled();
  });
  it('点击切歌、同曲重播都重新准备，持续播放不重复准备', async () => {
    const test = setup();
    for (const [index, seconds] of [60.1, 61, 100.1, 101, 100.1].entries()) {
      test.controller.push(sample(seconds));
      await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(index + 1));
    }
    expect(test.prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b']);
    expect(test.fail).not.toHaveBeenCalled();
  });
  it('准备期间换歌不会执行旧歌的动作', async () => {
    let release = (): void => { throw new Error('准备未开始'); };
    const prepare = vi.fn<(_id: string) => Promise<void>>().mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const test = setup(prepare);
    test.controller.push(sample(60.1));
    test.controller.push(sample(100.1));
    release();
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(1));
    expect(test.prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(test.ingest.mock.calls[0]?.[0].totalFrames).toBe(3);
  });
  it('未知和中途时间码冻结；真实从头播放可恢复，手动停止仍须恢复监听', async () => {
    const test = setup();
    test.controller.push(sample(0));
    expect(test.fail).toHaveBeenCalledTimes(1);
    test.controller.push(sample(70));
    expect(test.prepare).not.toHaveBeenCalled();
    test.controller.push(sample(60.1));
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(1));
    test.controller.suspend(); test.controller.push(sample(100.1));
    expect(test.prepare).toHaveBeenCalledTimes(1);
    test.controller.enable(); test.controller.push(sample(100.1));
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(2));
  });
  it('准备失败不会循环重试同一首；下一首开头可恢复', async () => {
    const prepare = vi.fn<(_id: string) => Promise<void>>().mockRejectedValueOnce(new Error('OBS 不可用')).mockResolvedValue(undefined);
    const test = setup(prepare);
    test.controller.push(sample(60));
    await vi.waitFor(() => expect(test.fail).toHaveBeenCalledTimes(1));
    for (const frame of [2, 4, 6]) test.controller.push(sample(60 + frame / 30));
    expect(prepare).toHaveBeenCalledTimes(1);
    test.controller.push(sample(100));
    await vi.waitFor(() => expect(test.ingest).toHaveBeenCalledTimes(1));
    expect(prepare.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });
});
