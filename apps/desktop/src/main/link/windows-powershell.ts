import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';

/** Windows 自带组件必须通过系统目录定位，不能依赖用户 PATH 或当前目录。 */
export async function windowsPowerShellExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const variables = new Map(Object.entries(environment).map(([key, value]) => [key.toLowerCase(), value]));
  // Windows 环境变量名不区分大小写；SystemRoot 和 windir 均由系统定义。
  const systemRoot = [variables.get('systemroot'), variables.get('windir')].find(value => value && /^[a-z]:[\\/]/i.test(value));
  if (!systemRoot) {
    throw new Error('无法读取 Windows 系统目录，外部程序检测暂不可用。请导出诊断信息以便定位。');
  }
  const executable = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    if (!(await stat(executable)).isFile()) throw new Error('目标不是可执行文件');
  } catch (error) {
    throw new Error('Windows 系统命令组件缺失或不可访问，外部程序检测暂不可用。请检查安全软件拦截记录，或导出诊断信息。', { cause: new Error(executable, { cause: error }) });
  }
  return executable;
}
