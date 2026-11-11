import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { holdForShow, isShowWait, ma2CueAttributeState, ma2CueDeletionUsage, type ShowGateReader } from '@tb/core/link';
import { ma2CueDeletePrepareSchema, ma2CueDeleteCommitSchema, ma2CueDeletePlanSchema, ma2CueDeleteResultSchema, ma2ObjectDirectorySchema, type LinkProject, type Ma2CueDeletePrepare, type Ma2CueDeleteCommit, type Ma2CueDeletePlan, type Ma2CueDeleteResult, type Ma2ReadProgressUpdate } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { inspectMa2CueAttributes, inspectMa2CueFixtures, inspectMa2SequenceXml, ma2SequenceCueFingerprints, referencedMa2Sequences } from './ma2-timecode-xml';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';

type Bridge = Pick<Ma2OnpcBridge, 'request'>;
type Plan = { request: Ma2CueDeletePrepare; value: Ma2CueDeletePlan; snapshots: Map<number, string>; timecodes: Map<number, string> };
const canonical = (xml: string): string => xml.replace(/(<MA[^>]*>\s*)<Info[^>]*\/>/, '$1');
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class Ma2CueDeleteService {
  private busy = false;
  private readonly plans = new Map<string, Plan>();
  constructor(private readonly backupDirectory: string, private readonly loadProject: (path: string) => Promise<LinkProject>, private readonly show: ShowGateReader) {}
  /** Deleting Cues is changing the console: paused it runs, a moving program stops it before its next step (第 3 题). */
  private guard(): void { holdForShow(this.show, 'ma2.executor.mutate'); }
  private async project(request: Ma2CueDeletePrepare | Ma2CueDeleteCommit): Promise<LinkProject> {
    this.guard();
    const project = await this.loadProject(request.projectPath);
    const cache = project.ma2MaterialLibrary;
    if (project.projectId !== request.projectId || cache?.source !== `${request.network.host}:${request.network.port}` || !cache.library || cache.library.sourceUnverified || Object.entries(request.expectedSource).some(([key, value]) => Reflect.get(cache.library!.directory, key) !== value)) throw new Error('工程或控台来源已变化，请重新生成删除清单');
    return project;
  }
  private async directory(bridge: Bridge, request: Ma2CueDeletePrepare | Ma2CueDeleteCommit) {
    this.guard();
    const result = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
    if (Object.entries(request.expectedSource).some(([key,value]) => Reflect.get(result,key) !== value)) throw new Error('控台的 Show 或连接变了，删除已停止');
    return result;
  }
  async prepare(bridge: Bridge, input: Ma2CueDeletePrepare, report?: (value: Ma2ReadProgressUpdate) => void): Promise<Ma2CueDeletePlan> {
    const request = ma2CueDeletePrepareSchema.parse(input);
    if (this.busy) throw new Error('正在处理删除清单');
    this.busy = true;
    try {
      const project = await this.project(request); await this.directory(bridge, request);
      const refs = [...new Map(request.refs.map(ref => [`${ref.sequence}:${Number(ref.cue)}`, ref])).values()];
      const targets = [...new Set(refs.map(ref => ref.sequence))];
      const snapshots = new Map<number,string>(); const items: Ma2CueDeletePlan['items'] = [];
      for (const [index, sequence] of targets.entries()) {
        this.guard(); report?.({ phase: 'library', completed: index, total: targets.length + 1, detail: `检查空 Cue：序列 ${sequence}` });
        try {
          const xml = await bridge.request('SEQUENCE', sequence); snapshots.set(sequence, xml);
          const info = inspectMa2SequenceXml(xml).sequences.find(value => value.number === sequence);
          if (!info) throw new Error('序列来源不一致');
          const details = inspectMa2CueAttributes(xml, new Date().toISOString(), true);
          for (const ref of refs.filter(value => value.sequence === sequence)) {
            const cue = info.cues.find(value => Number(value.number) === Number(ref.cue));
            const data = details.find(value => value.cueIndex === cue?.index);
            const usage = ma2CueDeletionUsage(project, ref.sequence, ref.cue);
            const empty = ma2CueAttributeState(data) === 'empty';
            const reason = usage.join('；') || (!cue ? 'Cue 已不存在' : !empty ? '未完整确认为空：可能包含属性、命令或继承数据' : '已完整检查：这一步没有属性、效果或命令');
            items.push({ ...ref, cue: cue?.number ?? ref.cue, name: cue?.name || info.name || `Cue ${ref.cue}`, eligible: Boolean(cue && empty && !usage.length), reason });
          }
        } catch (error) {
          // The program started during this read (the bridge stops at a plugin step): the whole check waits.
          if (isShowWait(error)) throw error;
          for (const ref of refs.filter(value => value.sequence === sequence)) items.push({ ...ref, name: `Cue ${ref.cue}`, eligible: false, reason: message(error) });
        }
      }
      const timecodes = new Map<number,string>();
      const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
      if (Object.entries(request.expectedSource).some(([key,value]) => Reflect.get(directory,key) !== value)) throw new Error('Timecode 来源变化');
      for (const [index, entry] of directory.entries.entries()) {
        this.guard(); report?.({ phase: 'library', completed: targets.length + index, total: targets.length + directory.entries.length + 1, detail: `检查控台时间线引用：Timecode ${entry.target}` });
        const xml = await bridge.request('READ', entry.target); timecodes.set(entry.target, xml);
        const used = referencedMa2Sequences(xml);
        for (const item of items) if (used.includes(item.sequence)) { item.eligible = false; item.reason = `控台 Timecode ${entry.target} 使用此序列，删除会改变步骤引用`; }
      }
      await this.directory(bridge, request);
      const token = randomUUID(); const value = ma2CueDeletePlanSchema.parse({ token, expiresAt: new Date(Date.now() + 600000).toISOString(), items });
      for (const [id, saved] of this.plans) if (Date.parse(saved.value.expiresAt) < Date.now()) this.plans.delete(id);
      if (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value!);
      this.plans.set(token, { request, value, snapshots, timecodes });
      report?.({ phase: 'library', completed: 1, total: 1, detail: '删除清单检查完毕，请确认后再删除' });
      return value;
    } finally { this.busy = false; }
  }
  async commit(connection: Pick<Ma2Telnet,'command'>, bridge: Bridge, input: Ma2CueDeleteCommit, report?: (value: Ma2ReadProgressUpdate) => void): Promise<Ma2CueDeleteResult> {
    const request = ma2CueDeleteCommitSchema.parse(input);
    if (this.busy) throw new Error('正在处理删除请求');
    const plan = this.plans.get(request.token);
    if (!plan || Date.parse(plan.value.expiresAt) < Date.now() || ['projectId','projectPath','network','expectedSource'].some(key => JSON.stringify(Reflect.get(plan.request,key)) !== JSON.stringify(Reflect.get(request,key)))) throw new Error('删除清单已失效，请重新检查');
    this.plans.delete(request.token); this.busy = true;
    const deleted: Ma2CueDeleteResult['deleted'] = []; const backups: string[] = [];
    const snapshots = new Map<number,string>(); let attempted = false;
    let error: string | undefined;
    try {
      const project = await this.project(request); await this.directory(bridge, request);
      const eligible = plan.value.items.filter(item => item.eligible);
      if (!eligible.length) throw new Error('清单中没有可删除的空 Cue');
      for (const item of eligible) if (ma2CueDeletionUsage(project,item.sequence,item.cue).length) throw new Error('检查之后工程里又用到了这些 Cue，请重新检查');
      const timecodes = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST',1)));
      if (timecodes.entries.length !== plan.timecodes.size || timecodes.entries.some(entry => !plan.timecodes.has(entry.target))) throw new Error('控台的时间线有变化，请重新检查');
      for (const entry of timecodes.entries) if (canonical(await bridge.request('READ',entry.target)) !== canonical(plan.timecodes.get(entry.target)!)) throw new Error('控台时间线的内容有变化，请重新检查');
      const targets = [...new Set(eligible.map(item => item.sequence))];
      // Verify every target before the first mutation.
      for (const sequence of targets) {
        this.guard(); const xml = await bridge.request('SEQUENCE',sequence);
        if (canonical(xml) !== canonical(plan.snapshots.get(sequence)!)) throw new Error(`序列 ${sequence} 在检查之后有变化，没有删除`);
        snapshots.set(sequence,xml);
      }
      await mkdir(this.backupDirectory,{recursive:true});
      for (const [index,sequence] of targets.entries()) {
        this.guard(); await this.directory(bridge, request);
        const xml = snapshots.get(sequence)!;
        const selected = eligible.filter(item => item.sequence === sequence).sort((a,b) => Number(b.cue)-Number(a.cue));
        report?.({ phase:'library', completed:index, total:targets.length, detail:`备份并删除序列 ${sequence} 的 ${selected.length} 个空 Cue` });
        const file = `tblink_delete_${request.token.replaceAll('-','')}_${sequence}`;
        const localFile = join(this.backupDirectory, `${file}.xml`);
        await writeFile(localFile, xml, { encoding:'utf8', flag:'wx' }); backups.push(localFile, `控台 importexport/${file}.xml`);
        const before = ma2SequenceCueFingerprints(xml);
        const guard = `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(request.expectedSource.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(request.expectedSource.generation)},'Show or session changed');`;
        const body = `${guard}local expected=${ma2LuaString(canonical(xml))};gma.cmd('Export Sequence ${sequence} ${file} /o');local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','rb'));local actual=f:read('*a');f:close();actual=actual:gsub('(<MA[^>]*>%s*)<Info[^>]*/>','%1');assert(actual==expected,'Sequence changed after confirmation');${guard}${selected.map(item => `assert(gma.show.getobj.handle('Sequence ${sequence} Cue ${item.cue}'),'Cue missing');gma.cmd('Delete Sequence ${sequence} Cue ${item.cue} /cueonly /nc');assert(not gma.show.getobj.handle('Sequence ${sequence} Cue ${item.cue}'),'Cue deletion unconfirmed');`).join('')}return 'deleted'`;
        attempted = true;
        if (await runMa2GuardedLua(connection,body,() => this.guard()) !== 'deleted') throw new Error('控台没有确认删除');
        const directory = await this.directory(bridge,request);
        const remaining = new Map(before); for (const item of selected) remaining.delete(item.cue);
        if (!directory.entries.some(entry => entry.target === sequence)) {
          if (remaining.size) throw new Error('没选中的 Cue 在删除后不见了，请检查控台和备份');
          snapshots.delete(sequence);
        } else {
          const after = await bridge.request('SEQUENCE',sequence);
          const actual = ma2SequenceCueFingerprints(after);
          if (JSON.stringify([...remaining]) !== JSON.stringify([...actual])) throw new Error('删除后控台上的内容和清单对不上，请检查控台和备份');
          snapshots.set(sequence,after);
        }
        deleted.push(...selected.map(({sequence,cue}) => ({sequence,cue})));
        attempted = false;
      }
    } catch (cause) {
      const partly = attempted ? '这个序列可能已经删掉了一部分，请读取控台确认；' : '';
      // A wait keeps its opening first (isShowWait) and says how far the deletion got.
      error = isShowWait(cause) ? `${message(cause)}已删除 ${deleted.length} 个空 Cue。${partly}后面的没有删。` : `${partly}${message(cause)}。后续删除已停止，不会自动重试。`;
    }
    finally { this.busy = false; }
    let library: Ma2CueDeleteResult['library'];
    if (deleted.length) {
      try {
        const directory = await this.directory(bridge,request); const readAt = new Date().toISOString();
        const values = [...new Set(deleted.map(ref => ref.sequence))].flatMap(sequence => snapshots.get(sequence) ?? []);
        library = { directory, readAt, sequences: values.flatMap(xml => inspectMa2SequenceXml(xml).sequences.map(sequence => ({ sequence:sequence.number, name:sequence.name, cues:sequence.cues }))), fixtureUsage:values.flatMap(inspectMa2CueFixtures), cueAttributes:values.flatMap(xml => inspectMa2CueAttributes(xml,readAt,true)), errors:[] };
      } catch (cause) { error = `${error ?? ''}删除后的目录读取失败：${message(cause)}，请刷新素材目录。`; }
    }
    report?.({ phase:'library', completed:deleted.length, total:plan.value.items.filter(item=>item.eligible).length, detail:error ?? `已删除 ${deleted.length} 个空 Cue，并在控台上确认` });
    return ma2CueDeleteResultSchema.parse({ deleted, backups, ...(error ? { error } : {}), ...(library ? { library } : {}) });
  }
}
