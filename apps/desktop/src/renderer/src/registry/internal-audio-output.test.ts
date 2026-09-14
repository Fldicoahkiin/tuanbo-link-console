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
  const sink = vi.fn(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve());
  const createSource = vi.fn(() => source);
  const contexts: { sampleRate: number }[] = [];
  const monitors: { stream: ReturnType<typeof monitoringStream>; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal('AudioContext', class {
    sampleRate: number;
    destination = {};
    setSinkId = sink;
    close = close;
    resume = vi.fn(() => Promise.resolve());
    createMediaElementSource = createSource;
    createMediaStreamDestination() { const monitor = { stream: monitoringStream(), disconnect: vi.fn() }; monitors.push(monitor); return monitor; }
    constructor(options: AudioContextOptions) { this.sampleRate = options.sampleRate!; contexts.push(this); }
  });
  return { output: new InternalAudioOutput(), audio: {} as HTMLAudioElement, source, sink, close, createSource, contexts, monitors };
}
describe('内部音频输出线路', () => {
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
  it('线路不可用时直接报错，不改用默认设备', async () => {
    const f = fixture(); f.sink.mockRejectedValueOnce(new Error('设备已断开'));
    await expect(f.output.prepare(f.audio, 'missing-device', 48000)).rejects.toThrow('设备已断开');
    expect(f.sink).toHaveBeenCalledOnce(); expect(f.sink).toHaveBeenCalledWith('missing-device');
    await f.output.dispose();
  });
});
