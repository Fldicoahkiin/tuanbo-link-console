import { expect, it } from 'vitest';
import { ma2AddressInput } from './ma2-address-input';

it('接受现场地址和全角输入，拒绝带端口或不可见字符的地址并给出中文错误', () => {
  for (const input of ['2.0.0.98', ' ２．０．０．９８\r\n']) expect(ma2AddressInput(input)).toBe('2.0.0.98');
  for (const input of ['2.0.0.98:30000', '2.0.0.999', '2.0.0.\u200b98', '2.0. 0.98']) expect(() => ma2AddressInput(input)).toThrow('控台 IP格式不正确');
  expect(() => ma2AddressInput('bad', '电脑 IP')).toThrow('电脑 IP格式不正确');
});
