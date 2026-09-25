import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectStartupObs, initializeStartupDevices } from './startup-obs-connection';
import { createDefaultIntegrationProfile } from './view-models/local-integration-profile';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { useIntegrationStore } from './stores/integration-store';

const mockDesktop = vi.mocked(linkDesktopViewModel, { deep: true });

vi.mock('./view-models/link-desktop-view-model', () => ({
  linkDesktopViewModel: {
    getSecurityPreflight: vi.fn(), startExternalApplication: vi.fn(), connectObs: vi.fn(),
    readObsInventory: vi.fn(), recordLog: vi.fn(), refreshExternalApplication: vi.fn()
  }
}));

const disconnected = { status: 'disconnected' as const, obsVersion: null, webSocketVersion: null, error: null };
const stopped = { id: 'obs' as const, status: 'notRunning' as const, pid: null, processName: null, executablePath: null, startTime: null, windowTitle: null, fileVersion: null, owned: false, error: null };
const running = { ...stopped, status: 'running' as const, pid: 1234, owned: true };

beforeEach(() => {
  vi.resetAllMocks();
  mockDesktop.getSecurityPreflight.mockResolvedValue({ credentialDecryptable: true, logRedactionReady: true, error: null });
  mockDesktop.startExternalApplication.mockResolvedValue(running);
  mockDesktop.connectObs.mockResolvedValue({ status: 'connected', obsVersion: '32.2.2', webSocketVersion: '5.6.3', error: null });
  mockDesktop.readObsInventory.mockResolvedValue({ videoSettings: { baseWidth: 1080, baseHeight: 1920 }, scenes: [], inputs: [], inputKinds: {}, sceneItems: {}, filters: {}, transitions: [], inputAudioStates: {}, sourceSizes: {} });
  mockDesktop.recordLog.mockResolvedValue({ id: 'test', sessionId: 'test', timestamp: '2026-09-23T00:00:00.000Z', monotonicMs: 0, level: 'warning', category: 'device', message: 'test' });
  mockDesktop.refreshExternalApplication.mockResolvedValue({ ...stopped, id: 'p1' });
  useIntegrationStore.getState().setObs(disconnected);
  useIntegrationStore.getState().setError(null);
});

describe('OBS 启动连接', () => {
  it('有保存的配置时启动并连接 OBS', async () => {
    await connectStartupObs(createDefaultIntegrationProfile(), true, disconnected, [stopped], () => false);
    expect(mockDesktop.startExternalApplication.mock.calls).toEqual([['obs']]);
    expect(mockDesktop.connectObs.mock.calls).toHaveLength(1);
    expect(useIntegrationStore.getState().obs.status).toBe('connected');
  });

  it('OBS 离线时只显示未连接，不使整个工作区初始化失败', async () => {
    mockDesktop.startExternalApplication.mockRejectedValue(new Error('ECONNREFUSED'));
    await connectStartupObs(createDefaultIntegrationProfile(), true, disconnected, [stopped], () => false);
    expect(useIntegrationStore.getState().obs.status).toBe('disconnected');
    expect(useIntegrationStore.getState().obs.error).toMatch(/^OBS 启动连接未完成：无法连接目标设备/);
    expect(useIntegrationStore.getState().error).toBeNull();
  });

  it('关闭自动连接时不访问设备', async () => {
    const profile = createDefaultIntegrationProfile();
    profile.obs.autoConnectOnLaunch = false;
    await connectStartupObs(profile, true, disconnected, [stopped], () => false);
    expect(mockDesktop.getSecurityPreflight.mock.calls).toHaveLength(0);
    expect(mockDesktop.startExternalApplication.mock.calls).toHaveLength(0);
  });

  it('P1 进程检测未返回时仍启动 OBS 连接', async () => {
    const pending = new Promise<Awaited<ReturnType<typeof linkDesktopViewModel.refreshExternalApplication>>>(() => undefined);
    mockDesktop.refreshExternalApplication.mockReturnValue(pending);
    initializeStartupDevices(createDefaultIntegrationProfile(), true, disconnected, () => false);
    await vi.waitFor(() => expect(mockDesktop.startExternalApplication.mock.calls).toEqual([['obs']]));
    expect(useIntegrationStore.getState().obs.status).toBe('connected');
  });
});
