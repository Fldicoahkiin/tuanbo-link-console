import type { LinkProcessSnapshot } from '@tb/core/link';

/** Only diagnose a known running version and a standard MA data directory.
 * Custom paths remain explicit and are verified by the plugin exchange. */
export function ma2LocalDirectoryMismatch(directory: string, process: LinkProcessSnapshot): string | null {
  if (process.status !== 'running' || !process.executablePath) return null;
  const version = process.fileVersion?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?? /grandma2 onpc (\d+)\.(\d+)\.(\d+)(?:\.\d+)?[\\/]/i.exec(process.executablePath);
  const data = /[\\/]gma2_V_(\d+)\.(\d+)(?:\.(\d+))?[\\/]?$/i.exec(directory);
  if (!version || !data) return null;
  const expected = version.slice(1, 4).map(Number), actual = [Number(data[1]), Number(data[2]), Number(data[3] ?? 0)];
  if (expected.every((value, index) => value === actual[index])) return null;
  return `正在运行的是 onPC ${expected.join('.')}，但选的数据目录属于 ${actual.join('.')}。请选择当前版本的数据目录并运行联动插件，或改用网络直连，地址填 127.0.0.1。`;
}
