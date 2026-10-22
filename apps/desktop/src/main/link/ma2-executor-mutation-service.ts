import { randomUUID } from 'node:crypto';
import { toConsoleLabel } from '@tb/core/link';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ma2ExecutorUpdateRequestSchema, ma2ExecutorUpdateResultSchema, type Ma2ExecutorPage, type Ma2ExecutorUpdateRequest, type Ma2ExecutorUpdateResult } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { listMa2ExecutorPages, readMa2ExecutorPage } from './ma2-executor-page';
import { inspectMa2ExecutorPageXml, ma2ExecutorNativeBlocks } from './ma2-timecode-xml';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';

type Item = Ma2ExecutorPage['items'][number];
const identity = (item: Item) => JSON.stringify([item.slot, item.width, item.name, item.kind, item.sequence, item.reference, item.button, item.revision]);
const assignment = (item: Item) => JSON.stringify([item.width, item.kind, item.sequence, item.reference]);
const occupied = (page: Ma2ExecutorPage, slot: number, width: number): boolean => page.items.some(item => slot < item.slot + item.width && item.slot < slot + width);

/** Native operations retain all executor settings. No page is rebuilt from the UI's sorted list. */
export class Ma2ExecutorMutationService {
  private busy = false;
  constructor(private readonly backupDirectory: string, private readonly isPlaying: () => boolean) {}

