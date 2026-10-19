import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Ma2NetworkAdapter } from '@tb/schema';
import { Ma2NetworkSetup, networkAdapterScript } from './ma2-network-setup';
import { planMa2Network } from './ma2-network-setup-plan';
import { NetworkAddressChangeError, networkAddressNativeSource, networkAddressScript } from './ma2-network-address';

const adapter: Ma2NetworkAdapter = { id: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', index: 3, name: '有线网卡', description: 'Ethernet', connected: true, physical: true, wired: true, addresses: [{ address: '192.168.1.10', prefix: 24 }] };
const request = { host: '2.97.214.223', prefix: 24 };
it('电脑已有地址直接复用实际掩码；手填另一网卡地址时正确识别其所属网卡', () => {
  const consoleAdapter = { ...adapter, id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', addresses:[{address:'2.0.0.97',prefix:8,state:'Preferred' as const}] };
  expect(planMa2Network([adapter,consoleAdapter],{host:'2.0.0.1',address:'2.0.0.97',prefix:24})).toMatchObject({adapter:consoleAdapter,address:'2.0.0.97',prefix:8,needsChange:false});
  expect(()=>planMa2Network([adapter,consoleAdapter],{host:'2.0.0.1',address:'192.168.1.10',prefix:24})).toThrow('自动选择电脑 IP');
  expect(()=>planMa2Network([{...consoleAdapter,addresses:[{address:'2.0.0.97',prefix:8,state:'Duplicate'}]}],{host:'2.0.0.1',address:'2.0.0.97',prefix:24})).toThrow('Duplicate');
});
it('读取方案不改变连接来源，复用地址也持久保存网卡选择，重开后可再次自动连接', async()=>{
  const path=join(await mkdtemp(join(tmpdir(),'tblink-selection-')),'addresses.json');
  const second={...adapter,id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',index:4,name:'控台网口',addresses:[{address:'192.168.1.11',prefix:24}]};
  const snapshot=()=>Promise.resolve({bootId:'boot1',adapters:[adapter,second]});const change=vi.fn(()=>Promise.resolve());
  const setup=new Ma2NetworkSetup(path,{snapshot,change});
  const plan=await setup.plan({host:'192.168.1.20',adapterId:second.id,prefix:24});
  expect(await setup.connectionAddress(plan.host)).toBeUndefined();await setup.apply(plan.id);expect(change).not.toHaveBeenCalled();
  const reopened=new Ma2NetworkSetup(path,{snapshot,change});expect(await reopened.connectionAddress(plan.host)).toBe('192.168.1.11');
  expect(await reopened.plan({host:plan.host,prefix:24})).toMatchObject({adapter:second,needsChange:false});
  expect((await reopened.state()).additions).toEqual([]);
});
it('区分已有地址、真实冲突、检测超时；超时不冒充冲突，清理失败保留恢复入口',()=>{
  expect(new NetworkAddressChangeError(5010).message).toContain('已经存在');
  expect(new NetworkAddressChangeError(41001).message).toContain('确认');
  expect(new NetworkAddressChangeError(41002).message).toContain('未确认冲突');
  expect(new NetworkAddressChangeError(41002).needsRestore).toBe(false);
  expect(new NetworkAddressChangeError(50005).needsRestore).toBe(true);
});
it('连接使用所选网卡地址，重开后读取配置记录，地址失效时阻止误走其他网卡', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-source-')), 'addresses.json');
  const snapshot = vi.fn(() => Promise.resolve({ bootId: 'boot1', adapters: [adapter] }));
  const change = vi.fn(() => Promise.resolve());
  const setup = new Ma2NetworkSetup(path, { snapshot, change });
  const existing = await setup.plan({ host: '192.168.1.20', prefix: 24 });
  expect(await setup.connectionAddress('192.168.1.20')).toBeUndefined();
  await setup.apply(existing.id);
  expect(await setup.connectionAddress('192.168.1.20')).toBe('192.168.1.10');
  expect(await setup.connectionAddress('127.0.0.1')).toBeUndefined();
  const plan = await setup.plan(request); await setup.apply(plan.id);
  snapshot.mockResolvedValue({ bootId: 'boot1', adapters: [{ ...adapter, addresses: [...adapter.addresses, { address: plan.address, prefix: 24 }] }] });
  const reopened = new Ma2NetworkSetup(path, { snapshot, change });
  expect(await reopened.connectionAddress(request.host)).toBe(plan.address);
  snapshot.mockResolvedValue({ bootId: 'boot1', adapters: [adapter] });
  await expect(reopened.connectionAddress(request.host)).rejects.toThrow('已不可用');
});
it.runIf(process.platform === 'win32')('原生读取网卡并区分 Windows 测试环回网卡，不修改任何地址', async () => {
  const setup = new Ma2NetworkSetup(join(await mkdtemp(join(tmpdir(), 'tblink-network-read-')), 'addresses.json'));
  const state = await setup.state();
  expect(Array.isArray(state.adapters)).toBe(true);
  for (const entry of state.adapters.filter(entry => entry.description.includes('KM-TEST'))) expect(entry.physical).toBe(false);
  expect(state.additions).toEqual([]);
}, 20000);
it('自动选择实体网卡并生成同网段独立地址，不误选虚拟网卡、不修改原地址', () => {
  const virtual = { ...adapter, id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', physical: false, addresses: [{ address: '2.0.0.3', prefix: 8 }] };
  const plan = planMa2Network([virtual, adapter], request);
  expect(plan).toMatchObject({ address: '2.97.214.127', needsChange: true, adapter });
  expect(adapter.addresses).toEqual([{ address: '192.168.1.10', prefix: 24 }]);
});
it('已在同网段不增加地址，多网卡要求选择，拒绝同地址和越界地址', () => {
  expect(planMa2Network([adapter], { host: '192.168.1.20', prefix: 24 }).needsChange).toBe(false);
  expect(() => planMa2Network([adapter, { ...adapter, id: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' }], request)).toThrow('多张');
  for (const address of ['2.97.214.223', '2.97.214.255', '3.0.0.1']) expect(() => planMa2Network([adapter], { ...request, address })).toThrow('同一网段');
});
it('配置记录在软件重开后可恢复，仅移除本软件地址；跨系统重启不删除新地址', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-network-')), 'addresses.json');
  const snapshot = vi.fn(() => Promise.resolve({ bootId: 'boot1', adapters: [adapter] }));
  const change = vi.fn(() => Promise.resolve());
  const setup = new Ma2NetworkSetup(path, { snapshot, change });
  const plan = await setup.plan(request); await setup.apply(plan.id);
  expect(change).toHaveBeenCalledWith(plan, false);
  const reopened = new Ma2NetworkSetup(path, { snapshot, change });
  expect((await reopened.state()).additions).toHaveLength(1);
  await reopened.restore(plan.id); expect(change).toHaveBeenLastCalledWith(plan, true);
  expect((await reopened.state()).additions).toHaveLength(0);
  const next = await setup.plan(request); await setup.apply(next.id);
  snapshot.mockResolvedValue({ bootId: 'boot2', adapters: [adapter] }); change.mockClear();
  await reopened.restore(next.id); expect(change).not.toHaveBeenCalled();
});
it('管理员取消、网卡变化和伪造方案不能连接或留下错误恢复记录', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-network-')), 'addresses.json');
  const snapshot = vi.fn(() => Promise.resolve({ bootId: 'boot1', adapters: [adapter] }));
  const change = vi.fn(() => Promise.reject(new Error('管理员授权取消')));
  const setup = new Ma2NetworkSetup(path, { snapshot, change });
  await expect(setup.apply('forged')).rejects.toThrow('已过期');
  const plan = await setup.plan(request);
  await expect(setup.apply(plan.id)).rejects.toThrow('授权取消');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([]);
  snapshot.mockResolvedValue({ bootId: 'boot1', adapters: [{ ...adapter, index: 5 }] });
  await expect(setup.apply(plan.id)).rejects.toThrow('网卡状态已变化'); expect(change).toHaveBeenCalledOnce();
});
it('校验失败且原生清理失败时保留恢复入口，恢复成功才删除记录', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tblink-network-')), 'addresses.json');
  const change = vi.fn().mockRejectedValueOnce(new NetworkAddressChangeError(50005)).mockResolvedValueOnce(undefined);
  const setup = new Ma2NetworkSetup(path, { snapshot: () => Promise.resolve({ bootId: 'boot1', adapters: [adapter] }), change });
  const plan = await setup.plan(request);
  await expect(setup.apply(plan.id)).rejects.toThrow('恢复原配置');
  expect((await setup.state()).additions).toHaveLength(1);
  await setup.restore(plan.id); expect((await setup.state()).additions).toHaveLength(0);
});
it.runIf(process.platform === 'win32')('原生结构编译与大小、PowerShell 语法检查；不修改网络', async () => {
  const plan = planMa2Network([adapter], request);
  const scripts = [networkAddressScript(plan, false), networkAddressScript(plan, true), networkAdapterScript];
  const native = Buffer.from(networkAddressNativeSource, 'utf16le').toString('base64');
  const encoded = scripts.map(script => Buffer.from(script, 'utf16le').toString('base64'));
  const commands = [`Add-Type -TypeDefinition ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${native}'))); if([Runtime.InteropServices.Marshal]::SizeOf([type][TblinkNetworkAddress+Row]) -ne 80){throw 'Native layout mismatch'}; $local=Get-NetIPAddress -IPAddress 127.0.0.1 -AddressFamily IPv4; $row=[TblinkNetworkAddress+Row]::new();$row.Family=2;$row.Index=$local.InterfaceIndex;$row.Address=[BitConverter]::ToUInt32([Net.IPAddress]::Parse('127.0.0.1').GetAddressBytes(),0);$arguments=@($row);$method=[TblinkNetworkAddress].GetMethod('GetUnicastIpAddressEntry',[Reflection.BindingFlags]'NonPublic,Static');if($method.Invoke($null,$arguments) -ne 0 -or $arguments[0].Prefix -ne $local.PrefixLength){throw 'Native readback mismatch'}`,
    ...encoded.map(script => `$tokens=$null;$errors=$null;[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${script}')),[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ($errors|Out-String)}`)];
  for (const command of commands) await expect(promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ProgressPreference='SilentlyContinue';${command}`, 'utf16le').toString('base64')], { windowsHide: true })).resolves.toMatchObject({ stderr: '' });
}, 15000);
