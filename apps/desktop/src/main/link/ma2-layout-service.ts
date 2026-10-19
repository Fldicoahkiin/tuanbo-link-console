import { ma2LayoutDirectoryRequestSchema, ma2LayoutDirectorySchema, ma2LayoutUpdateRequestSchema, type Ma2LayoutDirectoryRequest, type Ma2LayoutDirectory, type Ma2LayoutUpdateRequest } from '@tb/schema';
import { moveMa2LayoutObjects } from './ma2-timecode-xml';
import { ma2SongSyncRequestSchema, ma2SongSyncResultSchema, type Ma2SongSyncRequest, type Ma2SongSyncResult } from '@tb/schema';
import { planMa2SongSync } from './ma2-song-plan';
import { editMa2SongSequence, ma2SequenceCueFingerprints, inspectMa2CueAttributes, inspectMa2CueFixtures } from './ma2-timecode-xml';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ma2LayoutReadRequestSchema, ma2NewCueRequestSchema, ma2NewCueResultSchema, ma2ObjectDirectorySchema, type Ma2LayoutReadRequest, type Ma2LayoutSnapshot, type Ma2NewCueRequest, type Ma2NewCueResult } from '@tb/schema';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { emptyMa2SequenceXml, emptyMa2LayoutXml, inspectMa2LayoutXml, inspectMa2SequenceXml, resolveMa2CueNumber, inspectMa2CueData } from './ma2-timecode-xml';
import { readMa2EffectLibrary } from './ma2-effect-library';
import { writeFileAtomically } from './atomic-file';
import { renameMa2Object } from './ma2-rename-service';
import { assignMa2SongExecutor, planMa2SongExecutor } from './ma2-song-executor';

type Connection = Pick<Ma2Telnet, 'command'>;
type Bridge = Pick<Ma2OnpcBridge, 'request'>;
const ownersSchema = z.array(z.object({ key: z.string(), projectId: z.string(), name: z.string() }).strict());
const hex = (text: string): string => Buffer.from(text).toString('hex');
const decode = (text: string): string => `unhex('${hex(text)}')`;
const decoder = "local function unhex(h)return (h:gsub('..',function(x)return string.char(tonumber(x,16))end))end;";
const canonical = (xml: string): string => xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim();

/** New objects only; destination is checked again inside the same native command that writes it. */
export class Ma2LayoutService {
  private busy = false;
  private readonly attempted = new Set<string>();
  constructor(private readonly ownershipFile: string, private readonly isPlaying: () => boolean) {}

  private async call(connection: Connection, body: string): Promise<string> {
    const prefix = `TBLINK_LAYOUT_${randomBytes(12).toString('hex')}:`;
    const script = `${decoder}local ok,r=pcall(function() ${body} end);if ok then gma.echo('${prefix}OK:'..tostring(r)) else gma.echo('${prefix}ERR:'..tostring(r)) end`;
    const beforeSend=():void=>{if(this.isPlaying())throw new Error('请停止播放后读取或创建控台 Layout');};
    let command=script;
    // MA2's native command line truncates long Lua input; prepare app-owned code in bounded chunks.
    if(Buffer.byteLength(script)>900){
      const key=`TBLINK_LAYOUT_${randomBytes(12).toString('hex')}`;
      const prepare=async(code:string):Promise<void>=>{
        const response=await connection.command(`Lua "${code};gma.echo('${prefix}READY')"`,text=>ma2ResponseLine(text,prefix),beforeSend);
        if(response!=='READY')throw new Error('Layout 操作准备未确认');
      };
      await prepare(`${key}={}`);
      const bytes=Buffer.from(script);
      for(let offset=0;offset<bytes.length;offset+=128)await prepare(`${decoder}${key}[#${key}+1]=unhex('${bytes.subarray(offset,offset+128).toString('hex')}')`);
      command=`local s=table.concat(${key});${key}=nil;local f=assert(load(s,'tblink_layout','t'));f()`;
    }
    const result = await connection.command(`Lua "${command}"`, text => ma2ResponseLine(text, prefix), beforeSend);
    if (!result.startsWith('OK:')) throw new Error(`MA2 Layout：${result.slice(4)}`);
    return result.slice(3);
  }

  private guard(request: Ma2LayoutReadRequest): string {
    return `assert(gma.show.getvar('SHOWFILE')==${decode(request.expectedSource.show)} and TBLINK_BRIDGE_GENERATION==${decode(request.expectedSource.generation)},'Show or session changed');`;
  }

