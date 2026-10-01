import { z } from 'zod';

/** Accept full-width keyboard input and surrounding pasted whitespace only. */
export function ma2AddressInput(value: string, label = '控台 IP'): string {
  const address = value.normalize('NFKC').trim();
  if (!z.ipv4().safeParse(address).success) throw new Error(`${label}格式不正确，请填写四段数字，例如 2.0.0.98；不要包含端口、空格或其他字符`);
  return address;
}
