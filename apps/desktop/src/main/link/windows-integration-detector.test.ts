import { describe, expect, it } from 'vitest';
import { WindowsIntegrationDetector } from './windows-integration-detector';

describe('WindowsIntegrationDetector', () => {
  it('只识别 OBS 与 P1', async () => {
    let discoveryScript = '';
    const detector = new WindowsIntegrationDetector((script) => {
      discoveryScript = script;
      return Promise.resolve(JSON.stringify({
        detectedAt: '2026-08-26T12:00:00.000Z',
        applications: [
          { id: 'obs', executablePath: 'C:\\OBS\\obs64.exe', workingDirectory: 'C:\\OBS', processName: 'obs64.exe', windowTitle: 'OBS', version: '32.2.2', running: true },
          { id: 'p1', executablePath: 'D:\\P1\\HirenderP1.exe', workingDirectory: 'D:\\P1', processName: 'HirenderP1.exe', windowTitle: '未命名', version: '1.14.2', running: true }
        ]
      }));
    });

    const result = await detector.detect();

    expect(result.applications.obs).toMatchObject({ version: '32.2.2', running: true });
    expect(result.applications.p1.executablePath).toBe('D:\\P1\\HirenderP1.exe');
    expect(discoveryScript).not.toContain('直播伴侣');
  });

  it('缺少目标时明确报错', async () => {
    const detector = new WindowsIntegrationDetector(() => Promise.resolve(JSON.stringify({
      detectedAt: '2026-08-26T12:00:00.000Z',
      applications: []
    })));

    await expect(detector.detect()).rejects.toThrow('缺少有效目标：obs');
  });
});
