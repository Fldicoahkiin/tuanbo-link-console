import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { IntegrationProfile } from '@tb/schema';
import { writeFileAtomically } from './atomic-file';
import { windowsPowerShellExecutable } from './windows-powershell';

const settingsSchema = z.object({ server_enabled: z.boolean().default(false), server_port: z.number().int().min(1).max(65535).default(4455),
  auth_required: z.boolean().default(true), server_password: z.string().max(4096).default('') }).passthrough();
export type LocalObsIdentity = { pid: number; executablePath: string; startTime: string };

/** Read only the exact selected OBS process, never a password from another instance. */
export async function readObsCommandLine(identity: LocalObsIdentity): Promise<string> {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) throw new Error('OBS 进程标识无效');
  const encodedPath = Buffer.from(identity.executablePath, 'utf16le').toString('base64');
  const encodedStart = Buffer.from(identity.startTime, 'utf16le').toString('base64');
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-Process -Id ${identity.pid}; $path=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $start=[DateTime]::Parse([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedStart}'))).ToUniversalTime(); if(-not $p.MainModule.FileName.Equals($path,[StringComparison]::OrdinalIgnoreCase) -or $p.StartTime.ToUniversalTime() -ne $start){throw 'OBS process identity changed'}; $item=Get-CimInstance Win32_Process -Filter 'ProcessId = ${identity.pid}'; [string]$item.CommandLine | ConvertTo-Json -Compress`;
  const executable = await windowsPowerShellExecutable();
  const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000, maxBuffer: 32768 });
  return z.string().parse(JSON.parse(stdout.replace(/^\uFEFF/, '')));
}

export async function prepareLocalObsConnection(options: {
  obs: IntegrationProfile['obs']; roamingDirectory: string; running: boolean; commandLine: string;
}): Promise<{ address: string; password: string; configurationPath: string; changed: boolean }> {
  const root = resolve(dirname(options.obs.executablePath), '../..');
  const portable = /(?:^|\s)(?:--portable|-p)(?:\s|$)/.test(options.commandLine)
    || (!options.running && options.obs.arguments.some(argument => argument === '--portable' || argument === '-p'))
    || await exists(join(root, 'portable_mode')) || await exists(join(root, 'obs_portable_mode'));
  if (/--websocket[_-]/.test(options.commandLine)) throw new Error('该 OBS 使用了命令行连接参数覆盖，请使用下方手动连接核对目标；软件不会猜测密码或修改正在运行的实例');
  const directory = portable ? join(root, 'config/obs-studio') : join(options.roamingDirectory, 'obs-studio');
  const configurationPath = join(directory, 'plugin_config/obs-websocket/config.json');
  let original: string | null = null;
  try { original = await readFile(configurationPath, 'utf8'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  if (original === null && options.running) throw new Error('当前 OBS 的连接配置尚未生成，请正常退出 OBS 后再点一键连接，软件会自动配置并启动');
  let settings: z.infer<typeof settingsSchema>;
  try { settings = settingsSchema.parse(original === null ? {} : JSON.parse(original.replace(/^\uFEFF/, ''))); }
  catch (error) { throw new Error('OBS 连接配置损坏或格式不受支持；原文件未修改', { cause: error }); }
  const needsPreparation = !settings.server_enabled || (settings.auth_required && settings.server_password === '');
  if (needsPreparation && options.running) throw new Error('当前 OBS 尚未启用连接服务，请正常退出 OBS 后再点一键连接，软件会自动启用；不会关闭正在运行的 OBS');
  if (needsPreparation) {
    settings.server_enabled = true;
    if (settings.auth_required && !settings.server_password) settings.server_password = randomBytes(24).toString('hex');
    if (original !== null) await writeFileAtomically(`${configurationPath}.tblink-${randomUUID()}.bak`, original);
    await writeFileAtomically(configurationPath, JSON.stringify(settings, null, 2));
  }
  return { address: `ws://127.0.0.1:${settings.server_port}`, password: settings.auth_required ? settings.server_password : '', configurationPath, changed: needsPreparation };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; }
}