  private async directory(bridge: Bridge, request: Ma2LayoutReadRequest) {
    const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
    if (Object.entries(request.expectedSource).some(([key, value]) => Reflect.get(directory, key) !== value)) throw new Error('控台或 Show 已变化，请重新读取');
    return directory;
  }

  private async exportLayout(connection: Connection, request: Ma2LayoutReadRequest, file: string): Promise<string | null> {
    const length = await this.call(connection, `${this.guard(request)}if not gma.show.getobj.handle('Layout ${request.layout}') then return 'missing' end;gma.cmd('Export Layout ${request.layout} ${file} /o');local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','rb'));local n=f:seek('end');f:close();return n`);
    if (length === 'missing') return null;
    const size = Number(length);
    if (!Number.isInteger(size) || size < 1 || size > 4 * 1024 * 1024) throw new Error('Layout 导出长度无效或超过 4 MB');
    const parts: Buffer[] = [];
    for (let offset = 0; offset < size; offset += 256) {
      const part = await this.call(connection, `${this.guard(request)}local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','rb'));f:seek('set',${offset});local s=f:read(${Math.min(256,size-offset)});f:close();return (s:gsub('.',function(c)return string.format('%02x',c:byte())end))`);
      if (!/^(?:[a-f0-9]{2})+$/.test(part) || part.length !== Math.min(256,size-offset)*2) throw new Error('Layout 数据传输不完整');
      parts.push(Buffer.from(part, 'hex'));
    }
    return Buffer.concat(parts).toString('utf8');
  }

  private async snapshot(connection: Connection, request: Ma2LayoutReadRequest): Promise<{ xml: string; file: string; value: Ma2LayoutSnapshot } | null> {
    const file = `tblink_layout_${randomBytes(16).toString('hex')}`;
    const xml = await this.exportLayout(connection, request, file);
    const verified = await this.exportLayout(connection, request, `${file}_verify`);
    if (xml === null && verified === null) return null;
    if (xml === null || verified === null || canonical(xml) !== canonical(verified)) throw new Error('Layout 在读取时发生变化，请重新读取');
    return { xml, file, value: { ...inspectMa2LayoutXml(xml, request.layout), revision: createHash('sha256').update(canonical(xml)).digest('hex') } };
  }

  async read(connection: Connection, bridge: Bridge, input: Ma2LayoutReadRequest): Promise<Ma2LayoutSnapshot> {
    const request = ma2LayoutReadRequestSchema.parse(input);
    await this.directory(bridge, request);
    const snapshot = await this.snapshot(connection, request);
    await this.directory(bridge, request);
    if (!snapshot) throw new Error(`Layout ${request.layout} 尚未创建；新建 Cue 时可创建专用布局`);
    return snapshot.value;
  }

  async list(connection: Connection, bridge: Bridge, input: Ma2LayoutDirectoryRequest): Promise<Ma2LayoutDirectory> {
    const inputValue = ma2LayoutDirectoryRequestSchema.parse(input); const request = { ...inputValue, layout: 1 };
    await this.directory(bridge, request);
    const pages: Ma2LayoutDirectory = [];
    for (let start = 1; start <= 9999; start += 1000) {
      const rows = await this.call(connection, `${this.guard(request)}local r={};local o=gma.show.getobj;for n=${start},${Math.min(9999,start+999)} do local h=o.handle('Layout '..n);if h then local s=o.label(h) or o.name(h) or '';r[#r+1]=n..':'..(s:gsub('.',function(c)return string.format('%02x',c:byte())end)) end end;return table.concat(r,',')`);
      for (const row of rows ? rows.split(',') : []) { const [number, label] = row.split(':'); if (!number || label === undefined || !/^(?:[a-f0-9]{2})*$/.test(label)) throw new Error('Layout 目录数据无效'); pages.push({ layout: Number(number), name: Buffer.from(label, 'hex').toString('utf8') }); }
    }
    await this.directory(bridge, request); return ma2LayoutDirectorySchema.parse(pages);
  }

