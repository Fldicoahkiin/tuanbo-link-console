import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);

/** How a running program was identified. 'limited' means Windows hides its details from a normal-privilege
 * console, usually because the program runs as administrator; the bundled reader still sees who it is. */
export type ProcessAccess = 'full' | 'limited';

export function processIdentityExecutable(resourcesPath?: string): string {
  return resourcesPath
    ? join(resourcesPath, 'process-identity', 'tblink-process-identity.exe')
    : resolve(__dirname, '../../../../tools/process-identity/bin/tblink-process-identity.exe');
}

const pidSchema = z.number().int().positive();
const identitySchema = z.union([
  z.object({ pid: pidSchema, path: z.string().min(1), creationTime: z.string().regex(/^\d{1,20}$/), commandLine: z.string().nullable() }).strict(),
  z.object({ pid: pidSchema, error: z.number().int().nonnegative() }).strict()
]);
export type ProcessIdentity = z.infer<typeof identitySchema>;

/** Runs the bundled reader. It asks Windows only for limited query access and changes nothing in the target. */
export async function readProcessIdentities(helper: string, pids: readonly number[]): Promise<ProcessIdentity[]> {
  if (pids.length === 0 || pids.length > 64 || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff)) {
    throw new Error('进程识别参数无效');
  }
  let stdout: string;
  try {
    ({ stdout } = await run(helper, pids.map(String), { windowsHide: true, timeout: 5_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }));
  } catch (error) {
    throw new Error(`进程识别组件运行失败，请重新安装联动台：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const identities = z.array(identitySchema).parse(JSON.parse(stdout));
  if (identities.length !== pids.length || identities.some((identity, index) => identity.pid !== pids[index])) {
    throw new Error('进程识别组件返回的结果与请求不一致');
  }
  return identities;
}

const unixEpochFileTime = 116_444_736_000_000_000n;

/** Windows FILETIME (100 ns since 1601 UTC) of a round-trip timestamp such as .NET's ToString('o'), to the full 100 ns. */
export function fileTimeOf(timestamp: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  const seconds = match?.[1], fraction = match?.[2] ?? '', zone = match?.[3];
  const milliseconds = seconds && zone ? Date.parse(`${seconds}${zone}`) : Number.NaN;
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`进程启动时间格式无效：${timestamp}`);
  return BigInt(milliseconds) * 10_000n + BigInt(fraction.padEnd(7, '0')) + unixEpochFileTime;
}
