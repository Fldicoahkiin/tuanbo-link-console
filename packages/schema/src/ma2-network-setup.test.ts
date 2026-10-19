import { expect, it } from 'vitest';
import { ma2NetworkAdapterSchema, ma2NetworkSetupRequestSchema } from './ma2-network-setup';
it('Windows 虚拟网卡 GUID 不要求 UUID 版本位，同时拒绝非法标识', () => {
  const id = 'd18ef160-87aa-061e-1aaf-b5befc892bb1';
  expect(ma2NetworkAdapterSchema.safeParse({ id, index: 12, name: '测试网卡', description: 'Windows adapter', connected: true, physical: false, wired: false, addresses: [] }).success).toBe(true);
  expect(ma2NetworkSetupRequestSchema.safeParse({ host: '2.0.0.1', adapterId: id }).success).toBe(true);
  expect(ma2NetworkSetupRequestSchema.safeParse({ host: '2.0.0.1', adapterId: 'malformed' }).success).toBe(false);
});
