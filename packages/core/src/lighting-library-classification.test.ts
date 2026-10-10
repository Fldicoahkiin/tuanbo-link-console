import { expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, serializeLinkProject } from '@tb/schema';
import { classifyConsoleCuesCommand, hideConsoleCuesCommand, renameConsoleCueCommand, renameLightingLibraryEntryCommand } from './lighting-library-classification';
import { projectLightingLibrary } from './lighting-library';
import { saveMa2MaterialLibraryCommand } from './ma2-program-import';

const source={endpoint:'192.0.2.1:30000',show:'验收 Show'};
const refs=[{sequence:2,cue:'1.100',kind:'single' as const},{sequence:2,cue:'7.250',kind:'single' as const}];
function fixture(){return saveMa2MaterialLibraryCommand(source.endpoint,{
  directory:{show:source.show,generation:'one',version:'3.7.0.5',entries:[]},readAt:new Date().toISOString(),fixtureUsage:[],errors:[],
  sequences:[{sequence:2,name:'原序列',cues:[{index:0,number:'1.100',name:'控台原名暖白'},{index:1,number:'7.250',name:'重击'}]}]
}).execute(createEmptyLinkProject('右键分类'));}
it('右键批量归类保留原名和小数编号；多分类不复制，整笔撤销并能保存重开',()=>{
  const base=fixture();const command=classifyConsoleCuesCommand([...refs,refs[0]!],'front:bright:3:front',source);
  const changed=command.execute(base);expect(changed.ma2MaterialLibrary?.library).toEqual(base.ma2MaterialLibrary?.library);
  expect(projectLightingLibrary(changed).entries.map(entry=>[entry.name,entry.track.cueStamp])).toEqual([
    ['控台原名暖白',{mode:'fixed',sequence:2,cue:'1.100',executor:''}],['重击',{mode:'fixed',sequence:2,cue:'7.250',executor:''}]
  ]);
  const twice=classifyConsoleCuesCommand(refs,'effect:music:0',source).execute(changed);
  const restored=parseLinkProject(JSON.parse(serializeLinkProject(twice)));
  expect(projectLightingLibrary(restored).entries).toHaveLength(2);
  expect(projectLightingLibrary(restored).entries[0]?.categoryIds).toEqual(['front:bright:3:front','effect:music:0']);
  expect(command.undo(base)).toBe(base);expect(base.ma2MaterialLibrary?.userLibrary).toBeUndefined();
});
it('删除只隐藏软件素材，原始控台目录、已分类条目保留；来源隔离且可恢复',()=>{
  const base=classifyConsoleCuesCommand(refs,'rim:7:back',source).execute(fixture());
  const command=hideConsoleCuesCommand(refs,source,true);const removed=command.execute(base);
  expect(removed.ma2MaterialLibrary?.library).toEqual(base.ma2MaterialLibrary?.library);
  expect(projectLightingLibrary(removed).entries).toEqual(projectLightingLibrary(base).entries);
  const reopened=parseLinkProject(JSON.parse(serializeLinkProject(removed)));
  expect(projectLightingLibrary(reopened).hiddenConsoleCues).toHaveLength(2);
  expect(projectLightingLibrary(hideConsoleCuesCommand(refs,source,false).execute(reopened)).hiddenConsoleCues).toEqual([]);
  expect(command.undo(base)).toBe(base);
  expect(()=>classifyConsoleCuesCommand(refs,'rim:7:back',{...source,show:'其他 Show'}).execute(base)).toThrow('目录已变化');
  expect(()=>classifyConsoleCuesCommand([{...refs[0]!,cue:'不存在'}],'rim:7:back',source).execute(base)).toThrow('当前读取目录');
  expect(()=>classifyConsoleCuesCommand(refs,'不存在',source).execute(base)).toThrow('分类已移除');
});
it('重命名未分类 Cue 后归类、重读及保存保留名称，原名和执行版本不变',()=>{
  const base=fixture(), command=renameConsoleCueCommand(refs[0]!, '  暖白面光  ',source);
  const renamed=command.execute(base);
  const entry=projectLightingLibrary(renamed).entries[0]!;
  expect(entry).toMatchObject({name:'暖白面光',originalName:'控台原名暖白',categoryIds:[],revision:1});
  expect(renamed.ma2MaterialLibrary?.library).toEqual(base.ma2MaterialLibrary?.library);
  expect(renamed.rundown).toEqual(base.rundown);
  const classified=classifyConsoleCuesCommand([refs[0]!],'rim:7:back',source).execute(renamed);
  expect(projectLightingLibrary(classified).entries).toHaveLength(1);
  const changed=renameLightingLibraryEntryCommand(entry.id,'轮廓暖白').execute(classified);
  const restored=parseLinkProject(JSON.parse(serializeLinkProject(changed)));
  expect(projectLightingLibrary(restored).entries[0]).toMatchObject({name:'轮廓暖白',originalName:'控台原名暖白',categoryIds:['rim:7:back'],revision:1,track:{name:'轮廓暖白',cueStamp:{sequence:2,cue:'1.100',executor:''}}});
  expect(command.undo(base)).toBe(base);
  expect(()=>renameConsoleCueCommand(refs[0]!,' ',source).execute(base)).toThrow();
  expect(()=>renameConsoleCueCommand(refs[0]!,'新名',{...source,show:'不同 Show'}).execute(base)).toThrow('目录已变化');
});
