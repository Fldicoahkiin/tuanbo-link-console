import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Ma2LayoutService } from './ma2-layout-service';
import type { Ma2NewCueRequest, Ma2SongSyncRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { emptyMa2SequenceXml, inspectMa2CueData, inspectMa2SequenceXml, emptyMa2LayoutXml, inspectMa2LayoutXml } from './ma2-timecode-xml';

const source={show:'test',generation:'one',version:'3.7.0.5'};
function request():Ma2NewCueRequest{return {network:{host:'192.0.2.1',port:30000,monitorPort:30001,username:'test'},expectedSource:source,projectId:randomUUID(),requestId:randomUUID(),settings:{layout:999,name:'专用布局',nextSequence:9000,columns:8},name:'位置',content:{kind:'programmer',use:'Active'}};}
it('rejects an occupied Sequence and changed Show before sending any native command',async()=>{
  const command=vi.fn<Ma2Telnet['command']>();
  const bridge={request:vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify({...source,entries:[{target:9000,name:'用户已有灯光'}]}))};
  const service=new Ma2LayoutService('unused.json',()=>false);
  await expect(service.create({command},bridge,request())).rejects.toThrow('已占用');expect(command).not.toHaveBeenCalled();
  bridge.request.mockResolvedValue(JSON.stringify({...source,show:'different',entries:[]}));
  await expect(service.create({command},bridge,request())).rejects.toThrow('Show');expect(command).not.toHaveBeenCalled();
});
it('blocks active playback and invalid payloads without network work',async()=>{
  const command=vi.fn<Ma2Telnet['command']>(),bridge={request:vi.fn<Ma2OnpcBridge['request']>()};
  await expect(new Ma2LayoutService('unused.json',()=>true).create({command},bridge,request())).rejects.toThrow('停止播放');
  await expect(new Ma2LayoutService('unused.json',()=>false).create({command},bridge,{...request(),name:'invalid";Delete Sequence 1'})).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();expect(bridge.request).not.toHaveBeenCalled();
});
it('empty destinations carry no Programmer values or selected fixtures',()=>{
  const xml=emptyMa2SequenceXml(9000,'3.7.0.5');expect(inspectMa2SequenceXml(xml).sequences[0]?.number).toBe(9000);expect(inspectMa2CueData(xml,1).size).toBe(0);
  expect(inspectMa2LayoutXml(emptyMa2LayoutXml(999,'3.7.0.5'),999)).toMatchObject({items:[],omittedFixtures:0});
});
it('rejects a full song executor page before importing or renaming any Sequence', async () => {
  const base = request();
  const song: Ma2SongSyncRequest = { network: base.network, expectedSource: source, projectId: base.projectId, itemId: 'song', requestId: base.requestId, settings: { ...base.settings, executorPage: 1000 }, name: '歌曲', points: [{ id: 'cue', name: '起点', atMs: 0, cues: [] }] };
  const full = `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="3" minor_vers="7" stream_vers="0" tblink_show="test" tblink_generation="one" tblink_version="3.7.0.5"><Page index="999">${'<Exec xsi:nil="true"/>'.repeat(100)}${'<Exec offset_from_first="0"><Assignment><No>25</No><No>1</No><No>1</No></Assignment></Exec>'.repeat(90)}</Page></MA>`;
  const command = vi.fn<Ma2Telnet['command']>();
  const bridge = { request: vi.fn<Ma2OnpcBridge['request']>().mockImplementation(op => {
    if (op === 'LISTSEQ') return Promise.resolve(JSON.stringify({ ...source, entries: [] }));
    if (op === 'PAGES') return Promise.resolve(JSON.stringify({ ...source, buttonPage: 1000, faderPage: 1, pages: [{ page: 1000, name: '已有灯光' }] }));
    if (op === 'PAGE') return Promise.resolve(full);
    throw new Error(`Unexpected ${op}`);
  }) };
  await expect(new Ma2LayoutService(`unused-${randomUUID()}.json`, () => false).syncSong({ command }, bridge, song)).rejects.toThrow('已经放满');
  expect(command).not.toHaveBeenCalled();
  expect(bridge.request.mock.calls.map(([op]) => op)).toEqual(['LISTSEQ', 'PAGES', 'PAGE']);
});
