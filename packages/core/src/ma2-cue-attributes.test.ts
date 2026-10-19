import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, serializeLinkProject, type Ma2EffectLibrary } from '@tb/schema';
import { classifyMa2Attributes, editLightingCategoryCommand, mergeMa2AttributesCommand, mergeMa2MetadataCommand } from './ma2-cue-attributes';
import { saveMa2MaterialLibraryCommand } from './ma2-program-import';
import { projectLightingLibrary } from './lighting-library';
import { updateConsoleCueCategoriesCommand } from './lighting-library-classification';
const group=(attribute:string,presetType:string,feature=presetType)=>({attribute,attributeName:attribute,presetType,presetName:presetType,feature,featureName:feature});
const source='192.0.2.1:30000';
function fixture(): Ma2EffectLibrary { return {directory:{show:'test',generation:'g',version:'3.7.0.5',entries:[{target:1,name:'位置'},{target:2,name:'颜色'}]},readAt:new Date().toISOString(),sequences:[{sequence:1,name:'位置',cues:[{index:1,number:'1.000',name:null}]},{sequence:2,name:'颜色',cues:[{index:1,number:'1.000',name:'红色'}]}],fixtureUsage:[],errors:[],cueAttributes:[{sequence:1,cueIndex:1,attributes:['PAN','TILT'],groups:[group('PAN','POSITION'),group('TILT','POSITION')],fixtureIds:[1],hasEffects:false,unknownChannels:0,content:{state:'complete',issues:[],parts:[0],hasCommands:false,tracking:'none',rows:[]},readAt:new Date().toISOString()}]}; }
it('页面名称回读独立于属性完整性，历史中无素材库的工程不被污染', () => {
  const original = fixture(); const project = saveMa2MaterialLibraryCommand(source, original).execute(createEmptyLinkProject('test'));
  const incoming = { ...original, sequences: [{ ...original.sequences[0]!, name: '控台新名', cues: [{ index: 1, number: '1.000', name: '准确名称' }] }], cueAttributes: [] };
  const command = mergeMa2MetadataCommand(source, incoming);
  const next = command.execute(project);
  expect(next.ma2MaterialLibrary?.library?.sequences.find(sequence => sequence.sequence === 1)?.cues[0]?.name).toBe('准确名称');
  expect(next.ma2MaterialLibrary?.library?.cueAttributes).toEqual(original.cueAttributes);
  const old = createEmptyLinkProject('旧历史'); expect(command.rebaseHistory!(old)).toBe(old);
  const partial = mergeMa2AttributesCommand(source, incoming, [1], false).execute(project);
  expect(partial.ma2MaterialLibrary?.library?.sequences.find(sequence => sequence.sequence === 1)?.name).toBe('控台新名');
  expect(partial.ma2MaterialLibrary?.library?.errors).toEqual(expect.arrayContaining([expect.objectContaining({ sequence: 1 })]));
});
it('classifies explicit attributes, retains unknowns and never derives brightness from other attributes',()=>{
  expect(classifyMa2Attributes({attributes:['PAN','TILT','COLORRGB1','CUSTOM'],groups:[group('PAN','POSITION'),group('TILT','POSITION'),group('COLORRGB1','COLOR')],hasEffects:false})).toEqual({roles:['position','color','unresolved'],unknown:['CUSTOM']});
  expect(classifyMa2Attributes({attributes:[],hasEffects:false}).roles).toEqual(['unresolved']);
  expect(classifyMa2Attributes({attributes:['DIM'],groups:[group('DIM','DIMMER')],hasEffects:true}).roles).toEqual(['intensity','effect']);
});
it('merges a target without dropping unrelated cues; automatic classification preserves manual categories and saves',()=>{
  const read=fixture();let project=saveMa2MaterialLibraryCommand(source,read).execute(createEmptyLinkProject('test'));
  const input={...read,sequences:read.sequences.slice(0,1)};
  const cmd=mergeMa2AttributesCommand(source,input,[1],true);project=cmd.execute(project);
  expect(project.ma2MaterialLibrary?.library?.sequences).toHaveLength(2);
  let entry=projectLightingLibrary(project).entries[0]!;expect(entry.name).toBe('位置');expect(entry.categoryIds).toEqual(['attribute:position']);
  project=editLightingCategoryCommand('custom-test','搭配').execute(project);
  project=updateConsoleCueCategoriesCommand([{sequence:1,cue:'1.000',kind:'single'}],{add:['custom-test'],remove:[]},{endpoint:source,show:'test'}).execute(project);
  const second={...input,cueAttributes:input.cueAttributes!.map(value=>({...value,attributes:['COLOR1'],groups:[group('COLOR1','COLOR')]}))};
  project=mergeMa2AttributesCommand(source,second,[1],true).execute(project);
  entry=projectLightingLibrary(parseLinkProject(JSON.parse(serializeLinkProject(project)))).entries[0]!;
  expect(entry.categoryIds).toEqual(['custom-test','attribute:color']);expect(entry.autoCategoryIds).toEqual(['attribute:color']);
  const deleted=editLightingCategoryCommand('custom-test',null).execute(project);
  expect(projectLightingLibrary(deleted).entries[0]?.categoryIds).toEqual(['attribute:color']);expect(deleted.ma2MaterialLibrary?.library).toEqual(project.ma2MaterialLibrary?.library);
  expect(()=>mergeMa2AttributesCommand('other',input,[1],true).execute(project)).toThrow('Show');
});

