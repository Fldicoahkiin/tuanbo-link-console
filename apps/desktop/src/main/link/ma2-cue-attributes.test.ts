import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { inspectMa2CueAttributes, inspectMa2LayoutXml } from './ma2-timecode-xml';
import { readMa2EffectLibrary } from './ma2-effect-library';
import { ma2CueAttributeState } from '@tb/core/link';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
const cue = readFileSync(new URL('./fixtures/ma2-cue-attributes-3.7.xml',import.meta.url),'utf8');
const layout = readFileSync(new URL('./fixtures/ma2-layout-sequence-3.7.xml',import.meta.url),'utf8');
const directory={show:'test',generation:'g',version:'3.7.0.5',entries:[{target:9918,name:'test'}]};
const readAt='2026-10-17T12:00:00.000Z';
it('uses native CueData attribute names and native Layout coordinates',()=>{
  const details=inspectMa2CueAttributes(cue,readAt);
  expect(details).toHaveLength(1);expect(details[0]).toMatchObject({sequence:9918,cueIndex:1,attributes:['COLOR1','DIM','PAN','TILT'],fixtureIds:Array.from({length:25},(_,i)=>i+1),unknownChannels:0});
  expect(inspectMa2LayoutXml(layout,9918)).toMatchObject({layout:9918,items:[{sequence:9918,x:5,y:2,width:1,height:1,kind:'sequence',reference:['25','1','9918']}]});
  expect(()=>inspectMa2LayoutXml(layout,12)).toThrow('不一致');
  expect(details[0]?.content).toMatchObject({ state: 'complete', parts: [0] });
  expect(details[0]?.content?.rows[0]).toMatchObject({ attribute: 'DIM', fixtureId: 1, valuePart: 0, layers: [{ path: 'Value', value: '70' }] });
});
it('does not infer a missing attribute and preserves unknown channel information',()=>{
  const missing=cue.replaceAll('attribute_name="DIM"','attribute_name="CUSTOM_FADER"').replace('attribute_name="PAN"','');
  const result=inspectMa2CueAttributes(missing,readAt)[0]!;
  expect(result.attributes).toContain('CUSTOM_FADER');expect(result.attributes).not.toContain('DIM');expect(result.unknownChannels).toBe(1);
});
it('propagates failed native double-export verification without retrying or merging the sequence',async()=>{
  const request=vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockRejectedValueOnce(new Error('Sequence changed during read')).mockResolvedValueOnce(JSON.stringify(directory));
  const connection={command:vi.fn<Ma2Telnet['command']>().mockResolvedValue('ok')};
  const result=await readMa2EffectLibrary({request},()=>false,undefined,undefined,[9918],{show:directory.show,generation:directory.generation,version:directory.version},'attributes',connection);
  expect(result.cueAttributes).toEqual([]);expect(result.sequences).toEqual([]);expect(result.errors[0]?.message).toContain('Sequence changed');
  expect(request.mock.calls.filter(([operation])=>operation==='SEQUENCE')).toHaveLength(1);
});
it('transfers each verified native snapshot once while checking both directory and attribute-tree boundaries',async()=>{
  const request=vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(cue).mockResolvedValueOnce(JSON.stringify(directory));
  const connection={command:vi.fn<Ma2Telnet['command']>().mockResolvedValue('ok')};
  const result=await readMa2EffectLibrary({request},()=>false,undefined,undefined,[9918],undefined,'attributes',connection);
  expect(result.errors).toEqual([]);expect(result.sequences).toHaveLength(1);
  expect(request.mock.calls.filter(([operation])=>operation==='SEQUENCE')).toHaveLength(1);
  expect(connection.command).toHaveBeenCalledTimes(2);
});
it('preserves Part, preset and effect layers instead of returning a name-only summary', () => {
  const xml = cue.replace('value_multipart_index="0" effect_multipart_index="0"', 'value_multipart_index="2" effect_multipart_index="3"').replace('<Value>70</Value>', '<Preset name="Face"><No>1</No><No>2</No></Preset><Effect><Speed>30</Speed></Effect>');
  const details = inspectMa2CueAttributes(xml, readAt)[0]!;
  expect(details.content?.parts).toEqual([0, 2, 3]);
  expect(details.hasEffects).toBe(true);
  expect(details.content?.rows[0]?.layers).toEqual(expect.arrayContaining([{ path: 'Preset', value: '', properties: { name: 'Face' } }, { path: 'Preset/No', value: '2', properties: {} }, { path: 'Effect/Speed', value: '30', properties: {} }]));
});
it('distinguishes missing payload, explicit empty data, commands and possible tracking', () => {
  const missing = cue.replace(/<CueDatas>[\s\S]*?<\/CueDatas>/, '');
  expect(inspectMa2CueAttributes(missing, readAt)[0]?.content).toMatchObject({ state: 'partial', rows: [] });
  const empty = cue.replace(/<CueDatas>[\s\S]*?<\/CueDatas>/, '<CueDatas/>');
  expect(inspectMa2CueAttributes(empty, readAt)[0]?.content).toMatchObject({ state: 'complete', rows: [], tracking: 'none' });
  const command = empty.replace('<CuePart index="0">', '<CuePart index="0" command="Go Macro 1">');
  expect(inspectMa2CueAttributes(command, readAt)[0]?.content?.hasCommands).toBe(true);
  const tracked = cue.replace('</Sequ>', '<Cue index="2"><Number number="2" sub_number="0"/><CueDatas/><CuePart index="0"/></Cue></Sequ>');
  expect(inspectMa2CueAttributes(tracked, readAt)[1]?.content).toMatchObject({ state: 'complete', rows: [], tracking: 'possible' });
});
it('requires a full native export and checks wrap tracking and playback settings before declaring empty', () => {
  const native = readFileSync(new URL('./fixtures/ma2-empty-cue-3.7.xml', import.meta.url), 'utf8');
  expect(ma2CueAttributeState(inspectMa2CueAttributes(native, readAt)[0])).toBe('partial');
  expect(ma2CueAttributeState(inspectMa2CueAttributes(native, readAt, true)[0])).toBe('empty');
  const follow = native.replace('<Cue index="1">', '<Cue index="1" trig="follow" trig_time="2">');
  expect(ma2CueAttributeState(inspectMa2CueAttributes(follow, readAt, true)[0])).toBe('commands');
  const timed = native.replace('<PresetTiming />', '<PresetTiming fade="3" />');
  expect(ma2CueAttributeState(inspectMa2CueAttributes(timed, readAt, true)[0])).toBe('commands');
  const wrap = native.replace('</Sequ>', '<Cue index="2"><Number number="2"/><CueDatas><CueData><Channel fixture_id="1" attribute_name="DIM"/><Value>80</Value></CueData></CueDatas></Cue></Sequ>');
  expect(ma2CueAttributeState(inspectMa2CueAttributes(wrap, readAt, true)[0])).toBe('tracking');
});
