import { createConnection } from 'node:net';
import { createSocket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { Ma2Discovery, Ma2NetworkSettings } from '@tb/schema';
import { executePowerShell } from './windows-integration-detector';
import { readMa2NetworkAnnouncements } from './ma2-network-announcements';
import { setMaxListeners } from 'node:events';

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
  const subnets: { near: string[]; rest: string[] }[] = [];
  const add = (host: string, port = 30000): void => { addresses.set(`${host}:${port}`, { host, port }); };
  add('127.0.0.1');
  for (const profile of saved) add(profile.host, profile.port);
  for (const [name, entries] of Object.entries(interfaces)) for (const entry of entries ?? []) {
    if (entry.family !== 'IPv4' || entry.internal) continue;
    adapters.push(`${name}：${entry.address} / ${entry.netmask}`);
    if (entry.address.startsWith('169.254.')) warnings.push(`${name} 使用自动分配地址 ${entry.address}，请确认它和控台 IP 在同一网段。`);
    const ipv4 = (text: string): number => text.split('.').reduce((value, part) => value * 256 + Number(part), 0);
    const ip = ipv4(entry.address); const mask = ipv4(entry.netmask);
    const size = 0x100000000 - mask;
    // Respect /23-/22/etc. masks instead of silently truncating every LAN to /24.
    // Huge class-A show networks use announcements/neighbors, never millions of probes.
    const scanSize = size <= 4096 ? size : 256;
    const start = size <= 4096 ? (ip & mask) >>> 0 : (ip & 0xffffff00) >>> 0;
    const textIp = (value: number): string => [24, 16, 8, 0].map(shift => (value >>> shift) & 255).join('.');
    const range = `${textIp(start)}/${32 - Math.log2(scanSize)}`;
    if (ranges.has(range)) continue;
    if (ranges.size >= 8) { warnings.push('网卡超过 8 个，部分网段未搜索；可手动填写控台 IP。'); break; }
    ranges.add(range);
    const subnet = { near: [] as string[], rest: [] as string[] };
    subnets.push(subnet);
    if (size > 4096) warnings.push(`${entry.address} 所在网络较大，逐地址检查限定为 ${range}；其他地址通过 MA 网络监听、广播、邻居目录与已保存控台发现。`);
    for (let offset = scanSize <= 2 ? 0 : 1; offset < scanSize - (scanSize <= 2 ? 0 : 1); offset += 1) {
      const candidate = start + offset;
      ((candidate >>> 8) === (ip >>> 8) ? subnet.near : subnet.rest).push(textIp(candidate));
    }
  }
  // Preserve the old local-/24 coverage before expanding larger subnets. Round
  // robin across interfaces so a Wi-Fi/VPN /20 cannot exhaust the deadline before
  // the wired console network gets its first probe.
  for (const phase of ['near', 'rest'] as const) {
    const length = Math.max(0, ...subnets.map(subnet => subnet[phase].length));
    for (let index = 0; index < length; index++) for (const subnet of subnets) {
      const host = subnet[phase][index];
      if (host && addresses.size < 8192) add(host);
    }
  }
  if (addresses.size >= 8192) warnings.push('本次逐地址检查达到 8192 个上限；各网卡同段地址优先，其余范围未全部纳入。');
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
    // One multicast cancellation listener, up to 8 ArtPoll sockets and 24 TCP probes.
    setMaxListeners(40, controller.signal);
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 45000);
    try {
      const interfaces = networkInterfaces();
      const plan = discoveryTargets(interfaces, saved); const hosts: Ma2Discovery['hosts'] = []; let cursor = 0;
      const started = performance.now();
      const announcements = readMa2NetworkAnnouncements(Object.values(interfaces).flatMap(entries => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address)), controller.signal);
      const broadcasts = broadcastTargets(controller.signal, interfaces, plan.warnings);
      const readNeighbors = async (): Promise<Address[]> => {
        const neighbors: Address[] = [];
        if (process.platform !== 'win32' || controller.signal.aborted) return neighbors;
        try {
          const response = await executePowerShell("Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.State -in @('Reachable','Stale','Delay','Probe','Permanent') } | Select-Object -ExpandProperty IPAddress", 5000);
          for (const host of response.trim().split(/\s+/).slice(0, 256)) if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && !host.endsWith('.255') && !host.startsWith('224.') && !host.startsWith('239.')) neighbors.push({ host, port: 30000 });
        } catch { plan.warnings.push('无法读取网卡邻居目录，本次仅使用网络广播及网段搜索。'); }
        return neighbors;
      };
      const [observed, broadcast, neighbors] = await Promise.all([announcements, broadcasts, readNeighbors()]);
      const preparedAt = performance.now();
      plan.warnings.push(...observed.warnings);
      const prioritized = [...saved.map(({ host, port }) => ({ host, port })), ...observed.hosts.map(host => ({ host, port: 30000 })), ...broadcast, ...neighbors, ...plan.addresses];
      plan.addresses = [...new Map(prioritized.map(address => [`${address.host}:${address.port}`, address])).values()];
      const coverage = new Map<string, { planned: number; started: number; completed: number; identified: number }>();
      const block = (host: string): string => `${host.split('.').slice(0, 3).join('.')}.0/24`;
      for (const address of plan.addresses) {
        const key = block(address.host);
        const count = coverage.get(key) ?? { planned: 0, started: 0, completed: 0, identified: 0 };
        count.planned += 1; coverage.set(key, count);
      }
      await Promise.all(Array.from({ length: 24 }, async () => {
        while (!controller.signal.aborted && cursor < plan.addresses.length) {
          const address = plan.addresses[cursor++]; if (!address) break;
          const count = coverage.get(block(address.host))!;
          count.started += 1;
          const result = await probeMa2(address, controller.signal);
          if (!controller.signal.aborted) count.completed += 1;
          if (result) { hosts.push(result); if (result.identity === 'ma2') count.identified += 1; }
        }
      }));
      if (controller.signal.aborted) plan.warnings.push(timedOut ? '搜索达到 45 秒上限，显示已发现地址；未完成的范围已保留在诊断记录中。' : '搜索已取消，显示已发现的地址。');
      if (cursor < plan.addresses.length) plan.warnings.push(`尚有 ${plan.addresses.length - cursor} 个地址未检查，本次结果不代表网络中没有控台。`);
      plan.ranges.push(`本次检查 ${cursor} 个远程地址，MA 网络监听收到 ${observed.packets} 个数据包、${observed.hosts.length} 个来源；耗时 ${Math.round(performance.now() - started)} 毫秒`);
      plan.ranges.push(`发现准备 ${Math.round(preparedAt - started)} 毫秒；远程端口检查 ${Math.round(performance.now() - preparedAt)} 毫秒；已保存目标 ${saved.length} 个`);
      for (const [range, count] of coverage) plan.ranges.push(`检查覆盖 ${range}：计划 ${count.planned}，发起 ${count.started}，完成 ${count.completed}，识别 MA2 ${count.identified}`);
      const inaccessible = observed.hosts.filter(host => !hosts.some(result => result.host === host));
      if (inaccessible.length) plan.warnings.push(`MA 网络端口收到以下地址的数据，但远程登录端口未响应：${inaccessible.join('、')}。网络可见与可读取 Cue 是两个独立检查。`);
      return { hosts: hosts.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true })), ranges: plan.ranges, warnings: plan.warnings };
    } finally { clearTimeout(deadline); this.controller = null; }
  }
}
