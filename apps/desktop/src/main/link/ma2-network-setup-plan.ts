import { randomUUID } from 'node:crypto';
import { ma2NetworkSetupRequestSchema, type Ma2NetworkAdapter, type Ma2NetworkSetupPlan, type Ma2NetworkSetupRequest } from '@tb/schema';

const value = (address: string): number => address.split('.').reduce((result, part) => result * 256 + Number(part), 0);
const mask = (prefix: number): number => (0xffffffff << (32 - prefix)) >>> 0;
export function sameNetwork(a: string, b: string, prefix: number): boolean { return (value(a) & mask(prefix)) === (value(b) & mask(prefix)); }
function usable(address: string, prefix: number): boolean {
  const ip = value(address); const host = (ip & ~mask(prefix)) >>> 0;
  return ip >= 0x01000000 && ip < 0xe0000000 && !address.startsWith('127.') && !address.startsWith('169.254.') && host !== 0 && host !== (~mask(prefix) >>> 0);
}
export function planMa2Network(adapters: Ma2NetworkAdapter[], request: Ma2NetworkSetupRequest): Ma2NetworkSetupPlan {
  const parsed = ma2NetworkSetupRequestSchema.parse(request);
  if (!usable(parsed.host, parsed.prefix)) throw new Error('请填写控台的有效 IPv4 地址，不可使用网络地址、广播地址或本机回环地址');
  const connected = adapters.filter(adapter => adapter.connected);
  const matching = connected.filter(adapter => adapter.physical && adapter.wired && adapter.addresses.some(entry => entry.prefix > 0 && entry.prefix < 32 && sameNetwork(entry.address, parsed.host, entry.prefix)));
  const candidates = matching.length ? matching : connected.filter(adapter => adapter.physical && adapter.wired);
  const adapter = parsed.adapterId ? connected.find(adapter => adapter.id === parsed.adapterId) : candidates.length === 1 ? candidates[0] : undefined;
  if (!adapter) throw new Error(candidates.length > 1 ? '检测到多张可用网卡，请选择插控台网线的那一张，再点自动连接' : '没有找到可用的有线网卡，请插入网线或在手动设置中选择网卡');
  if (adapters.some(adapter => adapter.addresses.some(entry => entry.address === parsed.host))) throw new Error('控台 IP 与电脑现有 IP 相同，请核对控台屏幕上的地址');
  const existing = adapter.addresses.find(entry => entry.prefix > 0 && entry.prefix < 32 && sameNetwork(entry.address, parsed.host, entry.prefix));
  const selected = parsed.address ? adapter.addresses.find(entry => entry.address === parsed.address && entry.prefix > 0 && entry.prefix < 32 && sameNetwork(entry.address, parsed.host, entry.prefix)) : existing;
  if (selected) return { id: randomUUID(), adapter, host: parsed.host, address: selected.address, prefix: parsed.prefix, needsChange: false, message: `将使用“${adapter.name}”的 ${selected.address} 连接控台 ${parsed.host}；地址在同一网段，通信是否可用以连接结果为准。` };
  let address = parsed.address;
  if (!address) {
    const target = value(parsed.host); const occupied = new Set(adapters.flatMap(adapter => adapter.addresses.map(entry => entry.address)));
    for (const offset of [-1, 1, -2, 2, -3, 3]) {
      const candidate = target + offset;
      const text = [24, 16, 8, 0].map(shift => (candidate >>> shift) & 255).join('.');
      if (sameNetwork(text, parsed.host, parsed.prefix) && usable(text, parsed.prefix) && !occupied.has(text)) { address = text; break; }
    }
  }
  if (!address || address === parsed.host || !usable(address, parsed.prefix) || !sameNetwork(address, parsed.host, parsed.prefix)) throw new Error('电脑 IP 必须与控台在同一网段，且不能相同');
  if (adapters.some(adapter => adapter.addresses.some(entry => entry.address === address))) throw new Error('电脑已经使用这个 IP，请选择其他地址');
  return { id: randomUUID(), adapter, host: parsed.host, address, prefix: parsed.prefix, needsChange: true, message: `为“${adapter.name}”增加控台专用地址 ${address}/${parsed.prefix}，连接 ${parsed.host}。保留现有 IP、自动获取地址、网关和 DNS；电脑重启或网卡重置后需重新配置。` };
}