it('uses console hierarchy for custom names and moved attributes, with complete nine-type coverage',()=>{
  const presets=['DIMMER','POSITION','GOBO','COLOR','BEAM','FOCUS','CONTROL','SHAPERS','VIDEO'];
  const groups=presets.map((preset,i)=>group(`CUSTOM_${i}`,preset));
  expect(classifyMa2Attributes({attributes:groups.map(g=>g.attribute),groups,hasEffects:false}).roles).toEqual(['intensity','position','gobo','color','beam','focus','control','shapers','video']);
  expect(classifyMa2Attributes({attributes:['PAN'],groups:[group('PAN','CONTROL')],hasEffects:false}).roles).toEqual(['control']);
  expect(classifyMa2Attributes({attributes:['PAN'],hasEffects:false})).toEqual({roles:['unresolved'],unknown:['PAN']});
  expect(classifyMa2Attributes({attributes:['X'],groups:[group('X','CUSTOM')],hasEffects:false})).toEqual({roles:['other'],unknown:[]});
  expect(classifyMa2Attributes({attributes:['SHUTTER'],groups:[group('SHUTTER','BEAM','SHUTTER')],hasEffects:true}).roles).toEqual(['beam','shutter','effect']);
});
it('retains custom console categories and explicit review buckets after save and reread',()=>{
  const read=fixture();read.cueAttributes![0]={...read.cueAttributes![0]!,attributes:['SPECIAL'],groups:[group('SPECIAL','MY_PRESET')]};
  const before=saveMa2MaterialLibraryCommand(source,read).execute(createEmptyLinkProject('test'));
  const next=mergeMa2AttributesCommand(source,read,[1,2],true).execute(before);
  const library=projectLightingLibrary(parseLinkProject(JSON.parse(serializeLinkProject(next))));
  expect(library.categories).toContainEqual(expect.objectContaining({id:'attribute:preset:MY_PRESET',name:'MY_PRESET'}));
  expect(library.entries[0]?.categoryIds).toEqual(['attribute:other','attribute:preset:MY_PRESET']);
});
it('keeps cached data and manual/automatic classifications when reread fails or is partial', () => {
  const read = fixture();
  let project = saveMa2MaterialLibraryCommand(source, read).execute(createEmptyLinkProject('test'));
  project = mergeMa2AttributesCommand(source, { ...read, sequences: read.sequences.slice(0, 1) }, [1], true).execute(project);
  const before = projectLightingLibrary(project).entries;
  for (const result of [
    { ...read, sequences: [], cueAttributes: [], errors: [{ sequence: 1, message: 'timeout' }] },
    { ...read, sequences: read.sequences.slice(0, 1), cueAttributes: read.cueAttributes!.map(value => ({ ...value, content: { ...value.content!, state: 'partial' as const, issues: ['missing data'] } })) }
  ]) {
    const after = mergeMa2AttributesCommand(source, result, [1], true).execute(project);
    expect(after.ma2MaterialLibrary?.library?.cueAttributes).toEqual(project.ma2MaterialLibrary?.library?.cueAttributes);
    expect(projectLightingLibrary(after).entries).toEqual(before);
    expect(after.ma2MaterialLibrary?.library?.errors).toHaveLength(1);
  }
});
