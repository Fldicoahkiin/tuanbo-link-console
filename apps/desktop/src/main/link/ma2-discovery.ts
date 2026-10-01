import { createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { Ma2Discovery, Ma2NetworkSettings } from '@tb/schema';
import { executePowerShell } from './windows-integration-detector';

type Address = { host: string; port: number };

/** One bounded ArtPoll per local IPv4 interface; replies still require MA2 TCP identification. */
export function directedBroadcast(address: string, netmask: string): string {
  const mask = netmask.split('.').map(Number);
  return address.split('.').map((part, index) => Number(part) | (255 ^ mask[index]!)).join('.');
}

async function broadcastTargets(signal: AbortSignal, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, warnings: string[]): Promise<Address[]> {
  const found = new Set<string>();
  const entries = Object.values(interfaces).flatMap(entries => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal)).slice(0, 8);
  await Promise.all(entries.map(({ address, netmask }) => new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    if (netmask === '255.255.255.255') { warnings.push(`${address}/32 没有可广播子网；需通过已保存 IP 或静态路由直连控台。`); resolve(); return; }
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (): void => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', finish); socket.close(); resolve(); };
    const timer = setTimeout(finish, 1500);
    signal.addEventListener('abort', finish, { once: true });
    const failed = (error: Error): void => { warnings.push(`${address} 广播发现失败：${error.message}；仍可填写控台 IP 直接连接。`); finish(); };
    socket.on('error', failed);
    socket.on('message', (message, remote) => {
      if (message.length >= 26 && message.subarray(0, 8).equals(Buffer.from('Art-Net\0')) && message.readUInt16LE(8) === 0x2100) found.add(remote.address);
    });
    socket.bind(6454, address, () => {
      if (done) return;
      try {
        socket.setBroadcast(true);
        socket.send(Buffer.from([65,114,116,45,78,101,116,0,0,32,0,14,0,0]), 6454, directedBroadcast(address, netmask), error => { if (error) failed(error); });
      } catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
    });
  })));
  return [...found].map(host => ({ host, port: 30000 }));
}
/** Bounded, read-only probes. No login, commands, or credential distribution. */
export function discoveryTargets(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, saved: Ma2NetworkSettings[]): { addresses: Address[]; ranges: string[]; warnings: string[] } {
  const addresses = new Map<string, Address>();
  const ranges = new Set<string>(); const warnings: string[] = [];
  const adapters: string[] = [];
  const add = (host: string, port = 30000): void => { addresses.set(`${host}:${port}`, { host, port }); };
  add('127.0.0.1');
  for (const profile of saved) add(profile.host, profile.port);
  for (const [name, entries] of Object.entries(interfaces)) for (const entry of entries ?? []) {
    if (entry.family !== 'IPv4' || entry.internal) continue;
    adapters.push(`${name}：${entry.address} / ${entry.netmask}`);
    if (entry.address.startsWith('169.254.')) warnings.push(`${name} 使用自动分配地址 ${entry.address}，请核对是否与控台 IP 同网段。`);
    const octets = entry.address.split('.').map(Number);
    const mask = entry.netmask.split('.').map(Number);
    // Large show networks are common. Never enumerate millions of addresses.
    const prefix = octets.slice(0, 3).join('.');
    const range = `${prefix}.0/24`;
    if (ranges.has(range)) continue;
    if (ranges.size >= 8) { warnings.push('网卡超过 8 个，部分网段未搜索；可手动填写控台 IP。'); break; }
    ranges.add(range);
    if (mask.slice(0, 3).some((part) => part !== 255)) warnings.push(`${entry.address} 所在网络较大，本次仅搜索 ${range} 和已保存地址；其他地址请手动添加。`);
    for (let last = 1; last < 255; last += 1) {
      if ((last & (mask[3] ?? 255)) === ((octets[3] ?? 0) & (mask[3] ?? 255))) add(`${prefix}.${last}`);
    }
  }
  if (!adapters.length) warnings.push('未检测到可用的外部 IPv4 网卡，目前只能检查本机及已保存地址。');
  return { addresses: [...addresses.values()], ranges: ['本机 127.0.0.1', ...adapters, ...ranges], warnings };
}

export function probeMa2(address: Address, signal: AbortSignal, timeoutMs = 650): Promise<Ma2Discovery['hosts'][number] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(address); let text = ''; let connected = false; let finished = false;
    const finish = (): void => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel); socket.destroy();
      const identified = /grandMA2/i.test(text) || (/Logged in as User/i.test(text) && /\[[^\r\n]+\]>/i.test(text));
      resolve(!signal.aborted && connected ? { ...address, identity: identified ? 'ma2' : 'candidate' } : null);
    };
    const cancel = (): void => { connected = false; finish(); };
    let timer = setTimeout(finish, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('connect', () => { connected = true; clearTimeout(timer); timer = setTimeout(finish, Math.max(timeoutMs, 1500)); });
    socket.on('data', (data: Buffer) => {
      text = (text + data.toString('utf8')).slice(0, 8192);
      if (/grandMA2/i.test(text) || (/Logged in as User/i.test(text) && /\[[^\r\n]+\]>/.test(text)) || text.length >= 8192) finish();
    });
    socket.on('error', () => { connected = false; finish(); }); socket.on('close', finish);
  });
}

export class Ma2DiscoveryService {
  private controller: AbortController | null = null;
  cancel(): void { this.controller?.abort(); }
  async search(saved: Ma2NetworkSettings[]): Promise<Ma2Discovery> {
    if (this.controller) throw new Error('正在搜索控台，请等待或取消');
    const controller = new AbortController(); this.controller = controller;
    try {
      const interfaces = networkInterfaces();
      const plan = discoveryTargets(interfaces, saved); const hosts: Ma2Discovery['hosts'] = []; let cursor = 0;
      const broadcast = await broadcastTargets(controller.signal, interfaces, plan.warnings);
      const neighbors: Address[] = [];
      if (process.platform === 'win32') {
        try {
          const response = await executePowerShell("Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.State -in @('Reachable','Stale','Delay','Probe','Permanent') } | Select-Object -ExpandProperty IPAddress", 5000);
          for (const host of response.trim().split(/\s+/).slice(0, 256)) if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && !host.endsWith('.255') && !host.startsWith('224.') && !host.startsWith('239.')) neighbors.push({ host, port: 30000 });
        } catch { plan.warnings.push('无法读取网卡邻居目录，本次仅使用网络广播及网段搜索。'); }
      }
      plan.addresses.unshift(...[...broadcast, ...neighbors].filter((address, index, all) => all.findIndex(value => value.host === address.host) === index && !plan.addresses.some(existing => existing.host === address.host && existing.port === address.port)));
      await Promise.all(Array.from({ length: 24 }, async () => {
        while (!controller.signal.aborted && cursor < plan.addresses.length) {
          const address = plan.addresses[cursor++]; if (!address) break;
          const result = await probeMa2(address, controller.signal); if (result) hosts.push(result);
        }
      }));
      if (controller.signal.aborted) plan.warnings.push('搜索已取消，显示已发现的地址。');
      return { hosts: hosts.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true })), ranges: plan.ranges, warnings: plan.warnings };
    } finally { this.controller = null; }
  }
}
