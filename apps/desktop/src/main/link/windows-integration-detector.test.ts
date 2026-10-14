import { describe, expect, it } from 'vitest';
import { WindowsIntegrationDetector } from './windows-integration-detector';

describe('WindowsIntegrationDetector', () => {
  it('识别 OBS、P1 与本机 MA 程序，拒绝自动挑选多个 MA 版本', async () => {
    let discoveryScript = '';
    const detector = new WindowsIntegrationDetector((script) => {
      discoveryScript = script;
      return Promise.resolve(JSON.stringify({
        detectedAt: '2026-08-26T12:00:00.000Z',
        applications: [
          { id: 'obs', executablePath: 'C:\\OBS\\obs64.exe', workingDirectory: 'C:\\OBS', processName: 'obs64.exe', windowTitle: 'OBS', version: '32.2.2', running: true },
          { id: 'p1', executablePath: 'D:\\P1\\HirenderP1.exe', workingDirectory: 'D:\\P1', processName: 'HirenderP1.exe', windowTitle: '未命名', version: '1.14.2', running: true },
          { id: 'ma2', executablePath: 'D:\\MA\\gma2onpc.exe.exe', workingDirectory: 'D:\\MA', processName: 'gma2onpc.exe.exe', windowTitle: 'grandMA2', version: '3.7.0.5', running: true },
          { id: 'ma3d', executablePath: 'D:\\MA\\MA3D.exe', workingDirectory: 'D:\\MA', processName: 'MA3D.exe', windowTitle: 'MA 3D', version: '3.7.0', running: true }
        ]
      }));
    });

    const result = await detector.detect();

    expect(result.applications.obs).toMatchObject({ version: '32.2.2', running: true });
    expect(result.applications.p1.executablePath).toBe('D:\\P1\\HirenderP1.exe');
    expect(discoveryScript).not.toContain('直播伴侣');
    expect(result.applications.ma2?.executablePath).toBe('D:\\MA\\gma2onpc.exe.exe');
    expect(result.applications.ma3d?.running).toBe(true);
  });

  it('缺少目标时明确报错', async () => {
    const detector = new WindowsIntegrationDetector(() => Promise.resolve(JSON.stringify({
      detectedAt: '2026-08-26T12:00:00.000Z',
      applications: []
    })));

    await expect(detector.detect()).rejects.toThrow('缺少有效目标：obs');
  });
});
