import { createHash } from 'node:crypto';
import type { Ma2SongCheckRequest } from '@tb/schema';
import { ma2SongCheckRequestSchema } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { inspectMa2ExecutorXml } from './ma2-timecode-xml';
import { holdForShow, type ShowGateReader } from '@tb/core/link';

const canonical = (xml: string): string => xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim();
/** `timecode`: the song's own Timecode show as exported next to the Sequence (`<file>_tc`), and its revision. */
type Snapshot = { file: string; revision: string; timecode?: { number: number; revision: string } };

/** Compare complete native exports on MA2; unchanged fixture data never crosses IPC. */
export class Ma2SongWatch {
  private readonly snapshots = new Map<string, Snapshot>();
  private busy = false;
  /** `show`: checking a song is reading the console; asked before each console command (第 3 题: paused it reads). */
  constructor(private readonly show: ShowGateReader) {}
  private readonly stopped = (): void => { holdForShow(this.show, 'ma2.sync.read'); };
  private waits(): boolean { return this.show('ma2.sync.read').kind === 'wait'; }
  async changed(connection: Pick<Ma2Telnet, 'command'>, bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2SongCheckRequest): Promise<boolean> {
    const request = ma2SongCheckRequestSchema.parse(input);
    if (this.busy) throw new Error('歌曲检查还没结束');
    const stopped = this.stopped;
    stopped(); this.busy = true;
    const key = this.key(request);
    const cached = this.snapshots.get(key);
    const file = cached?.file ?? this.file(request);
    try {
      if (cached) {
        if (!await this.same(connection, request, file, stopped)) { this.snapshots.delete(key); return true; }
        return cached.revision !== request.revision || await this.timecodeChanged(connection, bridge, request, key, cached, stopped);
      }
      // A Sequence or executor removed or reassigned on the console is a change: the full sync puts the song back.
      if (!await this.capture(connection, request, file, '', stopped)) return true;
      const xml = await bridge.request('SEQUENCE', request.sequence);
      if (request.executor) {
        const [page, slot] = request.executor.split('.');
        const executor = inspectMa2ExecutorXml(await bridge.request('EXECUTOR', Number(page), slot));
        if (executor.sequence !== request.sequence) return true;
      }
      // This is a read-only race, not an unsuccessful write. Tell the coordinator
      // to obtain a fresh sequence before planning any changes.
      if (!await this.same(connection, request, file, stopped)) return true;
      const revision = createHash('sha256').update(canonical(xml)).digest('hex');
      this.remember(key, { file, revision });
      return revision !== request.revision || await this.timecodeChanged(connection, bridge, request, key, { file, revision }, stopped);
    } catch (cause) { this.snapshots.delete(key); throw cause; }
    finally { this.busy = false; }
  }

  /**
   * The song's own Timecode show compared on the console like its Sequence (2026-10-26: a time moved
   * there comes back to the software). A baseline is exported and read once for each revision the
   * software confirms; after that every check is a console-side compare. A show missing or changed is
   * a change, which the full sync reads and merges.
   */
  private async timecodeChanged(connection: Pick<Ma2Telnet, 'command'>, bridge: Pick<Ma2OnpcBridge, 'request'>, request: Ma2SongCheckRequest, key: string, snapshot: Snapshot, stopped: () => void): Promise<boolean> {
    const show = request.timecode;
    if (!show) return false;
    if (snapshot.timecode?.number === show.number && snapshot.timecode.revision === show.revision) {
      if (await this.sameTimecode(connection, request, show.number, snapshot.file, stopped)) return false;
      this.remember(key, { file: snapshot.file, revision: snapshot.revision });
      return true;
    }
    const exported = await runMa2GuardedLua(connection, `${this.guard(request)}if not gma.show.getobj.handle('Timecode ${show.number}') then return 'missing' end;gma.cmd('Export Timecode ${show.number} ${snapshot.file}_tc /o');return 'captured'`, stopped);
    if (exported === 'missing') return true;
    const xml = await bridge.request('READ', show.number);
    // Read-only race, as for the Sequence: the show changed between the export and the read.
    if (!await this.sameTimecode(connection, request, show.number, snapshot.file, stopped)) return true;
    const revision = createHash('sha256').update(canonical(xml)).digest('hex');
    this.remember(key, { file: snapshot.file, revision: snapshot.revision, timecode: { number: show.number, revision } });
    return revision !== show.revision;
  }
  private async sameTimecode(connection: Pick<Ma2Telnet, 'command'>, request: Ma2SongCheckRequest, number: number, file: string, stopped: () => void): Promise<boolean> {
    const read = "local function r(n,x)local p=gma.show.getvar('PATH')..'/importexport/'..n..'.xml';local f=assert(io.open(p,'rb'));local s=f:read('*a');f:close();if x then os.remove(p)end;return s:gsub('<Info.-/>',''):gsub('>[%s]+<','><')end;";
    return await runMa2GuardedLua(connection, `${this.guard(request)}if not gma.show.getobj.handle('Timecode ${number}') then return 'missing' end;gma.cmd('Export Timecode ${number} ${file}_check_tc /o');${read}return r('${file}_tc')==r('${file}_check_tc',1)`, stopped) === 'true';
  }

