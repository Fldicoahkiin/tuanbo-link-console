import { isIP } from 'node:net';
import { ServiceError } from './service';

/** Only the local reverse proxy may replace the rate-limit address. */
export function clientAddress(remote: string | undefined, forwarded: string | string[] | undefined, trustLoopback: boolean): string {
  let address = remote ?? 'unknown';
  if (trustLoopback && (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') && forwarded !== undefined) {
    if (typeof forwarded !== 'string' || forwarded.includes('%') || !isIP(forwarded)) throw new ServiceError(400, 'INVALID_PROXY_ADDRESS', '代理来源地址无效');
    address = forwarded;
  }
  if (isIP(address) !== 6 || address.includes('%')) return address;
  // Equivalent compressed/expanded IPv6 addresses must share one rate bucket.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (!mapped) return normalized;
  const high = Number.parseInt(mapped[1]!, 16); const low = Number.parseInt(mapped[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** 限流计数单位：IPv4 按单个地址，IPv6 按 /64（一个用户通常持有整段，可随意换后缀）。 */
export function rateBucket(address: string): string {
  if (isIP(address) !== 6 || address.includes('%')) return address;
  const [head = '', tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map(group => Number.parseInt(group, 16).toString(16)).join(':')}::/64`;
}
