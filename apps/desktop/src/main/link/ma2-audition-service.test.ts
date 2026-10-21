import { expect,it,vi } from 'vitest';
import { Ma2AuditionService,type AuditionNetwork } from './ma2-audition-service';
import { Ma2CommandQueue } from './ma2-command-queue';
import type { Ma2AuditionRequest,Ma2PlaybackRequest } from '@tb/schema';
const network={host:'192.0.2.1',port:30000,monitorPort:30001,username:'test'};
const request=(sequence:number,generation=0):Ma2AuditionRequest=>({version:1,generation,sessionId:crypto.randomUUID(),deadlineAt:Date.now()+1000,network,action:{target:'sequence',sequence,action:'goto',cue:'1.100'}});
function fixture(){
  const actions:Ma2PlaybackRequest[]=[];const cancelled=new Set<string>();
  const api:AuditionNetwork={connectionGeneration:0,cancelPlayback:id=>cancelled.add(id),playCue:vi.fn<AuditionNetwork['playCue']>((input,options)=>Promise.resolve().then(()=>{if(cancelled.has(input.sessionId))throw new Error('取消');options?.beforeSend?.();actions.push(input);}))};
  return {api,actions,cancelled,service:new Ma2AuditionService(api)};
}
it('跨页面目标去重关闭，包括执行器；正式输出未登记的不关闭，停止后可再次试听',async()=>{
  const f=fixture();await f.service.play(request(1));await f.service.play(request(1));await f.service.play(request(2));
  await f.service.play({...request(3),action:{target:'executor',executor:'99.101',action:'go'}});
  await f.api.playCue({...request(80),action:{target:'sequence',sequence:80,action:'go'}});
  const result=await f.service.stop();expect(result.phase).toBe('sent');expect(result.targets).toEqual([]);
  expect(f.actions.filter(value=>value.action.action==='off').map(value=>value.action)).toEqual([{target:'sequence',sequence:1,action:'off'},{target:'sequence',sequence:2,action:'off'},{target:'executor',executor:'99.101',action:'off'}]);
  await expect(f.service.play(request(3))).rejects.toThrow('已停止');await f.service.play(request(3,result.generation));expect(f.service.status().targets).toHaveLength(1);
});
it('停止取消未发送 Cue，合并重复点击，先于排队查询；迟到结果不重新点灯',async()=>{
  const f=fixture();const queue=new Ma2CommandQueue();let release=()=>undefined as void;
  const gate=new Promise<void>(resolve=>{release=resolve;});const order:string[]=[];
  f.api.playCue=async(input,options)=>{await queue.schedule(async()=>{if(f.cancelled.has(input.sessionId))throw new Error('取消');options?.beforeSend?.();order.push(`${input.action.action}:${input.action.target==='sequence'?input.action.sequence:input.action.executor}`);if(input.action.action==='goto')await gate;return 'done';},options?.priority??'normal');};
  const first=f.service.play(request(1));const queued=f.service.play(request(2));const rejected=expect(queued).rejects.toThrow('取消');
  const query=queue.schedule(()=>{order.push('query');return Promise.resolve('done');},'normal');
  const stop=f.service.stop();expect(f.service.stop()).toBe(stop);await expect(f.service.play(request(9,1))).rejects.toThrow('已停止');
  release();await first;await rejected;await stop;await query;
  expect(order).toEqual(['goto:1','off:1','query']);expect(f.service.status().targets).toEqual([]);
});
it('结果不明保留；某个 Off 失败不阻断其他目标，重连不向新连接发旧 Off',async()=>{
  const f=fixture();await f.service.play(request(1));await f.service.play(request(2));
  const send=f.api.playCue;f.api.playCue=async(input,options)=>{if(input.action.action==='off'&&input.action.target==='sequence'&&input.action.sequence===1)throw new Error('断网');return send(input,options);};
  const result=await f.service.stop();expect(result.phase).toBe('failed');expect(result.targets).toHaveLength(1);expect(result.targets[0]?.error).toBe('断网');
  const count=f.actions.length;Object.defineProperty(f.api,'connectionGeneration',{value:1});await f.service.stop();expect(f.actions).toHaveLength(count);expect(f.service.status().targets[0]?.error).toContain('连接已改变');
  const g=fixture();g.api.playCue=(_input,options)=>Promise.resolve().then(()=>{options?.beforeSend?.();throw new Error('超时结果不明');});
  await expect(g.service.play(request(3))).rejects.toThrow('超时');expect(g.service.status().targets[0]?.state).toBe('unknown');await g.service.stop();expect(g.service.status().targets[0]?.state).toBe('failed');
});
it('旧连接确认只清除指定失败记录，不发送命令、不清除当前连接的新试听',async()=>{
  const f=fixture();await f.service.play(request(1));
  const original=f.service.status().targets[0]!;
  expect(()=>f.service.acknowledgeClosed(original.id)).toThrow('待核对');
  Object.defineProperty(f.api,'connectionGeneration',{value:1});
  await f.service.stop();
  expect(f.service.status().targets[0]?.connectionChanged).toBe(true);
  await f.service.play(request(1,1));
  const count=f.actions.length;
  const result=f.service.acknowledgeClosed(original.id);
  expect(f.actions).toHaveLength(count);expect(result.phase).toBe('active');
  expect(result.targets).toHaveLength(1);expect(result.targets[0]?.connectionChanged).toBe(false);
  expect(()=>f.service.acknowledgeClosed(original.id)).toThrow('待核对');
  await f.service.stop();expect(f.service.status().targets).toEqual([]);
});
it('切换连接先停止输出，直至切换结束拒绝新试听；停止失败保留记录并解除切换锁',async()=>{
  const f=fixture();await f.service.play(request(1));
  const release=await f.service.beforeConnectionChange();
  expect(f.actions.at(-1)?.action.action).toBe('off');
  await expect(f.service.play(request(2,1))).rejects.toThrow('切换连接');
  release();await f.service.play(request(2,1));
  const send=f.api.playCue;
  f.api.playCue=()=>Promise.reject(new Error('网络已断开'));
  await expect(f.service.beforeConnectionChange()).rejects.toThrow('停止试听未完成');
  expect(f.service.status().targets).toHaveLength(1);
  f.api.playCue=send;await f.service.play(request(3,2));
  expect(f.service.status().targets).toHaveLength(2);
});
it('Off 永不回包时按超时标记失败，停止状态一定结束，可再次停止',async()=>{
  vi.useFakeTimers();
  try{
    const f=fixture();await f.service.play(request(1));
    f.api.playCue=()=>new Promise<void>(()=>undefined);
    const stop=f.service.stop();
    await vi.advanceTimersByTimeAsync(10000);
    const result=await stop;
    expect(result.phase).toBe('failed');expect(f.service.status().phase).toBe('failed');
    expect(result.targets[0]?.error).toContain('未确认关闭');
  }finally{vi.useRealTimers();}
});
it('状态发布失败不会把试听卡在停止中',async()=>{
  let closed=true;
  const f=fixture();
  const service=new Ma2AuditionService(f.api,state=>{if(closed&&state.phase==='stopping')throw new Error('窗口已关闭');});
  await service.play(request(1));
  await expect(Promise.resolve().then(()=>service.stop())).rejects.toThrow('窗口已关闭');
  expect(service.status().phase).toBe('failed');expect(service.status().targets).toHaveLength(1);
  closed=false;
  const retry=await service.stop();expect(retry.phase).toBe('sent');expect(retry.targets).toEqual([]);
});