  /**
   * The console export that holds this song's Sequence exactly as `baselineXml`, when a cached check
   * still matches the console; null when there is no such check, one is running or a song is playing. It never reads
   * the Sequence, so a null only means the caller reads it as before.
   */
  async unchangedBaseline(connection: Pick<Ma2Telnet, 'command'>, input: Omit<Ma2SongCheckRequest, 'revision'>, baselineXml: string): Promise<string | null> {
    const request = ma2SongCheckRequestSchema.parse({ ...input, revision: createHash('sha256').update(canonical(baselineXml)).digest('hex') });
    const cached = this.snapshots.get(this.key(request));
    if (this.busy || this.waits() || !cached || cached.revision !== request.revision) return null;
    const stopped = this.stopped;
    stopped(); this.busy = true;
    try {
      if (await this.same(connection, request, cached.file, stopped)) return cached.file;
      this.snapshots.delete(this.key(request)); return null;
    } catch (cause) { this.snapshots.delete(this.key(request)); throw cause; }
    finally { this.busy = false; }
  }

  /**
   * Takes over a Sequence export a sync has just verified at `revision` as this song's check baseline,
   * so the next check is a console-side compare instead of a full read. True once the export was
   * moved (it is consumed even if the console changed meanwhile); false when it was left untouched.
   */
  async adopt(connection: Pick<Ma2Telnet, 'command'>, input: Ma2SongCheckRequest, exportFile: string): Promise<boolean> {
    const request = ma2SongCheckRequestSchema.parse(input);
    if (!/^tblink_library_[a-f0-9]{32}$/.test(exportFile)) throw new Error('歌曲回读导出文件名无效');
    if (this.busy || this.waits()) return false;
    const stopped = this.stopped;
    this.busy = true;
    const key = this.key(request);
    const file = this.snapshots.get(key)?.file ?? this.file(request);
    try {
      const exportExecutor = request.executor ? `assert(gma.show.getobj.handle('Executor ${request.executor}'),'Song position missing');gma.cmd('Export Executor ${request.executor} ${file}_exec /o');` : '';
      await runMa2GuardedLua(connection, `${this.guard(request)}local p=gma.show.getvar('PATH')..'/importexport/';os.remove(p..'${file}.xml');assert(os.rename(p..'${exportFile}.xml',p..'${file}.xml'));${exportExecutor}return 'adopted'`, stopped);
      if (await this.same(connection, request, file, stopped)) this.remember(key, { file, revision: request.revision });
      else this.snapshots.delete(key);
      return true;
    } catch (cause) { this.snapshots.delete(key); throw cause; }
    finally { this.busy = false; }
  }

  private file(request: Ma2SongCheckRequest): string {
    // One baseline file per song position: the next start overwrites it instead of leaving another copy.
    const position = JSON.stringify([request.network.host, request.network.port, request.expectedSource.show, request.sequence, request.executor]);
    return `tblink_watch_${createHash('sha256').update(position).digest('hex').slice(0, 16)}`;
  }
  private remember(key: string, snapshot: Snapshot): void {
    this.snapshots.delete(key);
    if (this.snapshots.size >= 16) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(key, snapshot);
  }
  private key(request: Ma2SongCheckRequest): string { return JSON.stringify([request.network, request.expectedSource, request.sequence, request.executor]); }
  private guard(request: Ma2SongCheckRequest): string {
    return `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(request.expectedSource.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(request.expectedSource.generation)} and gma.show.getvar('VERSION')==${ma2LuaString(request.expectedSource.version)},'Show or session changed');`;
  }
  /** False, exporting nothing, when the song's Sequence or executor is no longer on the console. */
  private async capture(connection: Pick<Ma2Telnet, 'command'>, request: Ma2SongCheckRequest, file: string, suffix: string, stopped: () => void): Promise<boolean> {
    const objects = [[`Sequence ${request.sequence}`, `${file}${suffix}`], ...request.executor ? [[`Executor ${request.executor}`, `${file}${suffix}_exec`]] : []];
    const present = objects.map(([object]) => `gma.show.getobj.handle('${object}')`).join(' and ');
    const exports = objects.map(([object, name]) => `gma.cmd('Export ${object} ${name} /o');`).join('');
    return await runMa2GuardedLua(connection, `${this.guard(request)}if not (${present}) then return 'missing' end;${exports}return 'captured'`, stopped) !== 'missing';
  }
  private async same(connection: Pick<Ma2Telnet, 'command'>, request: Ma2SongCheckRequest, file: string, stopped: () => void): Promise<boolean> {
    if (!await this.capture(connection, request, file, '_check', stopped)) return false;
    // No $, ^ or |: the native command line consumes them and forces the multi-line chunked path.
    // r(name, 1) also removes the file once read: the baseline export stays for the next check.
    const read = "local function r(n,x)local p=gma.show.getvar('PATH')..'/importexport/'..n..'.xml';local f=assert(io.open(p,'rb'));local s=f:read('*a');f:close();if x then os.remove(p)end;return s:gsub('<Info.-/>',''):gsub('>[%s]+<','><')end;";
    // Both comparisons run before combining them, so both check exports are removed.
    return await runMa2GuardedLua(connection, `${this.guard(request)}${read}local a=r('${file}')==r('${file}_check',1)${request.executor ? `;local b=r('${file}_exec')==r('${file}_check_exec',1);return a and b` : ';return a'}`, stopped) === 'true';
  }
}
