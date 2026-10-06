import { afterEach, describe, expect, it, vi } from 'vitest';
import { InternalAudioOutput } from './internal-audio-output';

afterEach(() => vi.unstubAllGlobals());
function monitoringStream() {
  const stream = {
    active: true,
    clone: () => monitoringStream(),
    getTracks: () => [{ stop: () => { stream.active = false; } }]
  };
  return stream;
}
function fixture() {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const sink = vi.fn((id: string) => { void id; return Promise.resolve(); });
  const close = vi.fn(() => Promise.resolve());
  const createSource = vi.fn(() => source);
  const contexts: { sampleRate: number }[] = [];
  const analysers: { fftSize: number; smoothingTimeConstant: number; disconnect: ReturnType<typeof vi.fn> }[] = [];
  const monitors: { stream: ReturnType<typeof monitoringStream>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('AudioContext', class {
    sampleRate: number;
    destination = {};
    setSinkId = sink;
    close = close;
    resume = vi.fn(() => Promise.resolve());
    createMediaElementSource = createSource;
    createAnalyser() { const analyser = { fftSize: 0, smoothingTimeConstant: 0, disconnect: vi.fn() }; analysers.push(analyser); return analyser; }
    createChannelSplitter() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createMediaStreamDestination() { const monitor = { stream: monitoringStream(), disconnect: vi.fn() }; monitors.push(monitor); return monitor; }
    constructor(options: AudioContextOptions) { this.sampleRate = options.sampleRate!; contexts.push(this); }
  });
  return { output: new InternalAudioOutput(), audio: {} as HTMLAudioElement, source, sink, close, createSource, contexts, monitors, analysers };
}
describe('内部音频输出线路', () => {
  it('播放前准备频谱与双声道分析，重复读取不创建音频上下文，销毁释放所有节点', async () => {
    const f = fixture();
    expect(f.output.getAnalysis()).toBeNull();
    await f.output.prepare(f.audio, 'default', 48000);
    const analysis = f.output.getAnalysis();
    expect(analysis?.sampleRate).toBe(48000);
    expect(analysis?.fftSize).toBe(2048);
    expect(f.analysers.map(channel => channel.fftSize)).toEqual([2048, 1024, 1024]);
    expect(f.output.getAnalysis()).toBe(analysis);
    expect(f.contexts).toHaveLength(1);
    await f.output.dispose();
    for (const analyser of f.analysers) expect(analyser.disconnect).toHaveBeenCalledOnce();
    expect(f.output.getAnalysis()).toBeNull();
  });
  it('关闭频谱不关闭共享音源或另一块电平表，重新打开仍取得有效音轨', async () => {
    const f = fixture();
    await f.output.prepare(f.audio, 'default', 44100);
    const spectrum = f.output.captureMonitoringStream();
    const meters = f.output.captureMonitoringStream();
    spectrum?.getTracks().forEach((track) => track.stop());
    expect(spectrum?.active).toBe(false);
    expect(meters?.active).toBe(true);
    expect(f.monitors[0]?.stream.active).toBe(true);
    expect(f.output.captureMonitoringStream()?.active).toBe(true);
    expect(f.monitors).toHaveLength(1);
    await f.output.dispose();
  });
  it('已结束的监测音轨会被释放，再次订阅建立有效监测连接', async () => {
    const f = fixture();
    await f.output.prepare(f.audio, 'default', 44100);
    f.output.captureMonitoringStream();
    const first = f.monitors[0];
    first?.stream.getTracks().forEach((track) => track.stop());
    expect(f.output.captureMonitoringStream()?.active).toBe(true);
    expect(f.source.disconnect).toHaveBeenCalledWith(first);
    expect(first?.disconnect).toHaveBeenCalledOnce();
    expect(f.monitors).toHaveLength(2);
    await f.output.dispose();
  });
  it.each([44100, 48000] as const)('使用指定采样率和输出线路，切歌不重复绑定音频源：%s', async (rate) => {
    const f = fixture();
    await f.output.prepare(f.audio, 'device-line-out', rate);
    await f.output.prepare(f.audio, 'device-line-out', rate);
    expect(f.contexts).toHaveLength(1); expect(f.contexts[0]?.sampleRate).toBe(rate);
    expect(f.sink).toHaveBeenLastCalledWith('device-line-out'); expect(f.createSource).toHaveBeenCalledTimes(1);
    await f.output.dispose(); expect(f.close).toHaveBeenCalledOnce(); expect(f.source.disconnect).toHaveBeenCalledOnce();
  });
  it('保存的设备已拔出时明确返回系统默认线路，本次播放继续', async () => {
    const f = fixture(); f.sink.mockRejectedValueOnce(Object.assign(new Error('AudioContext.setSinkId: device is not found'), { name: 'NotFoundError' }));
    await expect(f.output.prepare(f.audio, 'missing-device', 48000)).resolves.toBe('default-fallback');
    expect(f.sink.mock.calls.map(([id]) => id)).toEqual(['missing-device', '']);
    await f.output.dispose();
  });
  it('旧设备与系统默认设备均不可用时用中文说明，不继续播放', async () => {
    const f = fixture(); f.sink.mockRejectedValueOnce(Object.assign(new Error('device is not found'), { name: 'NotFoundError' })).mockRejectedValueOnce(new Error('default unavailable'));
    await expect(f.output.prepare(f.audio, 'missing-device', 48000)).rejects.toThrow('Windows 默认输出设备也不可用');
    expect(f.sink).toHaveBeenCalledTimes(2);
    await f.output.dispose();
  });
  it('输出设备被占用时不切换线路', async () => {
    const f = fixture(); f.sink.mockRejectedValueOnce(Object.assign(new Error('device busy'), { name: 'NotReadableError' }));
    await expect(f.output.prepare(f.audio, 'missing-device', 48000)).rejects.toThrow('device busy');
    expect(f.sink).toHaveBeenCalledOnce();
    await f.output.dispose();
  });
});
