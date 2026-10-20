import type { Ma2LayoutDirectoryRequest } from '@tb/schema';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { listMa2ExecutorPages, readMa2ExecutorPage } from './ma2-executor-page';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';

export async function planMa2SongExecutor(bridge: Pick<Ma2OnpcBridge, 'request'>, source: Ma2LayoutDirectoryRequest, sequence: number, page: number, existing: string | undefined, isPlaying: () => boolean, reserved = false): Promise<{ address: string; slot: number; pageExists: boolean; assigned: boolean }> {
  const stopped = (): void => { if (isPlaying()) throw new Error('播放已经开始，未修改执行器位置'); };
  stopped();
  const request = { network: source.network, expectedSource: source.expectedSource };
  const directory = await listMa2ExecutorPages(bridge, request);
  const snapshot = directory.pages.some(value => value.page === page) ? await readMa2ExecutorPage(bridge, { ...request, page }) : null;
  if (existing) {
    const [oldPage, oldSlot] = existing.split('.').map(Number);
    if (reserved && oldPage === page && !snapshot?.items.some(item => oldSlot! >= item.slot && oldSlot! < item.slot + item.width)) return { address: existing, slot: oldSlot!, pageExists: snapshot !== null, assigned: false };
    if (oldPage !== page || !snapshot?.items.some(item => item.slot === oldSlot && item.sequence === sequence)) throw new Error(`本曲原位置 ${existing} 已改变，请核对控台；不会覆盖其他灯光`);
    return { address: existing, slot: oldSlot!, pageExists: true, assigned: true };
  }
  const occupied = new Set(snapshot?.items.flatMap(item => Array.from({ length: item.width }, (_, i) => item.slot + i)));
  let slot = 101; while (slot <= 190 && occupied.has(slot)) slot++;
  if (slot > 190) throw new Error(`按钮第 ${page} 页已经放满，请选择另一页；原有内容未覆盖`);
  const address = `${page}.${slot}`;
  return { address, slot, pageExists: snapshot !== null, assigned: false };
}

export async function assignMa2SongExecutor(connection: Pick<Ma2Telnet, 'command'>, bridge: Pick<Ma2OnpcBridge, 'request'>, source: Ma2LayoutDirectoryRequest, sequence: number, page: number, existing: string | undefined, isPlaying: () => boolean, reserved = false): Promise<string> {
  const { address, slot, pageExists, assigned } = await planMa2SongExecutor(bridge, source, sequence, page, existing, isPlaying, reserved);
  if (assigned) return address;
  const stopped = (): void => { if (isPlaying()) throw new Error('播放已经开始，未修改执行器位置'); };
  const guard = `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(source.expectedSource.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(source.expectedSource.generation)},'Show or session changed');`;
  const createPage = pageExists ? '' : `assert(not gma.show.getobj.handle('Page ${page}'),'Page appeared during creation');gma.cmd('Store Page ${page} /nc');assert(gma.show.getobj.handle('Page ${page}'),'Page creation failed');`;
  await runMa2GuardedLua(connection, `${guard}assert(gma.show.getobj.handle('Sequence ${sequence}'),'Song Sequence missing');${createPage}assert(not gma.show.getobj.handle('Executor ${address}'),'Executor became occupied');gma.cmd('Assign Sequence ${sequence} At Executor ${address} /nc');return 'assigned'`, stopped);
  const after = await readMa2ExecutorPage(bridge, { network: source.network, expectedSource: source.expectedSource, page });
  if (!after.items.some(item => item.slot === slot && item.sequence === sequence)) throw new Error(`序列 ${sequence} 已保留，但 ${address} 分配回读未确认，请读取此页核对`);
  return address;
}
