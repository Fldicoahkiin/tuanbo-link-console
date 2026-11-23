import { expect, it } from 'vitest';
import { bridgeSource, Ma2LuaConsole } from './fixtures/ma2-lua-console';
const hex=(value:string)=>Buffer.from(value).toString('hex');
function fixture(){
  const ma2=new Ma2LuaConsole();
  const code=12302;
  ma2.set('Executor 1.101',{label:'Flash',xml:`<MA><Exec><Assignment name="Flash"><No>25</No><No>1</No><No>9000</No></Assignment><AssignmentExec><Button>${code}</Button></AssignmentExec></Exec></MA>`});
  const press=(pressed=true,id='a'.repeat(32))=>ma2.lua(`return TBLINK_EXEC_INPUT(TOKEN,ID,1,101,0,${pressed},${code},9000,LABEL,SHOW,GEN,REF)`,{TOKEN:'b'.repeat(32),ID:id,LABEL:hex('Flash'),SHOW:hex('tblink_fake_show'),GEN:hex('1000'),REF:hex('25.1.9000')})[0]?.toString();
  const timers=()=>Number(ma2.lua('return #FAKE.timers')[0]?.toString());
  const tick=(seconds=0.25)=>ma2.lua(`FAKE.now=FAKE.now+${seconds};FAKE.tick()`);
  return {ma2,press,timers,tick};
}
it('网络连接空闲、重复检查和停止时不保留常驻 Lua 定时任务',()=>{
  const f=fixture();expect(f.timers()).toBe(0);
  f.ma2.lua('FAKE.main();FAKE.main("network")');
  expect(f.timers()).toBe(0);
});
it('按住 Flash 只保留一个有限任务，续租不增生，松开后退出且不重复 Off',()=>{
  const f=fixture();expect(f.press()).toBe('SENT');expect(f.timers()).toBe(1);
  for(let i=0;i<10;i++){
    f.tick();expect(f.press()).toBe('HELD');expect(f.timers()).toBe(1);
    expect(f.ma2.lua('return FAKE.timers[1].count')[0]?.toString()).toBe('1');
  }
  expect(f.press(false)).toBe('RELEASED');f.tick();expect(f.timers()).toBe(0);
  expect(f.press(false)).toBe('RELEASED');
  expect(f.ma2.commands().filter(value=>value==='Flash Off Executor 1.101')).toHaveLength(1);
});
it('断线不续租时先自动松开，再结束看门任务',()=>{
  const f=fixture();f.press();f.tick(2.25);
  expect(f.ma2.commands().at(-1)).toBe('Flash Off Executor 1.101');
  expect(f.timers()).toBe(0);
  expect(f.press()).toMatch(/^ERR:/);
});
it('升级与手动停止释放旧按键，旧任务不会继续挂着',()=>{
  for(const stop of ['TBLINK_BRIDGE_GENERATION="new-generation"','FAKE.main()','TBLINK_EXEC_RELEASE_ALL()']){
    const f=fixture();f.press();f.ma2.lua(stop);f.tick();
    expect(f.timers()).toBe(0);
    expect(f.ma2.commands().filter(value=>value==='Flash Off Executor 1.101')).toHaveLength(1);
  }
});
it('从本机文件切到网络时，排队等待的旧文件读取不能取走新请求', () => {
  const desk = new Ma2LuaConsole(bridgeSource, 'file');
  desk.lua('FAKE.main(); FAKE.main("network")');
  const request = 'b'.repeat(32) + '\nPING\n1\n0\n';
  expect(desk.poll(request)).toBeNull();
  expect(desk.file('/fake/temp/tblink_bridge_request.txt')?.toString()).toBe(request);
  desk.lua('FAKE.tick(); FAKE.tick()');
  expect(desk.lua('return #FAKE.timers')[0]?.toString()).toBe('0');
});

it('本机单个请求损坏时只拒绝这次请求，下一次核对照常返回', () => {
  const desk = new Ma2LuaConsole(bridgeSource, 'file');
  const bad = 'c'.repeat(32), next = 'd'.repeat(32);
  expect(desk.poll(bad + '\nnot-a-request')).toMatch(new RegExp('^' + bad + '\\nERROR\\n'));
  expect(desk.poll(next + '\nPING\n1\n0\n')).toMatch(new RegExp('^' + next + '\\nOK\\n'));
});

it('本机文件轮询正常续行，停止或换代后退出，不因快速开关累积',()=>{
  const ma2=new Ma2LuaConsole(bridgeSource,'file');
  ma2.lua('FAKE.main();FAKE.main("local");FAKE.tick()');
  expect(ma2.lua('return #FAKE.timers')[0]?.toString()).toBe('1');
  for(let i=0;i<5;i++){
    ma2.lua('FAKE.now=FAKE.now+1;FAKE.main=assert(load(SOURCE))();FAKE.main("local");FAKE.tick()',{SOURCE:bridgeSource});
    expect(ma2.lua('return #FAKE.timers')[0]?.toString()).toBe('1');
  }
  ma2.lua('FAKE.main();FAKE.tick()');
  expect(ma2.lua('return #FAKE.timers')[0]?.toString()).toBe('0');
});
