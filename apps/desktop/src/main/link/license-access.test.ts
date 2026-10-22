import { expect, it } from 'vitest';
import type { LicenseStatus } from '@tb/schema';
import { LicenseAccess, needsProductLicense } from './license-access';

const valid: LicenseStatus = {
  machineCode: `TB1-${'A'.repeat(64)}`, state: 'active', message: '', enforcement: 'required', onlineAvailable: true,
  claims: { version: 1, product: 'tuanbo-link-console', licenseId: '9d53530a-6712-423e-985e-e69beb9ec1c6', customer: '测试客户', machineCode: `TB1-${'A'.repeat(64)}`, kind: 'perpetual', issuedAt: '2026-09-27T00:00:00Z', useUntil: null, updatesUntil: '2027-09-27T00:00:00Z' }
};
it('许可到期后仍能暂停和停止原生引擎，但不能重新出声', () => {
  const envelope = { version: 1, sessionId: '9d53530a-6712-423e-985e-e69beb9ec1c6', generation: 1 };
  for (const kind of ['stop', 'pause']) expect(needsProductLicense('link:native-player-control', { ...envelope, kind })).toBe(false);
  expect(needsProductLicense('link:native-player-control', { ...envelope, kind: 'play' })).toBe(true);
  expect(needsProductLicense('link:native-player-prepare', undefined)).toBe(true);
  expect(() => needsProductLicense('link:native-player-control', { kind: 'stop' })).toThrow();
});
it('另一台尚未激活的测试电脑仍可查看与导出诊断，但不能开启产品输出', async () => {
  const access = new LicenseAccess(() => Promise.resolve({ ...valid, state: 'inactive' }));
  for (const channel of ['link:log-record', 'link:log-query', 'link:log-export', 'link:log-open-folder', 'link:diagnostic-export']) {
    await expect(access.authorize(channel, undefined)).resolves.toBeUndefined();
  }
  await expect(access.authorize('link:obs-connect', undefined)).rejects.toThrow('有效授权');
});
it('未付费拒绝工程和设备操作，到期会话可完成，停止后不得再运行', async () => {
  let state: LicenseStatus['state'] = 'inactive';
  const access = new LicenseAccess(() => Promise.resolve({ ...valid, state, message: state }));
  for (const channel of ['link:create-project', 'link:open-project', 'link:save-project', 'link:obs-connect', 'link:generate-waveform']) await expect(access.authorize(channel, undefined)).rejects.toThrow('有效授权');
  await expect(access.setActive(true)).rejects.toThrow('有效授权');
  state = 'active'; await access.setActive(true);
  state = 'expired'; await expect(access.requireOutput()).resolves.toBeUndefined();
  await access.setActive(false);
  await expect(access.requireOutput()).rejects.toThrow('expired');
  await expect(access.authorize('link:save-project', undefined)).resolves.toBeUndefined();
  // Recovery copies protect the same work as a save.
  for (const channel of ['link:write-recovery-copy', 'link:discard-recovery-copy', 'link:project-document-worker', 'link:restart-project-document-worker']) await expect(access.authorize(channel, undefined)).resolves.toBeUndefined();
});
it('未曾授权时恢复副本写入与保存一样被拒绝', async () => {
  const access = new LicenseAccess(() => Promise.resolve({ ...valid, state: 'inactive', message: 'inactive' }));
  for (const channel of ['link:write-recovery-copy', 'link:discard-recovery-copy', 'link:resolve-recovery-copy']) await expect(access.authorize(channel, undefined)).rejects.toThrow('有效授权');
});
it('仅授权入口和安全停止豁免，新接口默认需要付费', () => {
  for (const channel of ['link:license-status', 'link:license-activate-code', 'link:license-import', 'link:purchase-catalog', 'link:purchase-list', 'link:purchase-create', 'link:purchase-refresh', 'link:purchase-open-payment', 'link:window-control', 'link:process-stop', 'link:obs-disconnect', 'link:ma2-network-disconnect', 'link:obs-source-cancel']) expect(needsProductLicense(channel, undefined)).toBe(false);
  expect(needsProductLicense('link:set-runtime-active', false)).toBe(false);
  expect(needsProductLicense('link:purchase-copy-code', undefined)).toBe(false);
  for (const channel of ['link:set-document-state', 'link:resolve-unsaved-changes', 'link:save-response']) expect(needsProductLicense(channel, undefined)).toBe(false);
  expect(needsProductLicense('link:set-runtime-active', true)).toBe(true);
  expect(needsProductLicense('link:obs-execute', { id: 'stop', label: '停止', kind: 'obs.mediaAction', inputName: 'media', action: 'stop' })).toBe(false);
  expect(needsProductLicense('link:obs-execute', { id: 'start', label: '开始', kind: 'obs.mediaAction', inputName: 'media', action: 'start' })).toBe(true);
  for (const channel of ['link:unknown-feature', 'link:load-profile', 'link:obs-inventory', 'link:ma2-preview', 'link:obs-live-edit']) expect(needsProductLicense(channel, undefined)).toBe(true);
});
it('授权读取期间停止，迟到结果不能重新授予运行会话', async () => {
  let finish: (value: LicenseStatus) => void = () => { throw new Error('未开始读取'); };
  const access = new LicenseAccess(() => new Promise<LicenseStatus>(resolve => { finish = resolve; }));
  const starting = access.setActive(true);
  await access.setActive(false);
  finish(valid);
  await expect(starting).rejects.toThrow('运行已停止');
});
it('试用和缺少许可的 active 状态都不能获得付费权限', async () => {
  await expect(new LicenseAccess(() => Promise.resolve({ ...valid, claims: null })).requireOutput()).rejects.toThrow('有效授权');
  await expect(new LicenseAccess(() => Promise.resolve({ ...valid, claims: valid.claims ? { ...valid.claims, kind: 'trial' } : null })).requireOutput()).rejects.toThrow('有效授权');
});
it('只有未激活的电脑提示购买；已付费但需联网或到期时只说明原因', async () => {
  const blocked = (state: LicenseStatus['state'], message: string) => new LicenseAccess(() => Promise.resolve({ ...valid, state, message })).requireOutput();
  await expect(blocked('inactive', '此主机尚未激活')).rejects.toThrow('请购买并激活本机');
  for (const state of ['renewal-required', 'expired'] as const) {
    const failure = await blocked(state, '无法连接授权服务器').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('无法连接授权服务器');
    expect(String(failure)).not.toContain('请购买');
  }
});
