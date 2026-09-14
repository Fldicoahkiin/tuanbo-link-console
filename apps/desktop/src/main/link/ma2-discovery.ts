import { createConnection } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { Ma2Discovery, Ma2NetworkSettings } from '@tb/schema';

type Address = { host: string; port: number };
/** Bounded, read-only probes. No login, commands, or credential distribution. */
export function discoveryTargets(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, saved: Ma2NetworkSettings[]): { addresses: Address[]; ranges: string[]; warnings: string[] } {
  const addresses = new Map<string, Address>();
  const ranges = new Set<string>(); const warnings: string[] = [];
  const add = (host: string, port = 30000): void => { addresses.set(`${host}:${port}`, { host, port }); };
  add('127.0.0.1');
  for (const profile of saved) add(profile.host, profile.port);
  for (const entries of Object.values(interfaces)) for (const entry of entries ?? []) {
    if (entry.family !== 'IPv4' || entry.internal) continue;
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
  return { addresses: [...addresses.values()], ranges: ['本机 127.0.0.1', ...ranges], warnings };
}

export function probeMa2(address: Address, signal: AbortSignal, timeoutMs = 650): Promise<Ma2Discovery['hosts'][number] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = createConnection(address); let text = ''; let connected = false; let finished = false;
    const finish = (): void => {
      if (finished) return; finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', cancel); socket.destroy();
      const identified = /grandMA2/i.test(text) || (/Logged in as User/i.test(text) && /\[Channel\]>/i.test(text));
      resolve(!signal.aborted && connected ? { ...address, identity: identified ? 'ma2' : 'candidate' } : null);
    };
    const cancel = (): void => { connected = false; finish(); };
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('connect', () => { connected = true; });
    socket.on('data', (data: Buffer) => {
      text = (text + data.toString('utf8')).slice(0, 8192);
      if (/grandMA2/i.test(text) || /\[Channel\]>/.test(text) || text.length >= 8192) finish();
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
      const plan = discoveryTargets(networkInterfaces(), saved); const hosts: Ma2Discovery['hosts'] = []; let cursor = 0;
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
