import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';

export type NetworkAnnouncements = { hosts: string[]; warnings: string[]; packets: number };

/** Only observes source addresses. UDP traffic is never treated as proof of MA2 identity.
 * MA Network Switch protocol table: MA-Net2 control 29998, data 29999.
 * No MA session join, discovery command, credentials, or show data is transmitted.
 */
export async function readMa2NetworkAnnouncements(
  interfaces: string[], signal: AbortSignal,
  options: { ports: number[]; groups: string[]; durationMs: number } = {
    ports: [29998, 29999], groups: Array.from({ length: 256 }, (_, index) => `236.4.0.${index}`), durationMs: 3000
  }
): Promise<NetworkAnnouncements> {
  const hosts = new Set<string>(); const warnings = new Set<string>(); let packets = 0;
  if (signal.aborted) return { hosts: [], warnings: [], packets };
  const addresses = [...new Set(interfaces)].slice(0, 8);
  if (!addresses.length) return { hosts: [], warnings: ['没有可用于 MA 网络监听的 IPv4 网卡'], packets };
  // Bound memberships per socket for Windows. All sockets are released after this search.
  const batches: string[][] = [];
  for (let index = 0; index < options.groups.length; index += 16) batches.push(options.groups.slice(index, index + 16));
  const active = new Set<() => void>();
  const cancel = (): void => { for (const finish of active) finish(); };
  signal.addEventListener('abort', cancel, { once: true });
  try { await Promise.all(addresses.flatMap(address => options.ports.flatMap(port => batches.map(groups => new Promise<void>(resolve => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    let done = false; let joined = 0;
    const finish = (): void => {
      if (done) return; done = true; clearTimeout(timer); active.delete(finish);
      socket.close(); resolve();
    };
    const timer = setTimeout(finish, options.durationMs);
    active.add(finish);
    socket.on('error', error => { warnings.add(`MA 网络监听 UDP ${port} 失败：${error.message}`); finish(); });
    socket.on('message', (_message, remote) => {
      packets += 1;
      if (hosts.size < 256 && isIPv4(remote.address)) hosts.add(remote.address);
    });
    socket.bind(port, '0.0.0.0', () => {
      if (done) return;
      for (const group of groups) {
        try { socket.addMembership(group, address); joined += 1; }
        catch (error) { warnings.add(`${address} 无法监听 MA 网络组播：${error instanceof Error ? error.message : String(error)}`); }
      }
      if (!joined) finish();
    });
  }))))); } finally { signal.removeEventListener('abort', cancel); }
  return { hosts: [...hosts], warnings: [...warnings], packets };
}
