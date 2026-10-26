import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';

const systemCommands = {
  powershell: ['WindowsPowerShell', 'v1.0', 'powershell.exe'],
  registry: ['reg.exe']
} as const;

/** Resolve only known Windows components, independently of PATH and the working directory. */
export async function windowsSystemExecutable(command: keyof typeof systemCommands, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const variables = new Map(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]));
  const systemRoot = [variables.get('systemroot'), variables.get('windir')].find(value => value && /^[a-z]:[\\/]/i.test(value));
  if (!systemRoot) throw new Error('读不到 Windows 系统目录，暂时无法使用系统命令。请导出诊断包发给售后。');
  const executable = win32.join(systemRoot, 'System32', ...systemCommands[command]);
  try {
    if (!(await stat(executable)).isFile()) throw new Error('目标不是可执行文件');
  } catch (error) {
    throw new Error('Windows 系统命令组件缺失或无法访问。请检查杀毒软件是否拦截，或导出诊断包发给售后。', { cause: new Error(executable, { cause: error }) });
  }
  return executable;
}
