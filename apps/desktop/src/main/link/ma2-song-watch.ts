import { createHash, randomBytes } from 'node:crypto';
import type { Ma2SongCheckRequest } from '@tb/schema';
import { ma2SongCheckRequestSchema } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { inspectMa2ExecutorXml } from './ma2-timecode-xml';

const canonical = (xml: string): string => xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim();
type Snapshot = { file: string; revision: string };

/** Compare complete native exports on MA2; unchanged fixture data never crosses IPC. */
export class Ma2SongWatch {
  private readonly snapshots = new Map<string, Snapshot>();
  private busy = false;
  constructor(private readonly isPlaying: () => boolean) {}
  async changed(connection: Pick<Ma2Telnet, 'command'>, bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2SongCheckRequest): Promise<boolean> {
    const request = ma2SongCheckRequestSchema.parse(input);
    if (this.busy) throw new Error('歌曲回读检查尚未结束');
    const stopped = (): void => { if (this.isPlaying()) throw new Error('播放期间暂停歌曲回读'); };
    stopped(); this.busy = true;
    const key = JSON.stringify([request.network, request.expectedSource, request.sequence, request.executor]);
    const cached = this.snapshots.get(key);
    const file = cached?.file ?? `tblink_watch_${randomBytes(8).toString('hex')}`;
    const guard = `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(request.expectedSource.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(request.expectedSource.generation)} and gma.show.getvar('VERSION')==${ma2LuaString(request.expectedSource.version)},'Show or session changed');`;
    const exportObject = (object: string, name: string): string => `assert(gma.show.getobj.handle('${object}'),'Song position missing');gma.cmd('Export ${object} ${name} /o');`;
    // No $, ^ or |: the native command line consumes them and forces the multi-line chunked path.
    const read = "local function r(n)local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/'..n..'.xml','rb'));local s=f:read('*a');f:close();return s:gsub('<Info.-/>',''):gsub('>[%s]+<','><')end;";
    const capture = async (suffix: string): Promise<void> => {
      await runMa2GuardedLua(connection, `${guard}${exportObject(`Sequence ${request.sequence}`, `${file}${suffix}`)}${request.executor ? exportObject(`Executor ${request.executor}`, `${file}${suffix}_exec`) : ''}return 'captured'`, stopped);
    };
    const same = async (): Promise<boolean> => {
      await capture('_check');
      // The baseline export stays for the next check; the check exports are removed once compared.
      const remove = (name: string): string => `os.remove(gma.show.getvar('PATH')..'/importexport/${name}.xml');`;
      return await runMa2GuardedLua(connection, `${guard}${read}local same=r('${file}')==r('${file}_check')${request.executor ? ` and r('${file}_exec')==r('${file}_check_exec')` : ''};${remove(`${file}_check`)}${request.executor ? remove(`${file}_check_exec`) : ''}return same`, stopped) === 'true';
    };
    try {
      if (cached) {
        if (await same()) return cached.revision !== request.revision;
        this.snapshots.delete(key); return true;
      }
      await capture('');
      const xml = await bridge.request('SEQUENCE', request.sequence);
      if (request.executor) {
        const [page, slot] = request.executor.split('.');
        const executor = inspectMa2ExecutorXml(await bridge.request('EXECUTOR', Number(page), slot));
        if (executor.sequence !== request.sequence) throw new Error(`本曲原位置 ${request.executor} 已改为其他序列，请核对`);
      }
      // This is a read-only race, not an unsuccessful write. Tell the coordinator
      // to obtain a fresh sequence before planning any changes.
      if (!await same()) return true;
      const revision = createHash('sha256').update(canonical(xml)).digest('hex');
      if (this.snapshots.size >= 16) this.snapshots.delete(this.snapshots.keys().next().value!);
      this.snapshots.set(key, { file, revision });
      return revision !== request.revision;
    } catch (cause) { this.snapshots.delete(key); throw cause; }
    finally { this.busy = false; }
  }
}
