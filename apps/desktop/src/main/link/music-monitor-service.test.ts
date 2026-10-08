import { basename } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MusicMonitorRequest, NativePlaybackCommand } from '@tb/schema';
import { MusicMonitorService } from './music-monitor-service';

const state=vi.hoisted(()=>({commands:[] as NativePlaybackCommand[],gate:Promise.resolve(),closed:vi.fn(),released:vi.fn()}));
vi.mock('node:fs/promises',()=>({mkdir:()=>Promise.resolve()}));
vi.mock('./native-playback-client',()=>({readNativePlaybackDevices:()=>Promise.resolve({audio:[{id:'headphones',name:'监听',isDefault:false}],midi:[]}),NativePlaybackClient:class {
  identity={pid:123,title:'unique-monitor',windowClass:'native'};
  start(){return Promise.resolve();} close(){state.closed();return Promise.resolve();}
  async command(command:NativePlaybackCommand){state.commands.push(command);await state.gate;}
}}));
vi.mock('./native-audio-cache',()=>({NativeAudioCache:class {prepare(){return Promise.resolve({path:'monitor.pcm',baseMs:0,streaming:true,release:()=>{state.released();return Promise.resolve();}});}}}));
beforeEach(()=>{state.commands=[];state.gate=Promise.resolve();state.closed.mockClear();state.released.mockClear();});
const request:MusicMonitorRequest={version:1,sessionId:crypto.randomUUID(),projectPath:'D:/test/show.tblink',deviceId:'headphones',volume:.2,mode:'segment',source:{assetId:'audio',relativePath:'audio.wav',sha256:'a'.repeat(64),durationMs:10000},startMs:2000,endMs:6000,firstBeatMs:0,tempos:[{beat:0,bpm:128,numerator:4,denominator:4}]};
function setup(){const unsubscribe=vi.fn();const changed=vi.fn();const report=vi.fn();let routeChanged:()=>void=()=>{throw new Error('尚未监听线路');};
  const obs={assertMusicMonitorIsolation:vi.fn(()=>Promise.resolve()),subscribeMusicMonitorRouteChange:(callback:()=>void)=>{routeChanged=callback;return unsubscribe;}};
  return {service:new MusicMonitorService('D:/native.exe',{resolveReferenceAudio:()=> 'audio.wav'},obs,report,changed),obs,report,changed,unsubscribe,changeRoute:()=>routeChanged()};
}
it('隔离校验通过后使用独立设备，始终禁用 MIDI；线路变化立即释放监听',async()=>{
  const test=setup();await test.service.start(request);
  expect(test.obs.assertMusicMonitorIsolation).toHaveBeenCalledWith('headphones',false,{executable:'native.exe',title:'unique-monitor',windowClass:'native',ownerExecutable:basename(process.execPath)});
  expect(state.commands[0]).toMatchObject({kind:'prepare',midiDevice:null,audioDeviceId:'headphones',startMs:2000,endMs:6000,offsetMs:0});expect(state.commands[1]?.kind).toBe('play');
  test.changeRoute();await test.service.stop();expect(test.report).toHaveBeenCalledTimes(1);expect(state.closed).toHaveBeenCalledTimes(1);expect(state.released).toHaveBeenCalledTimes(1);expect(test.unsubscribe).toHaveBeenCalledTimes(1);
});
it('隔离不明时不准备或播放，不偷偷改用默认设备',async()=>{
  const test=setup();test.obs.assertMusicMonitorIsolation.mockRejectedValueOnce(new Error('正式混音包含监听'));
  await expect(test.service.start(request)).rejects.toThrow('正式混音');expect(state.commands).toEqual([]);expect(state.closed).toHaveBeenCalledTimes(1);
  await expect(test.service.start({...request,deviceId:'missing'})).rejects.toThrow('已断开');expect(state.commands).toEqual([]);
});
it('停止作废迟到的准备确认，不再次发送 play，也不把迟到结果显示为监听中',async()=>{
  const test=setup();let release:()=>void=()=>{throw new Error('未建立测试门');};state.gate=new Promise<void>(resolve=>{release=resolve;});
  const started=expect(test.service.start(request)).rejects.toThrow('取消');
  await vi.waitFor(()=>expect(state.commands).toHaveLength(1));await test.service.stop();release();await started;
  expect(state.commands.map(command=>command.kind)).toEqual(['prepare']);expect(test.changed.mock.calls.some(([status])=>status.state==='playing')).toBe(false);
});
