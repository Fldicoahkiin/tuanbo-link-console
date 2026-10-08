import { windowsSystemExecutable } from './windows-system-executable';

/** Windows 自带组件必须通过系统目录定位，不能依赖用户 PATH 或当前目录。 */
export async function windowsPowerShellExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  return windowsSystemExecutable('powershell', environment);
}
