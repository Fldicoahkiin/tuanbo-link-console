import { ma2LayoutDirectoryRequestSchema, ma2LayoutDirectorySchema, ma2LayoutUpdateRequestSchema, type Ma2LayoutDirectoryRequest, type Ma2LayoutDirectory, type Ma2LayoutUpdateRequest } from '@tb/schema';
import { moveMa2LayoutObjects } from './ma2-timecode-xml';
import { ma2SongBindingSchema, ma2SongSyncRequestSchema, ma2SongSyncResultSchema, ma2SongPointSchema, type Ma2SongSyncRequest, type Ma2SongSyncResult, type Ma2ReadProgressUpdate } from '@tb/schema';
import { planMa2SongSync, type Ma2SongPlan } from './ma2-song-plan';
import { editMa2SongSequence, ma2SequenceCueFingerprints, inspectMa2CueAttributes, inspectMa2CueFixtures, inspectMa2SequenceCueData } from './ma2-timecode-xml';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ma2LayoutReadRequestSchema, ma2NewCueRequestSchema, ma2NewCueResultSchema, ma2ObjectDirectorySchema, type Ma2LayoutReadRequest, type Ma2LayoutSnapshot, type Ma2NewCueRequest, type Ma2NewCueResult } from '@tb/schema';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { emptyMa2SequenceXml, emptyMa2LayoutXml, inspectMa2LayoutXml, inspectMa2SequenceXml, resolveMa2CueNumber, inspectMa2CueData } from './ma2-timecode-xml';
import { readMa2EffectLibrary } from './ma2-effect-library';
import { toConsoleLabel } from '@tb/core/link';
import { writeFileAtomically } from './atomic-file';
import { renameMa2Object } from './ma2-rename-service';
import { assignMa2SongExecutor, planMa2SongExecutor } from './ma2-song-executor';
import { ma2SongCreationStages, recoverMa2SongCreation } from './ma2-song-recovery';
import type { Ma2ConsoleBackups } from './ma2-console-backups';
import { writeMa2SongTimecode } from './ma2-song-timecode';

type Connection = Pick<Ma2Telnet, 'command'>;
type Bridge = Pick<Ma2OnpcBridge, 'request'>;
type SongBridge = Pick<Ma2OnpcBridge, 'request' | 'exchange'>;
type Ma2SongPlanChange = Ma2SongPlan['changes'][number];
const ownersSchema = z.array(z.object({ key: z.string(), projectId: z.string(), name: z.string() }).strict());
const hex = (text: string): string => Buffer.from(text).toString('hex');
const decode = (text: string): string => `unhex('${hex(text)}')`;
const decoder = "local function unhex(h)return (h:gsub('..',function(x)return string.char(tonumber(x,16))end))end;";
const canonical = (xml: string): string => xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim();
/** Lua that removes app-generated upload and comparison files once the command that needed them succeeded. */
const removeFiles = (...names: string[]): string => names.map(name => `os.remove(gma.show.getvar('PATH')..'/importexport/${name}.xml');`).join('');
/**
 * Lua that empties a Cue's data but keeps every attribute it has on the console (fade, delay, trigger …):
 * the Cue is taken from the write-before export without CueDatas (the header keeps the empty Cue 0 slot
 * MA2 needs to import a Sequence), imported into a scratch Sequence,
 * copied back with /o, and the scratch Sequence is deleted. Sources merged afterwards keep these attributes.
 */
const keepCueAttributes = (exportName: string, target: number, cue: string, scratch: number, file: string): string => {
  const [whole, fraction = ''] = cue.split('.');
  return `local p=gma.show.getvar('PATH')..'/importexport/';local f=assert(io.open(p..'${exportName}.xml','rb'));local x=f:read('*a');f:close();`
    + `local i=assert(x:find('<Number number="${Number(whole)}" sub_number="${Number(fraction.padEnd(3, '0'))}"',1,true),'Cue missing from the write-before export');`
    + `local a=1;while true do local j=x:find('<Cue index=',a,true);if not j or j>i then break end;a=j+1 end;`
    + `local c=x:sub(a-1,assert(x:find('</Cue>',i,true),'Cue end missing')+5):gsub('<CueDatas>.-</CueDatas>',''):gsub('<CueDatas%s*/>',''):gsub('<Cue index="%d+"','<Cue index="1"',1);`
    + `local o=assert(io.open(p..'${file}.xml','wb'));o:write(x:sub(1,x:find('<Cue index=',1,true)-1)..c..'</Sequ></MA>');o:close();`
    + `assert(not gma.show.getobj.handle('Sequence ${scratch}'),'Scratch Sequence occupied');gma.cmd('Import ${file}.xml At Sequence ${scratch} /nc');`
    + `local ok=gma.show.getobj.handle('Sequence ${scratch} Cue ${cue}')~=nil;if ok then gma.cmd('Copy Sequence ${scratch} Cue ${cue} At Sequence ${target} Cue ${cue} /o /nc') end;`
    + `gma.cmd('Delete Sequence ${scratch} /nc');os.remove(p..'${file}.xml');assert(ok,'Cue attributes import failed');assert(not gma.show.getobj.handle('Sequence ${scratch}'),'Scratch Sequence not removed');`;
};

/** New objects only; destination is checked again inside the same native command that writes it. */
export class Ma2LayoutService {
  private busy = false;
  private readonly attempted = new Set<string>();
  constructor(private readonly ownershipFile: string, private readonly isPlaying: () => boolean, private readonly backups: Pick<Ma2ConsoleBackups, 'record'>) {}

