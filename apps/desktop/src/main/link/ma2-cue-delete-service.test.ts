import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, type Ma2CueDeletePrepare } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { runMa2GuardedLua } from './ma2-lua-command';
import { Ma2CueDeleteService } from './ma2-cue-delete-service';

vi.mock('./ma2-lua-command', () => ({ ma2LuaString: (value: string) => JSON.stringify(value), runMa2GuardedLua: vi.fn() }));
const source = { show: 'fixture', generation: 'g', version: '3.7.0.5' };
const body = '<Cue index="1"><Number number="1" sub_number="0"/><CueDatas/><CuePart index="0"/></Cue><Cue index="2"><Number number="2" sub_number="0"/><CueDatas/><CuePart index="0"/></Cue>';
const xml = (content = body): string => `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Sequ index="0">${content}</Sequ></MA>`;
async function setup() {
  let current = xml(); let playing = false;
  const project = createEmptyLinkProject('test'); project.schemaVersion = 2;
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { ...source, entries: [{ target: 1, name: 'empty' }] }, readAt: new Date().toISOString(), sequences: [], errors: [], fixtureUsage: [] } };
  const input: Ma2CueDeletePrepare = { network: { host:'192.0.2.1',port:30000,monitorPort:30001,username:'test' }, expectedSource:source, projectId:project.projectId, projectPath:'fixture.tblink', refs:[{sequence:1,cue:'1.000'}] };
  const request = vi.fn<Ma2OnpcBridge['request']>((op) => Promise.resolve(op === 'SEQUENCE' ? current : JSON.stringify({ ...source, entries: op === 'LIST' ? [] : [{target:1,name:'empty'}] })));
  const service = new Ma2CueDeleteService(await mkdtemp(join(tmpdir(),'tblink-delete-test-')), () => Promise.resolve(project), () => playing);
  vi.mocked(runMa2GuardedLua).mockReset();
  return { service, input, bridge:{request}, connection:{command:vi.fn<Ma2Telnet['command']>()}, setXml:(value:string)=>{current=value;}, play:()=>{playing=true;} };
}
it('prepares a fresh review list without deleting anything; consumes confirmation once', async () => {
  const f = await setup(); const plan = await f.service.prepare(f.bridge,f.input);
  expect(plan.items[0]).toMatchObject({sequence:1,cue:'1.000',eligible:true}); expect(runMa2GuardedLua).not.toHaveBeenCalled();
  vi.mocked(runMa2GuardedLua).mockImplementation((_connection,script,guard) => { guard(); expect(script).toContain('Sequence changed after confirmation'); expect(script).toContain('Delete Sequence 1 Cue 1.000 /cueonly /nc'); f.setXml(xml(body.replace(/<Cue index="1">[\s\S]*?<\/Cue>/,''))); return Promise.resolve('deleted'); });
  const context = { network:f.input.network, expectedSource:f.input.expectedSource, projectId:f.input.projectId, projectPath:f.input.projectPath };
  const result = await f.service.commit(f.connection,f.bridge,{...context,token:plan.token});
  expect(result.error).toBeUndefined(); expect(result.deleted).toEqual([{sequence:1,cue:'1.000'}]); expect(result.backups).toHaveLength(2);
  expect(result.library?.sequences[0]?.cues).toHaveLength(1);
  await expect(f.service.commit(f.connection,f.bridge,{...context,token:plan.token})).rejects.toThrow('失效');
});
it('refuses changed data or playback before any destructive command', async () => {
  const f = await setup(); const plan = await f.service.prepare(f.bridge,f.input);
  f.setXml(xml(body.replace('<CueDatas/>','<CueDatas><CueData><Channel fixture_id="1" attribute_name="DIM"/><Value>80</Value></CueData></CueDatas>')));
  const context = { network:f.input.network, expectedSource:f.input.expectedSource, projectId:f.input.projectId, projectPath:f.input.projectPath };
  const result = await f.service.commit(f.connection,f.bridge,{...context,token:plan.token});
  expect(result.deleted).toEqual([]); expect(result.error).toContain('变化'); expect(runMa2GuardedLua).not.toHaveBeenCalled();
  f.play(); await expect(f.service.prepare(f.bridge,f.input)).rejects.toThrow('停止播放');
});
it('excludes commands, inherited-only steps and partial payloads from the deletion list', async () => {
  const f = await setup();
  f.setXml(xml(body.replace('index="0"/>','index="0" command="Go Macro 1"/>')));
  expect((await f.service.prepare(f.bridge,f.input)).items[0]?.eligible).toBe(false);
  f.setXml(xml(body.replace('<CueDatas/>','<CueDatas><CueData><Channel fixture_id="1" attribute_name="DIM"/><Value>70</Value></CueData></CueDatas>')));
  expect((await f.service.prepare(f.bridge,{...f.input,refs:[{sequence:1,cue:'2.000'}]})).items[0]?.eligible).toBe(false);
  f.setXml(xml(body.replace('<CueDatas/>','<UnrecognizedData/>')));
  expect((await f.service.prepare(f.bridge,f.input)).items[0]?.eligible).toBe(false);
  expect(runMa2GuardedLua).not.toHaveBeenCalled();
});
it('stops on uncertain deletion and reports backups without replaying a command', async () => {
  const f = await setup(); const plan = await f.service.prepare(f.bridge,f.input);
  vi.mocked(runMa2GuardedLua).mockRejectedValue(new Error('response timeout'));
  const context = { network:f.input.network, expectedSource:f.input.expectedSource, projectId:f.input.projectId, projectPath:f.input.projectPath };
  const result = await f.service.commit(f.connection,f.bridge,{...context,token:plan.token});
  expect(result.error).toContain('可能已部分删除'); expect(result.backups).toHaveLength(2); expect(runMa2GuardedLua).toHaveBeenCalledTimes(1);
});