  async update(connection: Connection, bridge: Bridge, input: Ma2LayoutUpdateRequest): Promise<Ma2LayoutSnapshot> {
    const request = ma2LayoutUpdateRequestSchema.parse(input);
    if (this.busy || this.isPlaying()) throw new Error('请停止播放并等待当前控台操作完成');
    this.busy = true; let backup = '';
    try {
      await this.directory(bridge, request); const before = await this.snapshot(connection, request);
      if (!before || before.value.revision !== request.revision) throw new Error('控台页面已变化，请刷新后再编辑；未覆盖控台修改');
      backup = before.file;
      const xml = moveMa2LayoutObjects(before.xml, request.layout, request.positions, request.name);
      const file = `tblink_layout_move_${randomBytes(12).toString('hex')}`;
      await this.prepareXml(connection, request, file, xml);
      await this.call(connection, `${this.guard(request)}gma.cmd('Export Layout ${request.layout} ${file}_check /o');local function read(n)local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/'..n..'.xml','rb'));local s=f:read('*a');f:close();return s:gsub('<Info.-/>',''):gsub('>[%s]+<','><'):match('^%s*(.-)%s*$') end;assert(read('${before.file}')==read('${file}_check'),'Layout changed during write');gma.cmd('Import ${file}.xml At Layout ${request.layout} /o /nc');return 'written'`);
      const after = await this.snapshot(connection, request);
      if (!after) throw new Error('Layout 回读缺失');
      const expected = inspectMa2LayoutXml(xml, request.layout);
      if (JSON.stringify([expected.name, expected.items, expected.omittedFixtures]) !== JSON.stringify([after.value.name, after.value.items, after.value.omittedFixtures])) throw new Error('Layout 名称或位置回读未通过');
      if (before.value.name !== after.value.name) {
        const key = `${request.network.host}:${request.network.port}/${request.expectedSource.show}/${request.layout}`;
        const owners = await this.readOwners();
        if (owners.some(owner => owner.key === key && owner.name === before.value.name)) await writeFileAtomically(this.ownershipFile, JSON.stringify(owners.map(owner => owner.key === key && owner.name === before.value.name ? { ...owner, name: after.value.name } : owner)));
      }
      return after.value;
    } catch (cause) { throw new Error(`${cause instanceof Error ? cause.message : String(cause)}${backup ? `；控台备份 ${backup}.xml` : ''}`, { cause }); }
    finally { this.busy = false; }
  }

