import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import previewScript from '../../../../../tools/obs/tblink_preview.lua?raw';

const run = promisify(execFile);
type Lease = { name: string; nonce: string; touched: number };
const statusSchema = z.object({ version: z.literal(1), pid: z.number().int().positive(), error: z.string() });

/** Local OBS keeps capture sources showing; Program activation remains the runtime's job. */
export class ObsEditorPreview {
  private session = randomUUID();
  private target: Promise<number | null> = Promise.resolve(null);
  private pending: Promise<void> = Promise.resolve();
  private leases = new Map<string, Lease>();

  constructor(private readonly directory: string, private readonly findPid = findLocalObsPid) {}

  configure(url: string): void {
    this.session = randomUUID();
    this.leases.clear();
    this.target = this.findPid(url);
    // Observe immediately; a lookup failure is also reported to the next preview request.
    void this.target.catch(() => undefined);
  }

  async exportScript(): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, 'tblink_preview.lua');
    await writeFile(path, previewScript, 'utf8');
    return path;
  }

  async getStatus(): Promise<{ ready: boolean; message: string }> {
    try {
      const session = this.session;
      const pid = await this.target;
      if (pid === null) return { ready: false, message: '请连接本机 OBS；远程 OBS 暂不支持采集预览桥。' };
      const path = join(this.directory, `${pid}.status.json`);
      const [metadata, text] = await Promise.all([stat(path), readFile(path, 'utf8')]);
      const status = statusSchema.parse(JSON.parse(text));
      if (session !== this.session || Date.now() - metadata.mtimeMs > 3_000 || status.pid !== pid) {
        return { ready: false, message: 'OBS 预览脚本未运行，请在 OBS“工具 → 脚本”中加载或重新加载。' };
      }
      return status.error ? { ready: false, message: `OBS 预览脚本错误：${status.error}` } : { ready: true, message: 'OBS 采集预览已就绪' };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { ready: false, message: 'OBS 尚未加载预览脚本。导出文件后，还需在 OBS“工具 → 脚本”中添加一次。' };
      }
      return { ready: false, message: `无法确认 OBS 预览状态：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async touch(name: string): Promise<void> {
    const session = this.session;
    const pid = await this.target;
    if (pid === null || session !== this.session) return;
    const now = performance.now();
    for (const [key, lease] of this.leases) if (now - lease.touched > 2_000) this.leases.delete(key);
    if (!this.leases.has(name) && this.leases.size >= 128) throw new Error('编辑预览最多同时保持 128 个采集来源');
    this.leases.set(name, { name, nonce: randomUUID(), touched: now });
    const contents = JSON.stringify({ session, sources: [...this.leases.values()].map(({ name: sourceName, nonce }) => ({ name: sourceName, nonce })) });
    const write = this.pending.then(async () => {
      if (session !== this.session) return;
      await mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `${pid}.${session}.tmp`);
      await writeFile(temporary, contents, 'utf8');
      await rename(temporary, join(this.directory, `${pid}.json`));
    });
    this.pending = write.catch(() => undefined);
    await write;
  }

  clear(): void {
    this.session = randomUUID();
    this.leases.clear();
    this.target = Promise.resolve(null);
    // OBS releases only this bridge's showing references after two seconds without heartbeats.
  }
}

export async function findLocalObsPid(address: string): Promise<number | null> {
  const url = new URL(address);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
  const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OBS 端口无效');
  const command = `$ErrorActionPreference='Stop'; $owners = @(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -eq ${port}} | Select-Object -ExpandProperty OwningProcess -Unique); if ($owners.Count -eq 0) { [Console]::Write('0'); exit 0 }; if ($owners.Count -ne 1) { throw 'OBS listening process is ambiguous' }; $target = Get-Process -Id $owners[0]; if ($target.ProcessName -notin @('obs64','obs32')) { throw 'Port does not belong to OBS' }; [Console]::Write($target.Id)`;
  const { stdout } = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 2_000, maxBuffer: 16_384 });
  const pid = Number(stdout.trim());
  if (stdout.trim() === '0') return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('无法确认本机 OBS 进程');
  return pid;
}
