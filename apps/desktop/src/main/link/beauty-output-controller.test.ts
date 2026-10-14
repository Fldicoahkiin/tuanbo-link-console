import { describe, expect, it, vi } from 'vitest';
import { beautyBasicValuesSchema, neutralBeautyValues, type BeautyRuntimeState, type BeautyApply } from '@tb/schema';
import { BeautyOutputController } from './beauty-output-controller';

const values = beautyBasicValuesSchema.parse({ ...neutralBeautyValues, smooth: 10 });
function setup() {
  let state: BeautyRuntimeState = { phase: 'idle', sourceName: null, filterName: null, faces: 0, message: '' };
  const runtime = {
    status: vi.fn(() => state),
    start: vi.fn((sourceName: string) => { state = { phase: 'waiting', sourceName, filterName: '团播·人像美颜', faces: 0, message: '' }; return Promise.resolve(state); }),
    stop: vi.fn(() => { state = { phase: 'idle', sourceName: null, filterName: null, faces: 0, message: '' }; return Promise.resolve(); })
  };
  const beauty = {
    programScene: vi.fn(() => Promise.resolve('场景 A')),
    disable: vi.fn(() => Promise.resolve()),
    apply: vi.fn((payload: BeautyApply) => Promise.resolve({ ...payload, enabled: true, liveMode: true, uniform: true }))
  };
  const log = vi.fn();
  return { runtime, beauty, log, controller: new BeautyOutputController(runtime, beauty, log) };
}

describe('composed output beauty', () => {
  it('零参数显示原画面，连接和切机位均不创建滤镜或启动分析', async () => {
    const { controller, runtime, beauty } = setup();
    controller.connection(true);
    expect(await controller.configure(neutralBeautyValues)).toBeNull();
    controller.sceneChanged();
    await controller.configure(neutralBeautyValues);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(beauty.programScene).not.toHaveBeenCalled();
    expect(beauty.apply).not.toHaveBeenCalled();
    expect(beauty.disable).not.toHaveBeenCalled();
  });

  it('参数归零仅停用当前受管滤镜，之后调整参数可正常恢复', async () => {
    const { controller, runtime, beauty } = setup();
    controller.connection(true); await controller.configure(values);
    runtime.stop.mockClear();
    expect(await controller.configure(neutralBeautyValues)).toBeNull();
    expect(beauty.disable).toHaveBeenCalledExactlyOnceWith({ sourceName: '场景 A', filterName: '团播·人像美颜' });
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(controller.status().phase).toBe('idle');
    await controller.configure({ ...values, eye: 30 });
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(beauty.apply).toHaveBeenLastCalledWith({ sourceName: '场景 A', filterName: '团播·人像美颜', values: { ...values, eye: 30 } });
  });

  it('归零时停用失败明确报错，不自动重试或假装已停止', async () => {
    const { controller, runtime, beauty, log } = setup();
    controller.connection(true); await controller.configure(values);
    beauty.disable.mockRejectedValue(new Error('关闭滤镜失败'));
    runtime.stop.mockClear();
    await expect(controller.configure(neutralBeautyValues)).rejects.toThrow('关闭滤镜失败');
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(controller.status().phase).toBe('error');
  });

  it('waits offline, then starts on the program scene without an input selection', async () => {
    const { controller, runtime, beauty } = setup();
    expect(await controller.configure(values)).toBeNull();
    expect(runtime.start).not.toHaveBeenCalled();
    controller.connection(true);
    const confirmed = await controller.configure({ ...values, smooth: 40 });
    expect(runtime.start).toHaveBeenCalledExactlyOnceWith('场景 A');
    expect(beauty.apply).toHaveBeenLastCalledWith({ sourceName: '场景 A', filterName: '团播·人像美颜', values: { ...values, smooth: 40 } });
    expect(confirmed?.values.smooth).toBe(40);
  });

  it('keeps the engine running while values change', async () => {
    const { controller, runtime } = setup();
    controller.connection(true);
    await controller.configure(values);
    await controller.configure({ ...values, eye: 65 });
    expect(runtime.start).toHaveBeenCalledTimes(1);
  });

  it('disables only the previous owned filter and follows a program switch', async () => {
    const { controller, runtime, beauty } = setup();
    controller.connection(true); await controller.configure(values);
    beauty.programScene.mockResolvedValue('场景 B'); controller.sceneChanged();
    await controller.configure({ ...values, white: 20 });
    expect(beauty.disable).toHaveBeenCalledExactlyOnceWith({ sourceName: '场景 A', filterName: '团播·人像美颜' });
    expect(runtime.start).toHaveBeenLastCalledWith('场景 B');
    expect(beauty.apply).toHaveBeenLastCalledWith({ sourceName: '场景 B', filterName: '团播·人像美颜', values: { ...values, white: 20 } });
  });

  it('coalesces changes while querying the output and never applies stale values', async () => {
    const { controller, beauty } = setup();
    let release: (scene: string) => void = () => { throw new Error('Missing query'); };
    beauty.programScene.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    controller.connection(true);
    const first = controller.configure(values);
    await Promise.resolve(); await Promise.resolve();
    const last = controller.configure({ ...values, smooth: 75 });
    release('场景 A');
    await Promise.all([first, last]);
    expect(beauty.apply).toHaveBeenCalledTimes(1);
    expect(beauty.apply.mock.calls[0]?.[0].values.smooth).toBe(75);
  });

  it('修改参数时核实当前输出，漏收场景事件也不继续写入旧画面', async () => {
    const { controller, runtime, beauty } = setup();
    controller.connection(true); await controller.configure(values);
    beauty.programScene.mockResolvedValue('场景 B');
    await controller.configure({ ...values, smooth: 45 });
    expect(runtime.start).toHaveBeenLastCalledWith('场景 B');
    expect(beauty.apply).toHaveBeenLastCalledWith({ sourceName: '场景 B', filterName: '团播·人像美颜', values: { ...values, smooth: 45 } });
  });

  it('reports external errors without an automatic retry loop', async () => {
    const { controller, beauty, log } = setup();
    beauty.programScene.mockRejectedValue(new Error('OBS unavailable'));
    controller.connection(true);
    await expect(controller.configure(values)).rejects.toThrow('OBS unavailable');
    await expect(controller.configure({ ...values, eye: 50 })).rejects.toThrow('OBS unavailable');
    expect(beauty.programScene).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(controller.status().phase).toBe('error');
  });
});
