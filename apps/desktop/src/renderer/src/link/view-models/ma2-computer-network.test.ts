import { afterEach, expect, it, vi } from 'vitest';
import { prepareMa2ComputerNetwork } from './ma2-computer-network';
import { ma2CredentialsForTarget } from './ma2-credentials';
const adapter={id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',index:1,name:'控台网口',description:'Ethernet',connected:true,physical:true,wired:true,addresses:[{address:'2.0.0.97',prefix:24}]};
const state={adapters:[adapter],additions:[]};
const plan={id:'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',host:'2.0.0.1',address:'2.0.0.97',prefix:24,adapter,needsChange:false,message:'复用已有地址'};
afterEach(()=>vi.unstubAllGlobals());
it('顶部入口没有 observer 也必须执行网络准备，已有地址只记录选择',async()=>{
  const apply=vi.fn().mockResolvedValue(state);const prepare=vi.fn().mockResolvedValue(plan);
  vi.stubGlobal('window',{tbLink:{getMa2NetworkSetup:()=>Promise.resolve(state),planMa2NetworkSetup:prepare,applyMa2NetworkSetup:apply}});
  await prepareMa2ComputerNetwork('2.0.0.1');
  expect(prepare).toHaveBeenCalledWith({host:'2.0.0.1',prefix:24});expect(apply).toHaveBeenCalledExactlyOnceWith(plan.id);
});
it('本机 onPC 不修改网卡；配置失败不继续、也不自动重试',async()=>{
  const apply=vi.fn().mockRejectedValue(new Error('Windows 授权取消'));const prepare=vi.fn().mockResolvedValue({...plan,needsChange:true});
  vi.stubGlobal('window',{tbLink:{getMa2NetworkSetup:()=>Promise.resolve(state),planMa2NetworkSetup:prepare,applyMa2NetworkSetup:apply}});
  await prepareMa2ComputerNetwork('127.0.0.1');await prepareMa2ComputerNetwork('2.0.0.97');expect(prepare).not.toHaveBeenCalled();
  await expect(prepareMa2ComputerNetwork('2.0.0.1')).rejects.toThrow('授权取消');expect(apply).toHaveBeenCalledTimes(1);
});
it('新 IP 保留默认账号的默认密码；已有目标读取自己的密码，切换目标不携带旧密码',()=>{
  const target={host:'2.0.0.1',port:30000,monitorPort:30001,username:'administrator'};
  expect(ma2CredentialsForTarget([],target)).toEqual({password:'admin',edited:true});
  expect(ma2CredentialsForTarget([{...target,autoConnect:false}],target)).toEqual({password:'',edited:false});
  expect(ma2CredentialsForTarget([{...target,autoConnect:false}],{...target,host:'2.0.0.2'})).toEqual({password:'admin',edited:true});
  expect(ma2CredentialsForTarget([],{...target,username:'operator'})).toEqual({password:'',edited:true});
});