  async update(connection: Pick<Ma2Telnet, 'command'>, bridge: Pick<Ma2OnpcBridge, 'request'>, input: Ma2ExecutorUpdateRequest): Promise<Ma2ExecutorUpdateResult> {
    const request = ma2ExecutorUpdateRequestSchema.parse(input);
    if (this.busy) throw new Error('正在回读上一项执行器修改，请稍候');
    const stopped = (): void => { if (this.isPlaying()) throw new Error('请停止时间线播放后修改执行器；本地编辑可以继续'); };
    stopped(); this.busy = true;
    let attempted = false; let backupFile = '';
    const sourceAddress = `${request.page}.${request.slot}`;
    try {
      const sourceXml = await bridge.request('PAGE', request.page);
      const source = inspectMa2ExecutorPageXml(sourceXml, request.page);
      if (!source.source || Object.entries(request.expectedSource).some(([key, value]) => Reflect.get(source.source!, key) !== value)) throw new Error('控台 Show 或连接会话已变化，请重新读取此页');
      const item = source.items.find(value => value.slot === request.slot);
      if (!item || !request.expectedItem.revision || identity(item) !== identity(request.expectedItem)) throw new Error(`执行器 ${sourceAddress} 已变化，请读取此页后再修改`);
      const action = request.action.kind === 'rename' ? { ...request.action, name: toConsoleLabel(request.action.name) } : request.action;
      if (action.kind === 'move' && action.page === request.page && action.slot === request.slot) throw new Error('目标与原位置相同，无需移动');
      const base = { network: request.network, expectedSource: request.expectedSource };
      const destinationPage = action.kind === 'move' ? action.page : request.page;
      let destination: Ma2ExecutorPage | null = source;
      if (destinationPage !== request.page) {
        const directory = await listMa2ExecutorPages(bridge, base);
        destination = directory.pages.some(value => value.page === destinationPage) ? await readMa2ExecutorPage(bridge, { ...base, page: destinationPage }) : null;
      }
      if (action.kind === 'move' && (action.slot + item.width - 1 > 240 || destination && occupied(destination, action.slot, item.width))) throw new Error(`目标 ${action.page}.${action.slot} 没有足够的连续空格，原位置未移动`);
      await mkdir(this.backupDirectory, { recursive: true });
      const id = randomUUID().replaceAll('-', ''); const nativeFile = `tblink_executor_${id}`;
      backupFile = join(this.backupDirectory, `${nativeFile}.json`);
      await writeFile(backupFile, JSON.stringify({ request, sourceXml, destination, nativeBackup: `importexport/${nativeFile}.xml` }), { encoding: 'utf8', flag: 'wx' });
      const guard = `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(request.expectedSource.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(request.expectedSource.generation)},'Show or session changed');`;
      const expectedBlocks = ma2ExecutorNativeBlocks(sourceXml, item.slot, item.width);
      // Compare the exact native source blocks in the same Lua execution as the write.
      // The export also creates a native console backup of the whole source page.
      const capture = `gma.cmd('Export Page ${request.page} ${nativeFile} /o');local f=assert(io.open(gma.show.getvar('PATH')..'/importexport/${nativeFile}.xml','rb'));local xml=f:read('*a');f:close();local blocks={};local pos=1;while true do local a,b=xml:find('<Exec%s[^>]*>',pos);if not a then break end;if xml:sub(b-1,b)~='/>' then local c,d=xml:find('</Exec>',b+1,true);assert(d,'Executor export incomplete');b=d end;blocks[#blocks+1]=xml:sub(a,b);pos=b+1 end;`;
      const compare = expectedBlocks.map((block, index) => `assert(blocks[${item.slot + index}]==${ma2LuaString(block)},'Executor changed before write');`).join('');
      const preserve = item.sequence ? `local sequence=assert(gma.show.getobj.handle('Sequence ${item.sequence}'),'Assigned Sequence missing');` : '';
      let command: string;
      switch (action.kind) {
        case 'move': {
          const destinationAddress = `${action.page}.${action.slot}`;
          const pageGuard = destination ? `assert(gma.show.getobj.handle('Page ${action.page}'),'Destination page disappeared');` : `assert(not gma.show.getobj.handle('Page ${action.page}'),'Destination page appeared');gma.cmd('Store Page ${action.page} /nc');`;
          const emptyGuard = Array.from({ length: item.width }, (_, offset) => `assert(not gma.show.getobj.handle('Executor ${action.page}.${action.slot + offset}'),'Destination became occupied');`).join('');
          command = `${pageGuard}${emptyGuard}gma.cmd('Move Executor ${sourceAddress} At Executor ${destinationAddress} /nc');assert(not gma.show.getobj.handle('Executor ${sourceAddress}'),'Source still assigned');assert(gma.show.getobj.handle('Executor ${destinationAddress}'),'Destination missing');`;
          break;
        }
        case 'rename':
          command = `gma.cmd(${ma2LuaString(`Label Executor ${sourceAddress} "${action.name}"`)});assert(gma.show.getobj.label(gma.show.getobj.handle('Executor ${sourceAddress}'))==${ma2LuaString(action.name)},'Name readback differs');`;
          break;
        case 'delete':
          command = `gma.cmd('Delete Executor ${sourceAddress} /nc');assert(not gma.show.getobj.handle('Executor ${sourceAddress}'),'Executor still assigned');`;
          break;
      }
      const retained = item.sequence ? `assert(gma.show.getobj.handle('Sequence ${item.sequence}')==sequence,'Assigned Sequence changed');` : '';
      attempted = true;
      if (await runMa2GuardedLua(connection, `${guard}${capture}${compare}${preserve}${guard}${command}${retained}return 'verified'`, stopped) !== 'verified') throw new Error('控台未确认执行器修改');
      const after = await readMa2ExecutorPage(bridge, { ...base, page: request.page });
      const pages = destinationPage === request.page ? [after] : [after, await readMa2ExecutorPage(bridge, { ...base, page: destinationPage })];
      if (action.kind === 'move') {
        const moved = pages.find(page => page.page === action.page)?.items.find(value => value.slot === action.slot);
        if (after.items.some(value => value.slot === request.slot) || !moved || assignment(moved) !== assignment(item) || moved.name !== item.name || JSON.stringify(moved.buttons) !== JSON.stringify(item.buttons)) throw new Error('执行器移动后回读与原分配不一致');
      } else if (action.kind === 'delete') {
        if (after.items.some(value => value.slot === request.slot)) throw new Error('删除后该格仍有分配');
      } else {
        const renamed = after.items.find(value => value.slot === request.slot);
        if (!renamed || renamed.name !== action.name || assignment(renamed) !== assignment(item)) throw new Error('执行器名称回读与修改不一致');
      }
      return ma2ExecutorUpdateResultSchema.parse({ pages, backupFile });
    } catch (error) {
      throw new Error(`${attempted ? `执行器 ${sourceAddress} 的修改结果尚未完整回读，请读取该页核对，未重复发送。` : ''}${error instanceof Error ? error.message : String(error)}${backupFile ? `；备份：${backupFile}` : ''}`, { cause: error });
    } finally { this.busy = false; }
  }
}
