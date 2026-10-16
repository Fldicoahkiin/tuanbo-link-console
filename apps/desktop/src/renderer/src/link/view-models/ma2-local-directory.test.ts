import { expect, it } from 'vitest';
import { useIntegrationStore } from '../stores/integration-store';
import { ma2LocalDirectoryMismatch } from './ma2-local-directory';

it('已运行 3.7 onPC 不向旧 3.3.4 数据目录发送插件请求，3.7 与 3.7.0 等价', () => {
  const process = { ...useIntegrationStore.getState().processes.ma2, status: 'running' as const,
    executablePath: 'D:/ma/grandMA2 onPC 3.7.0.5/gma2onpc.exe.exe', fileVersion: '' };
  expect(ma2LocalDirectoryMismatch('C:/ProgramData/MA/grandma/gma2_V_3.3.4', process)).toContain('正在运行 onPC 3.7.0');
  expect(ma2LocalDirectoryMismatch('C:/ProgramData/MA/grandma/gma2_V_3.7', process)).toBeNull();
  expect(ma2LocalDirectoryMismatch('C:/ProgramData/MA/grandma/gma2_V_3.7.0/', process)).toBeNull();
  expect(ma2LocalDirectoryMismatch('C:/custom-data', process)).toBeNull();
  expect(ma2LocalDirectoryMismatch('C:/MA/gma2_V_3.3.4', { ...process, status: 'notRunning' })).toBeNull();
});