  private async call(connection: Connection, body: string): Promise<string> {
    const prefix = `TBLINK_LAYOUT_${randomBytes(12).toString('hex')}:`;
    const script = `${decoder}local ok,r=pcall(function() ${body} end);if ok then gma.echo('${prefix}OK:'..tostring(r)) else gma.echo('${prefix}ERR:'..tostring(r)) end`;
    const beforeSend=():void=>{if(this.isPlaying())throw new Error('请停止播放后读取或创建控台 Layout');};
    let command=script;
    // MA2's native command line truncates long Lua input; prepare app-owned code in bounded chunks.
    if(Buffer.byteLength(script)>900 || /["$|^\\\r\n]/.test(script)){
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

  /** With `backup`, the first export stays on the console as the write backup; otherwise both are removed once compared. */
  private async snapshot(connection: Connection, request: Ma2LayoutReadRequest, backup = false): Promise<{ xml: string; file: string; value: Ma2LayoutSnapshot } | null> {
    const file = `tblink_layout_${randomBytes(16).toString('hex')}`;
    const xml = await this.exportLayout(connection, request, file);
    const verified = await this.exportLayout(connection, request, `${file}_verify`);
    if (xml === null && verified === null) return null;
    if (xml === null || verified === null || canonical(xml) !== canonical(verified)) throw new Error('Layout 在读取时发生变化，请重新读取');
    await this.call(connection, `${backup ? removeFiles(`${file}_verify`) : removeFiles(file, `${file}_verify`)}return 'removed'`);
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
    if (request.name !== undefined) request.name = toConsoleLabel(request.name);
    if (this.busy || this.isPlaying()) throw new Error('请停止播放并等待当前控台操作完成');
    this.busy = true; let backup = '';
    try {
      await this.directory(bridge, request); const before = await this.snapshot(connection, request, true);
      if (!before || before.value.revision !== request.revision) throw new Error('控台页面已变化，请刷新后再编辑；未覆盖控台修改');
      backup = before.file;
      const xml = moveMa2LayoutObjects(before.xml, request.layout, request.positions, request.name);
      const file = `tblink_layout_move_${randomBytes(12).toString('hex')}`;
      await this.prepareXml(connection, request, file, xml);
      await this.call(connection, `${this.guard(request)}gma.cmd('Export Layout ${request.layout} ${file}_check /o');local function read(n)local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/'..n..'.xml','rb'));local s=f:read('*a');f:close();return s:gsub('<Info.-/>',''):gsub('>[%s]+<','><') end;assert(read('${before.file}')==read('${file}_check'),'Layout changed during write');gma.cmd('Import ${file}.xml At Layout ${request.layout} /o /nc');${removeFiles(file, `${file}_check`)}return 'written'`);
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

  /**
   * `consoleBaseline` names a console export the song check confirmed equals the binding's baseline.
   * `adoptReadback` may take over the verified post-write export as the next check's baseline; it
   * answers whether it consumed the file, otherwise the file joins this Sequence's backup rotation.
   */
  async syncSong(rawConnection: Connection, rawBridge: SongBridge, input: Ma2SongSyncRequest, report?: (progress: Ma2ReadProgressUpdate) => void, externalSignal?: AbortSignal,
    { consoleBaseline = null, adoptReadback }: { consoleBaseline?: string | null; adoptReadback?: (exportFile: string, result: Ma2SongSyncResult) => Promise<boolean> } = {}): Promise<Ma2SongSyncResult> {
    const request = ma2SongSyncRequestSchema.parse(input);
    // The plan converts the song and Cue names it writes; the Layout name is only ever written.
    request.settings.name = toConsoleLabel(request.settings.name);
    const originalPoints = structuredClone(request.points);
    if (this.busy || this.isPlaying()) throw new Error('请停止播放并等待当前控台操作完成');
    if (this.attempted.has(request.requestId)) throw new Error('此请求已执行，请先回读核对');
    this.busy = true; let wrote = false;
    const deadline = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const received = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => deadline.abort(new Error('控台连续 90 秒没有返回新的确认，当前编辑已保留；恢复连接后核对原位置')), 90000);
    };
    received();
    const signal = externalSignal ? AbortSignal.any([externalSignal, deadline.signal]) : deadline.signal;
    const connection: Connection = { command: (line, match, beforeSend, priority) => {
      signal.throwIfAborted();
      return rawConnection.command(line, match, () => { signal.throwIfAborted(); beforeSend?.(); }, priority).then(result => { received(); return result; });
    } };
    // Every acknowledged line of a long transfer counts as progress for the 90 s watchdog.
    const bridge: SongBridge = { request: (operation, target, expected, desired) => rawBridge.request(operation, target, expected, desired, signal, received).then(result => { received(); return result; }),
      exchange: (operation, target, expected, desired) => rawBridge.exchange(operation, target, expected, desired, signal, received).then(result => { received(); return result; }) };
    const progress = (phase: Ma2ReadProgressUpdate['phase'], completed: number, total: number, detail: string): void => {
      signal.throwIfAborted(); received(); report?.({ phase, completed, total, detail });
    };
    const endpoint = `${request.network.host}:${request.network.port}`;
    let target = request.binding?.sequence ?? request.settings.nextSequence;
    let layoutRequest = { network: request.network, expectedSource: request.expectedSource, layout: request.binding?.layout ?? request.settings.layout };
    let executorPage = request.binding?.executor ? Number(request.binding.executor.split('.')[0]) : request.binding?.layout ? undefined : request.settings.executorPage;
    let backupFile = '';
    try {
      progress('connecting', 0, 1, '核对控台、歌曲绑定与目标位置');
      const directory = await this.directory(bridge, layoutRequest);
      const ownership = `${this.ownershipFile}.songs.json`;
      const schema = z.array(z.object({ key: z.string(), projectId: z.string(), itemId: z.string(), inputHash: z.string().optional(), binding: ma2SongBindingSchema.optional(),
        originalPoints: z.array(ma2SongPointSchema).optional(),
        // Written by versions that held two-sided edits for review; read only to replace the record.
        conflicts: z.array(z.unknown()).optional(),
        draft: z.object({ binding: ma2SongBindingSchema, skeletonXml: z.string(), stages: z.record(z.string(), z.array(z.string())).optional(),
          heldCues: z.array(z.string()).optional(), heldNames: z.array(z.string()).optional(), heldSequenceName: z.boolean().optional(), reserved: z.boolean().optional()
        }).strict().optional()
      }).strict());
      let owners: z.infer<typeof schema>;
      try { owners = schema.parse(JSON.parse(await readFile(ownership, 'utf8'))); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') owners = []; else throw error; }
      const inputHash = createHash('sha256').update(JSON.stringify([request.name, request.points.map(({ id, name, cues }) => ({ id, name, cues }))])).digest('hex');
      const restoredSources = new Map<string, string>();
      const recoverDraft = async (existing: z.infer<typeof schema>[number]): Promise<void> => {
        const draft = existing.draft!;
        const actual = await bridge.request('SEQUENCE', draft.binding.sequence);
        const recovered = recoverMa2SongCreation(draft.binding, draft.skeletonXml, actual, request.points, existing.originalPoints, draft.stages, draft.heldCues, draft.heldNames, draft.heldSequenceName);
        for (const restore of recovered.restores) restoredSources.set(restore.cue, restore.xml);
        const previousBinding = request.binding;
        request.points = recovered.points;
        request.binding = previousBinding ? { ...recovered.binding, ...previousBinding, baselineXml: recovered.binding.baselineXml, points: recovered.binding.points } : recovered.binding;
        target = request.binding.sequence;
        layoutRequest = { ...layoutRequest, layout: request.binding.layout ?? request.settings.layout };
        executorPage = request.binding.executor ? Number(request.binding.executor.split('.')[0]) : undefined;
      };
      if (!request.binding) {
        const previous = owners.filter(owner => owner.key.startsWith(`${endpoint}/${directory.show}/`) && owner.projectId === request.projectId && owner.itemId === request.itemId && directory.entries.some(entry => owner.key === `${endpoint}/${directory.show}/${entry.target}`));
        if (previous.length > 1) throw new Error(`本曲已有多个控台序列记录：${previous.map(owner => owner.key.split('/').at(-1)).join('、')}，请核对；未重复新建`);
        const existing = previous[0];
        if (existing) {
          const savedBinding = existing.binding ?? existing.draft?.binding;
          if (!savedBinding || existing.inputHash !== inputHash && !existing.originalPoints) throw new Error(`上一次同步已保留序列 ${existing.key.split('/').at(-1)}，请先从控台读取核对；不会重复新建或覆盖`);
          target = savedBinding.sequence;
          if (existing.draft && !existing.binding) {
            await recoverDraft(existing);
          } else {
            request.binding = savedBinding;
            request.points = request.points.map(point => {
              const saved = savedBinding.points.find(value => value.id === point.id);
              if (!saved) return point;
              const original = existing.originalPoints?.find(value => value.id === point.id);
              if (original && JSON.stringify(original.cues) !== JSON.stringify(point.cues)) return point;
              return { ...point, cues: [{ sequence: target, cue: saved.cue, delayMs: 0 }] };
            });
          }
          layoutRequest = { ...layoutRequest, layout: savedBinding.layout ?? request.settings.layout };
          executorPage = savedBinding.executor ? Number(savedBinding.executor.split('.')[0]) : undefined;
        }
      } else {
        const pending = owners.find(owner => owner.key === `${endpoint}/${directory.show}/${request.binding!.sequence}` && owner.projectId === request.projectId && owner.itemId === request.itemId && owner.draft);
        // An interrupted write whose Sequence is gone from the console left nothing to recover there.
        if (pending && directory.entries.some(entry => entry.target === request.binding!.sequence)) await recoverDraft(pending);
      }
      if (!request.binding) {
        const occupied = new Set(directory.entries.map(entry => entry.target));
        while (occupied.has(target) && target < 99999) target++;
        if (occupied.has(target)) throw new Error('起始序列之后没有空位置，请修改起始序列');
        request.settings.nextSequence = target;
      }
      if (request.binding && (request.binding.endpoint !== endpoint || request.binding.show !== directory.show || request.binding.layout !== null && request.settings.layout !== request.binding.layout)) throw new Error('本曲绑定的控台、Show 或页面发生变化，请先核对原位置');
      const key = `${endpoint}/${directory.show}/${target}`;
      if (request.binding && owners.some(value => value.key === key && (value.projectId !== request.projectId || value.itemId !== request.itemId))) throw new Error('此位置已关联本机另一歌曲，请核对歌曲绑定');
      // Confirm the destination before importing or renaming any song content.
      const destination = executorPage ? await planMa2SongExecutor(bridge, request, target, executorPage, request.binding?.executor, this.isPlaying) : null;
      // With 'keep', SEQUENCE leaves its native export as importexport/tblink_library_<request id>.xml
      // on the console; the write guard and the backup use that file instead of uploading the XML again.
      // When the song check confirmed the console still equals the saved baseline, that check's export
      // is copied on the console instead, and the Sequence is not read over Telnet at all.
      // A bound Sequence deleted on the console is created again from the last confirmed snapshot.
      const sequenceMissing = request.binding !== undefined && !directory.entries.some(entry => entry.target === target);
      let remote: { response: string; requestId: string } | null = null;
      if (sequenceMissing) progress('connecting', 1, 1, `控台上没有序列 ${target}，按上次确认的内容重建`);
      else if (request.binding && consoleBaseline) {
        if (!/^tblink_watch_[a-f0-9]{16}$/.test(consoleBaseline)) throw new Error('歌曲复查基线文件名无效');
        const requestId = randomBytes(16).toString('hex');
        await this.call(connection, `${this.guard(layoutRequest)}local p=gma.show.getvar('PATH')..'/importexport/';local f=assert(io.open(p..'${consoleBaseline}.xml','rb'));local s=f:read('*a');f:close();local o=assert(io.open(p..'tblink_library_${requestId}.xml','wb'));o:write(s);o:close();return 'copied'`);
        remote = { response: request.binding.baselineXml, requestId };
      } else if (request.binding) remote = await bridge.exchange('SEQUENCE', target, 'keep');
      const remoteXml = remote?.response ?? null;
      const remoteExport = remote ? `tblink_library_${remote.requestId}` : null;
      const labelBackups: string[] = [];
      // The saved project carries the console identity and the native three-way baseline.
      // A new installation/computer has no local ownership cache; validate that binding
      // instead of permanently rejecting every saved song.
      const plan = planMa2SongSync(request, remoteXml, [...restoredSources.keys()]);
      // Content kept only in the local snapshot: Cues restored, or taken from this song's own Sequence while the console lacks it.
      const fromSnapshot = (change: Ma2SongPlanChange, ref: { sequence: number }): boolean => ref.sequence === target && (change.restore === true || remoteXml === null);
      const beforeLayout = executorPage ? null : await this.snapshot(connection, layoutRequest);
      const needsLayoutItem = !executorPage && !beforeLayout?.value.items.some(item => item.sequence === target);
      const layoutOwners = await this.readOwners();
      const layoutKey = `${endpoint}/${directory.show}/${layoutRequest.layout}`;
      if (needsLayoutItem && beforeLayout && !layoutOwners.some(owner => owner.key === layoutKey && owner.projectId === request.projectId && owner.name === beforeLayout.value.name)) throw new Error(`Layout ${layoutRequest.layout} 不属于本工程，请选择空页面，避免改动已有布局`);
      const changes = [];
      const sources = new Map<string, string>();
      const sourceCount = new Set(plan.changes.flatMap(change => (change.refs ?? []).map(ref => ref.sequence))).size;
      // Read only the Cues the song copies from each source Sequence; the full export stays on the console.
      const wanted = new Map<number, Set<string>>();
      for (const change of plan.changes) for (const ref of change.refs ?? []) {
        if (ref.sequence === target) continue;
        const [whole, fraction = ''] = ref.cue.split('.');
        wanted.set(ref.sequence, (wanted.get(ref.sequence) ?? new Set<string>()).add(`${Number(whole)}.${fraction.padEnd(3, '0')}`));
      }
      const sourceCues = (sequence: number): string => [...wanted.get(sequence) ?? []].join(',');
      progress('library', 0, sourceCount, `读取 ${sourceCount} 个来源序列`);
      for (const change of plan.changes) {
        const content: Array<{ xml: string; cue: string }> | undefined = change.refs === undefined ? undefined : [];
        for (const ref of change.refs ?? []) {
          if (fromSnapshot(change, ref)) {
            if (!request.binding) throw new Error(`Cue 引用了控台上还没有的序列 ${target}，请改用其他序列的 Cue`);
            content!.push({ xml: restoredSources.get(ref.cue) ?? request.binding.baselineXml, cue: ref.cue }); continue;
          }
          let xml = sources.get(String(ref.sequence));
          if (!xml) {
            xml = ref.sequence === target && remoteXml ? remoteXml : await bridge.request('SEQCUES', ref.sequence, sourceCues(ref.sequence));
            sources.set(String(ref.sequence), xml);
            progress('library', sources.size, sourceCount, `已读取来源序列 ${ref.sequence}`);
          }
          content!.push({ xml, cue: ref.cue });
        }
        changes.push({ cue: change.cue, name: change.name, ...(content === undefined ? {} : { sources: content }) });
      }
      const existingName = remoteXml ? inspectMa2SequenceXml(remoteXml).sequences[0]?.name : null;
      const changed = !remoteXml || changes.length > 0 || plan.deletions.length > 0 || existingName !== plan.name || needsLayoutItem;
      const file = `tblink_song_${request.requestId.replaceAll('-', '')}`;
      const desired = changed || remoteXml === null ? editMa2SongSequence(remoteXml ?? emptyMa2SequenceXml(target, directory.version), plan.name, changes, plan.deletions) : remoteXml;
      const namesOnly = remoteXml && !needsLayoutItem && !plan.deletions.length && changes.every(change => change.sources === undefined);
      const checkpoint = async (skeletonXml: string, stages?: Record<string, string[]>): Promise<void> => {
        const binding = { endpoint, show: directory.show, layout: executorPage ? null : layoutRequest.layout, ...(destination ? { executor: destination.address } : {}),
          sequence: target, name: request.name, baselineXml: desired, points: plan.points };
        await writeFileAtomically(ownership, JSON.stringify([...owners.filter(value => value.key !== key), { key, projectId: request.projectId, itemId: request.itemId, inputHash, originalPoints,
          draft: { binding, skeletonXml, ...(stages ? { stages } : {}) }
        }]));
      };
      let copiedOnConsole = false;
      if (changed && namesOnly) {
        progress('previews', 0, changes.length + 1, '同步歌曲与 Cue 名称');
        await checkpoint(remoteXml);
        this.attempted.add(request.requestId); wrote = true;
        const remote = inspectMa2SequenceXml(remoteXml).sequences[0]!;
        const names = [...(remote.name !== plan.name ? [{ kind: 'sequence' as const, cue: '0', confirmedName: remote.name ?? '', name: plan.name }] : []), ...changes.map(change => ({ kind: 'single' as const, cue: change.cue, confirmedName: remote.cues.find(cue => Number(cue.number) === Number(change.cue))?.name ?? '', name: change.name }))];
        for (const change of names) {
          if (this.isPlaying()) throw new Error('播放已开始，后续名称尚未发送');
          const result = await renameMa2Object(bridge, { dataDirectory: '', network: request.network, generation: request.expectedSource.generation, change: { endpoint, show: directory.show, sequence: target, ...change } });
          backupFile ||= result.backupFile; labelBackups.push(result.backupFile);
          progress('previews', names.indexOf(change) + 1, names.length, `已回读${change.kind === 'sequence' ? '序列名称' : ` Cue ${change.cue} 名称`}`);
        }
      } else if (changed) {
        // New songs can copy their already-present Cue data inside MA2. Only the
        // small empty structure crosses Telnet, not every fixture value twice.
        // A resumed create may now contain added, removed or cleared steps.
        // Replace its verified native snapshot atomically in that case, retaining
        // all untouched console Cue data instead of pretending Copy creates empties.
        const nativeCopy = !remoteXml && Boolean(executorPage) && plan.changes.every(change => (change.refs ?? []).every(ref => !fromSnapshot(change, ref)));
        const clearing = remoteXml && plan.deletions.length > 0 && inspectMa2SequenceXml(remoteXml).sequences[0]!.cues.every(cue => plan.deletions.includes(cue.number));
        // A bound song copies changed Cues into its console Sequence the same way; Copy creates a missing
        // Cue number. Content kept only in the local baseline, Cues taken from this same Sequence, an
        // emptied Cue and a full clear have nothing on the console to copy, so they import the snapshot.
        const copyInPlace = remoteXml !== null && !clearing && plan.changes.every(change => !change.restore && (change.refs === undefined || change.refs.length > 0 && change.refs.every(ref => ref.sequence !== target)));
        const uploaded = nativeCopy ? editMa2SongSequence(emptyMa2SequenceXml(target, directory.version), plan.name, changes.map(change => ({ cue: change.cue, name: change.name, sources: [] })), []) : desired;
        copiedOnConsole = copyInPlace;
        if (!copyInPlace) await this.prepareXml(connection, layoutRequest, file, uploaded, (completed, total) => progress('raw', completed, total, '传输歌曲结构'));
        const replacingAll = clearing && changes.length > 0;
        if (replacingAll) await this.prepareXml(connection, layoutRequest, `${file}_clear`, editMa2SongSequence(remoteXml, plan.name, [], plan.deletions));
        if (remoteExport) backupFile = `${remoteExport}.xml`;
        if (!executorPage && !beforeLayout) await this.prepareXml(connection, layoutRequest, `${file}_layout`, emptyMa2LayoutXml(layoutRequest.layout, directory.version));
        // The song's own Sequence is compared with its console export inside the write command below.
        // Copy takes each source Cue as the console holds it at that moment, so a source edited since
        // it was read shows up in the read-back check below; only the uploaded snapshot reads it twice.
        if (!copyInPlace) for (const [number, xml] of sources) if (Number(number) !== target && canonical(await bridge.request('SEQCUES', Number(number), sourceCues(Number(number)))) !== canonical(xml)) throw new Error('来源 Cue 在合成时改变，未写入，请重新核对');
        await checkpoint(remoteXml ?? uploaded, nativeCopy || copyInPlace ? ma2SongCreationStages(remoteXml ?? uploaded, changes) : undefined);
        const verify = remoteXml ? `gma.cmd('Export Sequence ${target} ${file}_check /o');local function read(n)local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/'..n..'.xml','rb'));local s=f:read('*a');f:close();return s:gsub('<Info.-/>',''):gsub('>[%s]+<','><') end;assert(read('${remoteExport}')==read('${file}_check'),'Sequence changed during write');` : `assert(not gma.show.getobj.handle('Sequence ${target}'),'Sequence occupied');`;
        // Import /o can retain the previous native step table when a numbered
        // Cue disappears from XML. Delete reviewed numbers through MA2 first so
        // its internal Part table is reindexed before applying the new snapshot.
        // Deleting the final native Cue deletes the Sequence and all executor
        // assignments as a side effect. For a reviewed full clear, import the
        // empty snapshot into the existing Sequence instead; no step table
        // remains to reindex and the original object/positions can be retained.
        const remove = clearing ? '' : plan.deletions.map(cue => `gma.cmd('Delete Sequence ${target} Cue ${cue} /nc');assert(not gma.show.getobj.handle('Sequence ${target} Cue ${cue}'),'Cue deletion not confirmed');`).join('');
        this.attempted.add(request.requestId); wrote = true;
        const clear = replacingAll ? `gma.cmd('Import ${file}_clear.xml At Sequence ${target} /o /nc');` : '';
        const write = copyInPlace ? '' : `gma.cmd('Import ${file}.xml At Sequence ${target} /o /nc');assert(gma.show.getobj.handle('Sequence ${target}'),'Sequence creation failed');`;
        await this.call(connection, `${this.guard(layoutRequest)}${verify}${remove}${clear}${write}${removeFiles(file, `${file}_check`, `${file}_clear`)}return 'written'`);
        if (copyInPlace && existingName !== plan.name) await this.call(connection, `${this.guard(layoutRequest)}gma.cmd(${decode(`Label Sequence ${target} "${plan.name}"`)});return 'labelled'`);
        if (nativeCopy || copyInPlace) {
          progress('previews', 0, plan.changes.length, `控台内部${nativeCopy ? '创建' : '写入'} ${plan.changes.length} 个 Cue`);
          // Copy /o takes the first source's attributes; a combined Cue already on the console keeps its own.
          const consoleCues = remoteXml && copyInPlace ? new Set(inspectMa2SequenceXml(remoteXml).sequences[0]!.cues.map(cue => Number(cue.number))) : new Set<number>();
          // onPC 3.7 refused to create Sequence 9990 and above (99999 included); the free number right
          // after the song's own Sequence was created there, so the scratch Sequence goes next to it.
          let scratch = target + 1; while (directory.entries.some(entry => entry.target === scratch)) scratch += 1;
          for (const [changeIndex, change] of plan.changes.entries()) {
            // A number taken over from a deleted point was deleted above and starts fresh.
            const keep = remoteExport !== null && (change.refs?.length ?? 0) > 1 && consoleCues.has(Number(change.cue)) && !plan.deletions.some(cue => Number(cue) === Number(change.cue));
            if (keep) await this.call(connection, `${this.guard(layoutRequest)}${keepCueAttributes(remoteExport, target, change.cue, scratch, `${file}_attrs`)}return 'kept'`);
            for (const [index, ref] of (change.refs ?? []).entries()) {
              await this.call(connection, `${this.guard(layoutRequest)}assert(gma.show.getobj.handle('Sequence ${ref.sequence} Cue ${ref.cue}'),'Source Cue missing');gma.cmd('Copy Sequence ${ref.sequence} Cue ${ref.cue} At Sequence ${target} Cue ${change.cue} /${index || keep ? 'merge' : 'o'} /nc');gma.cmd(${decode(`Label Sequence ${target} Cue ${change.cue} "${change.name}"`)});return 'copied'`);
            }
            await this.call(connection, `${this.guard(layoutRequest)}gma.cmd(${decode(`Label Sequence ${target} Cue ${change.cue} "${change.name}"`)});return 'labelled'`);
            progress('previews', changeIndex + 1, plan.changes.length, `已写入 Sequence ${target} Cue ${change.cue}`);
          }
        }
        if (needsLayoutItem) {
          let slot = beforeLayout?.value.items.length ?? 0;
          const position = (i: number) => ({ x: i % request.settings.columns * 2, y: -Math.floor(i / request.settings.columns) * 2 });
          while (slot < 10000 && beforeLayout?.value.items.some(item => Math.abs(item.x - position(slot).x) < item.width / 2 + .5 && Math.abs(item.y - position(slot).y) < item.height / 2 + .5)) slot++;
          if (slot >= 10000) throw new Error('Layout 没有可用位置');
          if (!beforeLayout) await this.call(connection, `${this.guard(layoutRequest)}assert(not gma.show.getobj.handle('Layout ${layoutRequest.layout}'),'Layout occupied');gma.cmd('Import ${file}_layout.xml At Layout ${layoutRequest.layout} /nc');gma.cmd(${decode(`Label Layout ${layoutRequest.layout} "${request.settings.name}"`)});${removeFiles(`${file}_layout`)}return 'layout'`);
          else { const current = await this.snapshot(connection, layoutRequest); if (!current || canonical(current.xml) !== canonical(beforeLayout.xml)) throw new Error('Layout 已变化，序列已保留，请核对后重新读取'); }
          const { x, y } = position(slot);
          await this.call(connection, `${this.guard(layoutRequest)}gma.cmd('Assign Sequence ${target} At Layout ${layoutRequest.layout} /x=${x} /y=${y}');return 'assigned'`);
          await writeFileAtomically(this.ownershipFile, JSON.stringify([...layoutOwners.filter(value => value.key !== layoutKey), { key: layoutKey, projectId: request.projectId, name: beforeLayout?.value.name ?? request.settings.name }]));
        }
      }
      progress('verification', 0, 1, `回读序列 ${target}，确认名称、内容和位置`);
      // Kept on the console: a failed check leaves it beside the write-before export as evidence.
      const readback = changed ? await bridge.exchange('SEQUENCE', target, 'keep') : null;
      const readbackFile = readback ? `tblink_library_${readback.requestId}` : null;
      // Without a write the console still holds the Sequence as read before it.
      const verifiedXml = readback ? readback.response : remoteXml;
      if (verifiedXml === null) throw new Error('歌曲序列回读缺失');
      const report = inspectMa2SequenceXml(verifiedXml).sequences[0]!;
      if (report.number !== target || report.name !== plan.name) throw new Error('歌曲序列名称回读未通过');
      const actualHashes = ma2SequenceCueFingerprints(verifiedXml);
      const oldHashes = remoteXml ? ma2SequenceCueFingerprints(remoteXml) : new Map<string, string>();
      for (const [number, hash] of oldHashes) if (!changes.some(change => Number(change.cue) === Number(number)) && !plan.deletions.includes(number) && actualHashes.get(number) !== hash) throw new Error(`未修改的 Cue ${number} 回读不同，已停止同步`);
      const expectedReport = changes.length ? inspectMa2SequenceXml(desired).sequences[0]! : null;
      const changedNumbers = new Set(changes.map(change => Number(change.cue)));
      const actualData = changes.length ? inspectMa2SequenceCueData(verifiedXml, report.cues.filter(cue => changedNumbers.has(Number(cue.number))).map(cue => cue.index)) : new Map<number, Map<string, Record<string, string>>>();
      const expectedData = expectedReport ? inspectMa2SequenceCueData(desired, expectedReport.cues.filter(cue => changedNumbers.has(Number(cue.number))).map(cue => cue.index)) : new Map<number, Map<string, Record<string, string>>>();
      for (const change of changes) {
        const actual = report.cues.find(cue => Number(cue.number) === Number(change.cue));
        const expected = expectedReport?.cues.find(cue => Number(cue.number) === Number(change.cue));
        const normalize = (value: Map<string, Record<string, string>>) => JSON.stringify([...value].sort(([a],[b]) => a.localeCompare(b)).map(([key,layers]) => [key,Object.entries(layers).sort(([a],[b]) => a.localeCompare(b))]));
        if (!actual || !expected || actual.name !== change.name) throw new Error(`Cue ${change.cue} 名称回读未通过`);
        if (normalize(actualData.get(actual.index)!) !== normalize(expectedData.get(expected.index)!)) {
          const refs = plan.changes.find(value => Number(value.cue) === Number(change.cue))?.refs ?? [];
          throw new Error(copiedOnConsole && refs.length
            ? `Cue ${change.cue} 的灯光内容与来源 ${refs.map(ref => `序列 ${ref.sequence} · Cue ${ref.cue}`).join(' + ')} 回读不一致：控台上的来源可能在同步期间被改过，请核对来源后重新同步`
            : `Cue ${change.cue} 内容回读未通过`);
        }
      }
      if (plan.deletions.some(number => actualHashes.has(number) && !changedNumbers.has(Number(number)))) throw new Error('歌曲 Cue 删除回读未通过');
      // The show record the project holds, or the one recorded here when the project never received it.
      const previousTimecode = request.binding?.timecode ?? owners.find(owner => owner.key === key && owner.projectId === request.projectId && owner.itemId === request.itemId)?.binding?.timecode;
      const executor = executorPage ? await assignMa2SongExecutor(connection, bridge, request, target, executorPage, request.binding?.executor, this.isPlaying) : undefined;
      const afterLayout = executorPage ? null : changed ? await this.snapshot(connection, layoutRequest) : beforeLayout;
      if (!executorPage && !afterLayout?.value.items.some(item => item.sequence === target)) throw new Error('Layout 未回读到本曲序列');
      const verifiedDirectory = await this.directory(bridge, layoutRequest); const readAt = new Date().toISOString();
      progress('verification', 1, 1, `${executor ? `执行器 ${executor}` : `Layout ${layoutRequest.layout}`} · 序列 ${target} 已确认`);
      const result = ma2SongSyncResultSchema.parse({ binding: { endpoint, show: directory.show, layout: executorPage ? null : layoutRequest.layout, ...(executor ? { executor } : {}), sequence: target, name: report.name, baselineXml: canonical(verifiedXml),
          // The Timecode show record and the times it fires stay until the show is written again below.
          points: plan.points.map(point => { const atMs = request.binding?.points.find(value => value.id === point.id)?.atMs; return atMs === undefined ? point : { ...point, atMs }; }),
          ...previousTimecode ? { timecode: previousTimecode } : {} },
        library: { directory: verifiedDirectory, readAt, sequences: [{ sequence: target, name: report.name, cues: report.cues }], errors: [], fixtureDetails: 'included', fixtureUsage: inspectMa2CueFixtures(verifiedXml), cueAttributes: inspectMa2CueAttributes(verifiedXml, readAt, true) },
        layout: afterLayout?.value ?? null, backupFile, changed,
        remoteRevision: createHash('sha256').update(canonical(verifiedXml)).digest('hex') });
      // Persist the verified binding before returning. If the renderer closes or
      // saving the project fails, the next explicit check recovers this position.
      const previousOwner = owners.find(owner => owner.key === key);
      if (changed || JSON.stringify(previousOwner?.binding) !== JSON.stringify(result.binding) || previousOwner?.conflicts !== undefined) {
        await writeFileAtomically(ownership, JSON.stringify([...owners.filter(owner => owner.key !== key), { key, projectId: request.projectId, itemId: request.itemId, inputHash, originalPoints, binding: result.binding }]));
      }
      // The write-before export and any name backups join this Sequence's rotation once the sync is
      // confirmed; so does the post-write export unless the song check took it over as its baseline.
      const adopted = readbackFile && adoptReadback ? await adoptReadback(readbackFile, result) : false;
      const backups = [...remoteExport ? [remoteExport] : [], ...labelBackups, ...readbackFile && !adopted ? [readbackFile] : []];
      if (backups.length) await this.backups.record(rawBridge, { console: endpoint, object: `Sequence ${target}`, files: backups });
      if (request.timecodeStartMs === undefined || !executor) return result;
      // The Sequence is confirmed and recorded, so a failure from here on concerns only the show.
      wrote = false;
      progress('verification', 1, 1, `写入本曲时间码节目 · 序列 ${target}`);
      const times = new Map(request.points.map(point => [point.id, point.atMs]));
      const journal = (binding: Ma2SongSyncResult['binding']): Promise<void> => writeFileAtomically(ownership, JSON.stringify([...owners.filter(owner => owner.key !== key), { key, projectId: request.projectId, itemId: request.itemId, inputHash, originalPoints, binding }]));
      const written = await writeMa2SongTimecode(bridge, { previous: previousTimecode, sequence: target, executor, startMs: request.timecodeStartMs, lengthMs: request.timecodeLengthMs, name: report.name ?? toConsoleLabel(request.name), version: directory.version,
        cues: result.binding.points.map(point => {
          const cue = report.cues.find(value => Number(value.number) === Number(point.cue));
          if (!cue) throw new Error(`本曲时间码节目未写入：序列 ${target} 回读中没有 Cue ${point.cue}`);
          return { atMs: times.get(point.id)!, cueIndex: cue.index, number: cue.number, name: cue.name };
        }), created: timecode => journal({ ...result.binding, timecode }) });
      const timed = ma2SongSyncResultSchema.parse({ ...result, binding: { ...result.binding, timecode: written.timecode, points: result.binding.points.map(point => ({ ...point, atMs: times.get(point.id)! })) } });
      await journal(timed.binding);
      if (written.backup) await this.backups.record(rawBridge, { console: endpoint, object: `Timecode ${written.timecode.number}`, files: [written.backup] });
      return timed;
    } catch (cause) { throw new Error(`${wrote ? `序列 ${target} 的写入结果待核对，原位置与备份 ${backupFile || '新建对象记录'} 已保留。` : ''}${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
    finally { clearTimeout(timer!); this.busy = false; }
  }

  private async readOwners(): Promise<z.infer<typeof ownersSchema>> {
    try { return ownersSchema.parse(JSON.parse(await readFile(this.ownershipFile, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  }
  private async prepareXml(connection: Connection, request: Ma2LayoutReadRequest, file: string, xml: string, report?: (completed: number, total: number) => void): Promise<void> {
    // One guarded command creates the file and a writer bound to it. Each data line then only calls
    // that writer: 360 bytes per line instead of 128, and no Show name, so it stays under 900 bytes.
    const writer = `TBLINK_W_${randomBytes(12).toString('hex')}`;
    const beforeSend = (): void => { if (this.isPlaying()) throw new Error('请停止播放后读取或创建控台 Layout'); };
    await this.call(connection, `${this.guard(request)}local p=gma.show.getvar('PATH')..'/importexport/${file}.xml';local f=assert(io.open(p,'wb'));f:close();${writer}=function(i,h,e)local ok,r=pcall(function()local f=assert(io.open(p,'ab'));f:write(unhex(h));f:close()end);if e then ${writer}=nil end;gma.echo('${writer}:'..i..':'..(ok and 'OK' or 'ERR:'..tostring(r)))end;return 'prepared'`);
    const bytes = Buffer.from(xml);
    report?.(0, bytes.length);
    for (let offset = 0, index = 0; offset < bytes.length; offset += 360, index++) {
      const prefix = `${writer}:${index}:`;
      const result = await connection.command(`Lua "if ${writer} then ${writer}(${index},'${bytes.subarray(offset, offset + 360).toString('hex')}'${offset + 360 >= bytes.length ? ',1' : ''}) else gma.echo('${prefix}ERR:missing') end"`, text => ma2ResponseLine(text, prefix), beforeSend);
      if (result !== 'OK') throw new Error(`控台文件写入未确认：${result.replace(/^ERR:/, '')}`);
      report?.(Math.min(offset + 360, bytes.length), bytes.length);
    }
  }

  async create(connection: Connection, bridge: Bridge, input: Ma2NewCueRequest): Promise<Ma2NewCueResult> {
    const request = ma2NewCueRequestSchema.parse(input);
    request.name = toConsoleLabel(request.name); request.settings.name = toConsoleLabel(request.settings.name);
    if (this.busy || this.isPlaying()) throw new Error('请停止播放并等待当前控台操作完成');
    if (this.attempted.has(request.requestId)) throw new Error('此新建请求已经执行过，请读取控台核对结果');
    this.busy = true;
    let wrote = false;
    const target = request.settings.nextSequence;
    try {
      const layoutRequest = { network: request.network, expectedSource: request.expectedSource, layout: request.settings.layout };
      const directory = await this.directory(bridge, layoutRequest);
      if (directory.entries.some(entry => entry.target === target)) throw new Error(`序列 ${target} 已占用，请设置一个空编号`);
      const old = await this.snapshot(connection, layoutRequest, true);
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
      await this.call(connection, `${this.guard(layoutRequest)}local o=gma.show.getobj;assert(not o.handle('Sequence ${target}'),'Sequence occupied');${layoutCheck}${setup}assert(o.handle('Sequence ${target} Cue 1'),'Cue creation failed');${removeFiles(blankFile, `${blankFile}_check`)}return 'created'`);
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
      await this.call(connection, `${this.guard(layoutRequest)}${old ? '' : `assert(not gma.show.getobj.handle('Layout ${request.settings.layout}'),'Layout occupied');gma.cmd(${decode(`Import "${blankFile}_layout.xml" At Layout ${request.settings.layout} /nc`)});gma.cmd(${decode(`Label Layout ${request.settings.layout} "${request.settings.name}"`)});${removeFiles(`${blankFile}_layout`)}`}gma.cmd('Assign Sequence ${target} At Layout ${request.settings.layout} /x=${x} /y=${y}');return 'assigned'`);
      const after = await this.snapshot(connection, layoutRequest);
      if (!after || !after.value.items.some(item => item.sequence === target) || old && old.value.items.some((item,index) => JSON.stringify(item) !== JSON.stringify(after.value.items[index]))) throw new Error('Layout 回读未通过，请在控台核对，未自动重试');
      await writeFileAtomically(this.ownershipFile, JSON.stringify([...owners.filter(value=>value.key!==key),{key,projectId:request.projectId,name:after.value.name}]));
      return ma2NewCueResultSchema.parse({ layout: after.value, sequence: target, cue: '1.000', library, backupFile: old ? `${old.file}.xml` : '' });
    } catch (error) {
      throw new Error(`${wrote ? `序列 ${target} 可能已创建，保留现场结果，请先读取核对，不会自动重试。` : ''}${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally { this.busy = false; }
  }
}
