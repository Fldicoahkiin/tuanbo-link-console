import { afterEach, expect, it, vi } from 'vitest';
import { assertAudioOutputAvailable } from './audio-output-route';

const mocks = vi.hoisted(() => ({ native: vi.fn(), browser: vi.fn() }));
vi.mock('./link-desktop-view-model', () => ({ linkDesktopViewModel: { getNativePlaybackDevices: mocks.native } }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('原生线路按端点 ID 区分同名设备，不拿浏览器设备 ID 猜测', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: mocks.browser } });
  mocks.native.mockResolvedValue({ protocol: 4, audio: [
    { id: 'native-a', name: '相同设备名', isDefault: false }, { id: 'native-b', name: '相同设备名', isDefault: true }
  ], midiOutputs: [] });
  await assertAudioOutputAvailable({ audioEngine: 'native', audioOutputDeviceId: 'browser-a', nativeAudioOutputDeviceId: 'native-a', mtcOutputPortProfileId: null });
  await expect(assertAudioOutputAvailable({ audioEngine: 'native', audioOutputDeviceId: 'browser-a', nativeAudioOutputDeviceId: 'browser-a', mtcOutputPortProfileId: null })).rejects.toThrow('不可用');
  expect(mocks.browser).not.toHaveBeenCalled();
  expect(mocks.native).toHaveBeenCalledWith('audio');
});

it('原生默认线路必须有明确默认端点，缺少时不切到其他设备', async () => {
  mocks.native.mockResolvedValue({ protocol: 4, audio: [{ id: 'native-a', name: '另一个设备', isDefault: false }], midiOutputs: [] });
  await expect(assertAudioOutputAvailable({ audioEngine: 'native', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null })).rejects.toThrow('不可用');
});

it('旧工程显式使用浏览器线路，不调用原生枚举', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: mocks.browser } });
  mocks.browser.mockResolvedValue([{ kind: 'audiooutput', deviceId: 'browser-a' }]);
  await assertAudioOutputAvailable({ audioEngine: 'browser', audioOutputDeviceId: 'browser-a', mtcOutputPortProfileId: null });
  expect(mocks.native).not.toHaveBeenCalled();
});

it('未设置引擎的档案默认检查 Windows 原生播放设备', async () => {
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: mocks.browser } });
  mocks.native.mockResolvedValue({ protocol: 4, audio: [{ id: 'native-a', name: '默认设备', isDefault: true }], midiOutputs: [] });
  await assertAudioOutputAvailable({ audioOutputDeviceId: 'default', mtcOutputPortProfileId: 'internal-mtc-output' });
  expect(mocks.native).toHaveBeenCalledWith('audio'); expect(mocks.browser).not.toHaveBeenCalled();
});
