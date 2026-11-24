import { afterEach, expect, it, vi } from 'vitest';
import { inspectMa2ComputerNetwork } from './ma2-computer-network';
import { ma2CredentialsForTarget } from './ma2-credentials';
const adapter={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',index:1,name:'控台网口',description:'Ethernet',connected:true,physical:true,wired:true,addresses:[{address:'2.0.0.97',prefix:24}]};
const state={adapters:[adapter],additions:[]};
const plan={id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',host:'2.0.0.1',address:'2.0.0.97',prefix:24,adapter,needsChange:false,message:'复用已有地址'};
afterEach(()=>vi.unstubAllGlobals());
it('检查外部控台只显示拟用的电脑地址，本机地址跳过检查', async () => {
  const prepare = vi.fn().mockResolvedValue(plan);
  vi.stubGlobal('window', { tbLink: { planMa2NetworkSetup: prepare } });
  for (const host of ['127.0.0.1', '2.0.0.97']) expect(await inspectMa2ComputerNetwork({ host, prefix: 24 }, state)).toBeNull();
  const request = { host: '2.0.0.1', prefix: 24 };
  expect(await inspectMa2ComputerNetwork(request, state)).toMatchObject({ id: plan.id });
  expect(prepare).toHaveBeenCalledExactlyOnceWith(request);
});
it('新 IP 保留默认账号的默认密码；已有目标读取自己的密码，切换目标不携带旧密码',()=>{
  const target={host:'2.0.0.1',port:30000,monitorPort:30001,username:'administrator'};
  expect(ma2CredentialsForTarget([],target)).toEqual({password:'admin',edited:true});
  expect(ma2CredentialsForTarget([{...target,autoConnect:false}],target)).toEqual({password:'',edited:false});
  expect(ma2CredentialsForTarget([{...target,autoConnect:false}],{...target,host:'2.0.0.2'})).toEqual({password:'admin',edited:true});
  expect(ma2CredentialsForTarget([],{...target,username:'operator'})).toEqual({password:'',edited:true});
});
