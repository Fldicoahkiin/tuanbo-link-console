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
