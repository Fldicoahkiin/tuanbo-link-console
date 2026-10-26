import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { windowsSystemExecutable } from './windows-system-executable';

/** Machine identity is fixed for this process. Do not spawn a registry reader
 * on every editor IPC; authorization and expiry are still checked separately. */
export function createLicenseMachineCodeReader(read: () => Promise<string> = readLicenseMachineCode): () => Promise<string> {
  let result: Promise<string> | undefined;
  return () => result ??= read();
}

/** Windows installation identifier: never send the raw MachineGuid to the issuer. */
export async function readLicenseMachineCode(): Promise<string> {
  if (process.platform !== 'win32') throw new Error('本机授权目前只支持 Windows');
  const executable = await windowsSystemExecutable('registry');
  const { stdout } = await promisify(execFile)(executable, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 });
  const guid = /MachineGuid\s+REG_SZ\s+([a-f0-9-]{32,36})/i.exec(stdout)?.[1];
  if (!guid) throw new Error('无法读取本机标识，请检查 Windows 注册表访问权限');
  return `TB1-${createHash('sha256').update(`tuanbo-link-console:machine:v1:${guid.toLowerCase()}`).digest('hex').toUpperCase()}`;
}