  async syncSong(connection: Connection, bridge: Bridge, input: Ma2SongSyncRequest): Promise<Ma2SongSyncResult> {
    const request = ma2SongSyncRequestSchema.parse(input);
    if (this.busy || this.isPlaying()) throw new Error('请停止播放并等待当前控台操作完成');
    if (this.attempted.has(request.requestId)) throw new Error('此请求已执行，请先回读核对');
    this.busy = true; let wrote = false;
    const endpoint = `${request.network.host}:${request.network.port}`;
    const target = request.binding?.sequence ?? request.settings.nextSequence;
    const layoutRequest = { network: request.network, expectedSource: request.expectedSource, layout: request.binding?.layout ?? request.settings.layout };
    const executorPage = request.binding?.executor ? Number(request.binding.executor.split('.')[0]) : request.binding?.layout ? undefined : request.settings.executorPage;
    let backupFile = '';
    try {
      const directory = await this.directory(bridge, layoutRequest);
      if (request.binding && (request.binding.endpoint !== endpoint || request.binding.show !== directory.show || request.binding.layout !== null && request.settings.layout !== request.binding.layout)) throw new Error('本曲绑定的控台、Show 或页面发生变化，请先核对原位置');
      const ownership = `${this.ownershipFile}.songs.json`;
      const schema = z.array(z.object({ key: z.string(), projectId: z.string(), itemId: z.string() }).strict());
      let owners: z.infer<typeof schema>;
      try { owners = schema.parse(JSON.parse(await readFile(ownership, 'utf8'))); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') owners = []; else throw error; }
      const key = `${endpoint}/${directory.show}/${target}`;
      if (request.binding && !owners.some(value => value.key === key && value.projectId === request.projectId && value.itemId === request.itemId)) throw new Error('此序列不是本机为当前歌曲创建的，拒绝覆盖；请核对歌曲绑定');
      if (!request.binding && directory.entries.some(value => value.target === target)) throw new Error(`序列 ${target} 已占用，请选择空编号`);
      // Confirm the destination before importing or renaming any song content.
      if (executorPage) await planMa2SongExecutor(bridge, request, target, executorPage, request.binding?.executor, this.isPlaying);
      const remoteXml = request.binding ? await bridge.request('SEQUENCE', target) : null;
      const plan = planMa2SongSync(request, remoteXml);
      const beforeLayout = executorPage ? null : await this.snapshot(connection, layoutRequest);
      const needsLayoutItem = !executorPage && !beforeLayout?.value.items.some(item => item.sequence === target);
      const layoutOwners = await this.readOwners();
      const layoutKey = `${endpoint}/${directory.show}/${layoutRequest.layout}`;
      if (needsLayoutItem && beforeLayout && !layoutOwners.some(owner => owner.key === layoutKey && owner.projectId === request.projectId && owner.name === beforeLayout.value.name)) throw new Error(`Layout ${layoutRequest.layout} 不属于本工程，请选择空页面，避免改动已有布局`);
      const changes = [];
      const sources = new Map<string, string>();
      for (const change of plan.changes) {
        const content: Array<{ xml: string; cue: string }> | undefined = change.refs === undefined ? undefined : [];
        for (const ref of change.refs ?? []) {
          let xml = sources.get(String(ref.sequence));
          if (!xml) { xml = ref.sequence === target && remoteXml ? remoteXml : await bridge.request('SEQUENCE', ref.sequence); sources.set(String(ref.sequence), xml); }
          content!.push({ xml, cue: ref.cue });
        }
        changes.push({ cue: change.cue, name: change.name, ...(content === undefined ? {} : { sources: content }) });
      }
      const existingName = remoteXml ? inspectMa2SequenceXml(remoteXml).sequences[0]?.name : null;
      const changed = !remoteXml || changes.length > 0 || plan.deletions.length > 0 || existingName !== plan.name || needsLayoutItem;
      const file = `tblink_song_${request.requestId.replaceAll('-', '')}`;
      const desired = changed ? editMa2SongSequence(remoteXml ?? emptyMa2SequenceXml(target, directory.version), plan.name, changes, plan.deletions) : remoteXml;
      const namesOnly = remoteXml && !needsLayoutItem && !plan.deletions.length && changes.every(change => change.sources === undefined);
      if (changed && namesOnly) {
        this.attempted.add(request.requestId); wrote = true;
        const remote = inspectMa2SequenceXml(remoteXml).sequences[0]!;
        const names = [...(remote.name !== plan.name ? [{ kind: 'sequence' as const, cue: '0', confirmedName: remote.name ?? '', name: plan.name }] : []), ...changes.map(change => ({ kind: 'single' as const, cue: change.cue, confirmedName: remote.cues.find(cue => Number(cue.number) === Number(change.cue))?.name ?? '', name: change.name }))];
        for (const change of names) {
          if (this.isPlaying()) throw new Error('播放已开始，后续名称尚未发送');
          const result = await renameMa2Object(bridge, { dataDirectory: '', network: request.network, generation: request.expectedSource.generation, change: { endpoint, show: directory.show, sequence: target, ...change } });
          backupFile ||= result.backupFile;
        }
      } else if (changed) {
        await this.prepareXml(connection, layoutRequest, file, desired);
        if (remoteXml) { backupFile = `${file}_before.xml`; await this.prepareXml(connection, layoutRequest, `${file}_before`, remoteXml); }
        if (!executorPage && !beforeLayout) await this.prepareXml(connection, layoutRequest, `${file}_layout`, emptyMa2LayoutXml(layoutRequest.layout, directory.version));
        for (const [number, xml] of sources) if (canonical(await bridge.request('SEQUENCE', Number(number))) !== canonical(xml)) throw new Error('来源 Cue 在合成时改变，未写入，请重新核对');
        if (!request.binding) await writeFileAtomically(ownership, JSON.stringify([...owners.filter(value => value.key !== key), { key, projectId: request.projectId, itemId: request.itemId }]));
        const verify = remoteXml ? `gma.cmd('Export Sequence ${target} ${file}_check /o');local function read(n)local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/'..n..'.xml','rb'));local s=f:read('*a');f:close();return s:gsub('<Info.-/>',''):gsub('>[%s]+<','><'):match('^%s*(.-)%s*$') end;assert(read('${file}_before')==read('${file}_check'),'Sequence changed during write');` : `assert(not gma.show.getobj.handle('Sequence ${target}'),'Sequence occupied');`;
        this.attempted.add(request.requestId); wrote = true;
        await this.call(connection, `${this.guard(layoutRequest)}${verify}gma.cmd('Import ${file}.xml At Sequence ${target} /o /nc');assert(gma.show.getobj.handle('Sequence ${target}'),'Sequence creation failed');return 'written'`);
        if (needsLayoutItem) {
          let slot = beforeLayout?.value.items.length ?? 0;
          const position = (i: number) => ({ x: i % request.settings.columns * 2, y: -Math.floor(i / request.settings.columns) * 2 });
          while (slot < 10000 && beforeLayout?.value.items.some(item => Math.abs(item.x - position(slot).x) < item.width / 2 + .5 && Math.abs(item.y - position(slot).y) < item.height / 2 + .5)) slot++;
          if (slot >= 10000) throw new Error('Layout 没有可用位置');
          if (!beforeLayout) await this.call(connection, `${this.guard(layoutRequest)}assert(not gma.show.getobj.handle('Layout ${layoutRequest.layout}'),'Layout occupied');gma.cmd('Import ${file}_layout.xml At Layout ${layoutRequest.layout} /nc');gma.cmd(${decode(`Label Layout ${layoutRequest.layout} "${request.settings.name}"`)});return 'layout'`);
          else { const current = await this.snapshot(connection, layoutRequest); if (!current || canonical(current.xml) !== canonical(beforeLayout.xml)) throw new Error('Layout 已变化，序列已保留，请核对后重新读取'); }
          const { x, y } = position(slot);
          await this.call(connection, `${this.guard(layoutRequest)}gma.cmd('Assign Sequence ${target} At Layout ${layoutRequest.layout} /x=${x} /y=${y}');return 'assigned'`);
          await writeFileAtomically(this.ownershipFile, JSON.stringify([...layoutOwners.filter(value => value.key !== layoutKey), { key: layoutKey, projectId: request.projectId, name: beforeLayout?.value.name ?? request.settings.name }]));
        }
      }
      const verifiedXml = changed ? await bridge.request('SEQUENCE', target) : remoteXml;
      const report = inspectMa2SequenceXml(verifiedXml).sequences[0]!;
      if (report.number !== target || report.name !== plan.name) throw new Error('歌曲序列名称回读未通过');
      const actualHashes = ma2SequenceCueFingerprints(verifiedXml);
      const oldHashes = remoteXml ? ma2SequenceCueFingerprints(remoteXml) : new Map<string, string>();
      for (const [number, hash] of oldHashes) if (!changes.some(change => Number(change.cue) === Number(number)) && !plan.deletions.includes(number) && actualHashes.get(number) !== hash) throw new Error(`未修改的 Cue ${number} 回读不同，已停止同步`);
      for (const change of changes) {
        const actual = report.cues.find(cue => Number(cue.number) === Number(change.cue));
        const expected = inspectMa2SequenceXml(desired).sequences[0]!.cues.find(cue => Number(cue.number) === Number(change.cue));
        const normalize = (value: Map<string, Record<string, string>>) => JSON.stringify([...value].sort(([a],[b]) => a.localeCompare(b)).map(([key,layers]) => [key,Object.entries(layers).sort(([a],[b]) => a.localeCompare(b))]));
        if (!actual || !expected || actual.name !== change.name || normalize(inspectMa2CueData(verifiedXml, actual.index)) !== normalize(inspectMa2CueData(desired, expected.index))) throw new Error(`Cue ${change.cue} 内容或名称回读未通过`);
      }
      if (plan.deletions.some(number => actualHashes.has(number))) throw new Error('歌曲 Cue 删除回读未通过');
      const executor = executorPage ? await assignMa2SongExecutor(connection, bridge, request, target, executorPage, request.binding?.executor, this.isPlaying) : undefined;
      const afterLayout = executorPage ? null : changed ? await this.snapshot(connection, layoutRequest) : beforeLayout;
      if (!executorPage && !afterLayout?.value.items.some(item => item.sequence === target)) throw new Error('Layout 未回读到本曲序列');
      const verifiedDirectory = await this.directory(bridge, layoutRequest); const readAt = new Date().toISOString();
      return ma2SongSyncResultSchema.parse({ binding: { endpoint, show: directory.show, layout: executorPage ? null : layoutRequest.layout, ...(executor ? { executor } : {}), sequence: target, name: report.name, baselineXml: canonical(verifiedXml), points: plan.points },
        library: { directory: verifiedDirectory, readAt, sequences: [{ sequence: target, name: report.name, cues: report.cues }], errors: [], fixtureDetails: 'included', fixtureUsage: inspectMa2CueFixtures(verifiedXml), cueAttributes: inspectMa2CueAttributes(verifiedXml, readAt, true) },
        layout: afterLayout?.value ?? null, removed: plan.removed, backupFile, changed });
    } catch (cause) { throw new Error(`${wrote ? `序列 ${target} 可能已写入，已停止自动同步；请核对，备份 ${backupFile || '新建对象'}。` : ''}${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
    finally { this.busy = false; }
  }

  private async readOwners(): Promise<z.infer<typeof ownersSchema>> {
    try { return ownersSchema.parse(JSON.parse(await readFile(this.ownershipFile, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  }
  private async prepareXml(connection: Connection, request: Ma2LayoutReadRequest, file: string, xml: string): Promise<void> {
    await this.call(connection, `${this.guard(request)}local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','wb'));f:close();return 'prepared'`);
    const bytes = Buffer.from(xml);
    for (let offset = 0; offset < bytes.length; offset += 128) await this.call(connection, `${this.guard(request)}local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','ab'));f:write(unhex('${bytes.subarray(offset,offset+128).toString('hex')}'));f:close();return 'prepared'`);
  }

  async create(connection: Connection, bridge: Bridge, input: Ma2NewCueRequest): Promise<Ma2NewCueResult> {
    const request = ma2NewCueRequestSchema.parse(input);
    if (this.busy || this.isPlaying()) throw new Error('请停止播放并等待当前控台操作完成');
    if (this.attempted.has(request.requestId)) throw new Error('此新建请求已经执行过，请读取控台核对结果');
    this.busy = true;
    let wrote = false;
    const target = request.settings.nextSequence;
    try {
      const layoutRequest = { network: request.network, expectedSource: request.expectedSource, layout: request.settings.layout };
      const directory = await this.directory(bridge, layoutRequest);
      if (directory.entries.some(entry => entry.target === target)) throw new Error(`序列 ${target} 已占用，请设置一个空编号`);
      const old = await this.snapshot(connection, layoutRequest);
      const key = `${request.network.host}:${request.network.port}/${request.expectedSource.show}/${request.settings.layout}`;
      let owners: z.infer<typeof ownersSchema>;
      try { owners = ownersSchema.parse(JSON.parse(await readFile(this.ownershipFile, 'utf8'))); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') owners = []; else throw error; }
      const owner = owners.find(value => value.key === key);
      if (old && (owner?.projectId !== request.projectId || owner.name !== old.value.name)) throw new Error(`Layout ${request.settings.layout} 已有其他内容，请设置空的专用 Layout 编号`);
      const combined=new Map<string,Record<string,string>>();
      if (request.content.kind === 'combine') for (const ref of request.content.cues) {
        const sourceXml=await bridge.request('SEQUENCE', ref.sequence);
        const report = inspectMa2SequenceXml(sourceXml);
        const cue=resolveMa2CueNumber(ref.sequence, ref.cue, [report]);
        for(const [channel,layers] of inspectMa2CueData(sourceXml,cue.cueIndex))combined.set(channel,{...combined.get(channel),...layers});
      }
      if(request.content.kind==='combine'&&!combined.size)throw new Error('所选 Cue 没有显式灯具属性；Tracking 继承内容不能按静态属性组合');
      let slot = old?.value.items.length ?? 0;
      const position=(index:number)=>({x:(index%request.settings.columns)*2,y:-Math.floor(index/request.settings.columns)*2});
      while(slot<10000 && old?.value.items.some(item=>Math.abs(item.x-position(slot).x)<item.width/2+.5 && Math.abs(item.y-position(slot).y)<item.height/2+.5))slot++;
      if(slot>=10000)throw new Error('专用 Layout 已没有可用位置');
      const {x,y}=position(slot);
      const blankFile = `tblink_newcue_${request.requestId.replaceAll('-','')}`;
      const xml = emptyMa2SequenceXml(target, directory.version);
      const prepareXml=async(file:string,text:string):Promise<void>=>{
        await this.call(connection, `${this.guard(layoutRequest)}local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','wb'));f:close();return 'prepared'`);
        const bytes=Buffer.from(text);
        for(let offset=0;offset<bytes.length;offset+=128)await this.call(connection, `local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','ab'));f:write(unhex('${bytes.subarray(offset,offset+128).toString('hex')}'));f:close();return 'prepared'`);
      };
      if(request.content.kind==='combine')await prepareXml(blankFile,xml);
      if(!old)await prepareXml(`${blankFile}_layout`,emptyMa2LayoutXml(request.settings.layout,directory.version));
      const setup = request.content.kind === 'combine'
        ? `gma.cmd(${decode(`Import "${blankFile}.xml" At Sequence ${target} /nc`)});`
        : `gma.cmd('Store Sequence ${target} Cue 1 /use=${request.content.use} /keepactive /nc');`;
      // A single guarded command owns object creation. Each merge below only touches this new object.
      const layoutCheck = old ? `assert(o.handle('Layout ${request.settings.layout}'),'Layout missing');gma.cmd('Export Layout ${request.settings.layout} ${blankFile}_check /o');local function read(n)local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/'..n..'.xml','rb'));local s=f:read('*a');f:close();return s:gsub('<Info[^>]* />',''):gsub('>[%s]+<','><') end;assert(read('${old.file}')==read('${blankFile}_check'),'Layout changed');` : `assert(not o.handle('Layout ${request.settings.layout}'),'Layout occupied');`;
      this.attempted.add(request.requestId); wrote = true;
      await this.call(connection, `${this.guard(layoutRequest)}local o=gma.show.getobj;assert(not o.handle('Sequence ${target}'),'Sequence occupied');${layoutCheck}${setup}assert(o.handle('Sequence ${target} Cue 1'),'Cue creation failed');return 'created'`);
      if (request.content.kind === 'combine') for (const ref of request.content.cues) await this.call(connection, `${this.guard(layoutRequest)}assert(gma.show.getobj.handle('Sequence ${ref.sequence} Cue ${ref.cue}'),'Source Cue missing');gma.cmd('Copy Sequence ${ref.sequence} Cue ${ref.cue} At Sequence ${target} Cue 1 /merge /nc');return 'merged'`);
      await this.call(connection, `${this.guard(layoutRequest)}gma.cmd(${decode(`Label Sequence ${target} "${request.name}"`)});gma.cmd(${decode(`Label Sequence ${target} Cue 1 "${request.name}"`)});return 'labelled'`);
      if(request.content.kind==='combine') {
        const actual=inspectMa2CueData(await bridge.request('SEQUENCE',target),1);
        const normalized=(value:Map<string,Record<string,string>>):string=>JSON.stringify([...value].sort(([a],[b])=>a.localeCompare(b)).map(([key,layers])=>[key,Object.entries(layers).sort(([a],[b])=>a.localeCompare(b))]));
        if(normalized(actual)!==normalized(combined))throw new Error('合成后的灯具属性值与所选 Cue 不一致，未加入 Layout；请检查 World、Filter 或 Cue Part');
      }
      const library = await readMa2EffectLibrary(bridge, this.isPlaying, undefined, undefined, [target], request.expectedSource, 'attributes', connection);
      const cue = library.sequences[0]?.cues[0];
      if (library.errors.length || !cue || cue.name !== request.name || !library.cueAttributes?.some(value => value.attributes.length)) throw new Error('新 Cue 未回读到灯具属性；请检查控台 Programmer、World 和 Store Filter。未加入 Layout');
      await this.call(connection, `${this.guard(layoutRequest)}${old ? '' : `assert(not gma.show.getobj.handle('Layout ${request.settings.layout}'),'Layout occupied');gma.cmd(${decode(`Import "${blankFile}_layout.xml" At Layout ${request.settings.layout} /nc`)});gma.cmd(${decode(`Label Layout ${request.settings.layout} "${request.settings.name}"`)});`}gma.cmd('Assign Sequence ${target} At Layout ${request.settings.layout} /x=${x} /y=${y}');return 'assigned'`);
      const after = await this.snapshot(connection, layoutRequest);
      if (!after || !after.value.items.some(item => item.sequence === target) || old && old.value.items.some((item,index) => JSON.stringify(item) !== JSON.stringify(after.value.items[index]))) throw new Error('Layout 回读未通过，请在控台核对，未自动重试');
      await writeFileAtomically(this.ownershipFile, JSON.stringify([...owners.filter(value=>value.key!==key),{key,projectId:request.projectId,name:after.value.name}]));
      return ma2NewCueResultSchema.parse({ layout: after.value, sequence: target, cue: '1.000', library, backupFile: old ? `${old.file}.xml` : '' });
    } catch (error) {
      throw new Error(`${wrote ? `序列 ${target} 可能已创建，保留现场结果，请先读取核对，不会自动重试。` : ''}${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally { this.busy = false; }
  }
}
