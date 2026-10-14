import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { executePowerShell } from './windows-integration-detector';
import type { Ma2ConnectedPeer } from './ma2-telnet';

const port = z.number().int().min(1).max(65535);
const connectionsSchema = z.array(z.object({ localAddress: z.string(), localPort: port,
  remoteAddress: z.string(), remotePort: port, pid: z.number().int().positive() }));
type Connection = z.infer<typeof connectionsSchema>[number];
const normalize = (address: string): string => address.replace(/^::ffff:/i, '');

export function isLocalMa2Address(host: string, addresses = Object.values(networkInterfaces()).flatMap(values => values?.map(value => value.address) ?? [])): boolean {
  return ['127.0.0.1', '::1', ...addresses].includes(normalize(host));
}

async function connections(): Promise<Connection[]> {
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8
  $items=@(Get-NetTCPConnection -State Established -ErrorAction Stop | ForEach-Object { @{localAddress=$_.LocalAddress;localPort=[int]$_.LocalPort;remoteAddress=$_.RemoteAddress;remotePort=[int]$_.RemotePort;pid=[int]$_.OwningProcess} })
  ConvertTo-Json -InputObject $items -Compress`;
  return connectionsSchema.parse(JSON.parse(await executePowerShell(script, 10000)));
}

/** Both accepted TCP connections must belong to the selected onPC before login. */
export async function assertMa2ConnectionOwner(pid: number, peers: readonly Ma2ConnectedPeer[], locate: () => Promise<Connection[]> = connections): Promise<void> {
  if (peers.length !== 2) throw new Error('MA2 命令和监视通道不完整，未发送登录');
  const active = await locate();
  for (const peer of peers) {
    const matches = active.filter(value => value.localPort === peer.remotePort && value.remotePort === peer.localPort
      && normalize(value.localAddress) === normalize(peer.remoteAddress) && normalize(value.remoteAddress) === normalize(peer.localAddress));
    if (matches.length !== 1 || matches[0]?.pid !== pid) {
      throw new Error(`MA2 ${peer.remotePort} 通道未连接到选定的 onPC，未发送登录或控台命令。请先打开 onPC 并连接成功，再启动 MA 3D。`);
    }
  }
}
