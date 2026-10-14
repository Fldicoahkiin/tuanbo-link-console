import { expect, it } from 'vitest';
import { display } from './forms';

it('枚举字段显示中文，客户名、用户名和备注保持原样', () => {
  expect(display('state', 'fulfilled')).toBe('已交付');
  expect(display('customerType', 'company')).toBe('企业');
  expect(display('role', 'owner')).toBe('负责人');
  expect(display('customer', 'test')).toBe('test');
  expect(display('username', 'owner')).toBe('owner');
  expect(display('actor', 'operations')).toBe('operations');
  expect(display('buyer', 'personal')).toBe('personal');
});
