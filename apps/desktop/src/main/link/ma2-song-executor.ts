import type { Ma2LayoutDirectoryRequest } from '@tb/schema';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { listMa2ExecutorPages, readMa2ExecutorPage } from './ma2-executor-page';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { holdForShow, type ShowGateReader } from '@tb/core/link';

/**
 * Where the song's Sequence sits on its executor page. A bound song keeps its slot while that slot
 * holds the song or is empty; a Sequence the operator moved on the same page is followed there; a
 * slot now taken by other content leaves it untouched and the song moves to the next free slot.
 * Buttons 101–190 of a full page are never overwritten: the song goes to the next page (2026-10-26:
 * page 1000 full continues on 1001), up to nine pages on.
 */
export type Ma2SongExecutorPlan = { address: string; slot: number; pageExists: boolean; assigned: boolean };
export async function planMa2SongExecutor(bridge: Pick<Ma2OnpcBridge, 'request'>, source: Ma2LayoutDirectoryRequest, sequence: number, page: number, existing: string | undefined, show: ShowGateReader): Promise<Ma2SongExecutorPlan> {
  const stopped = (): void => { holdForShow(show, 'ma2.executor.mutate', '执行器位置没有改。'); };
  stopped();
  const request = { network: source.network, expectedSource: source.expectedSource };
  const directory = await listMa2ExecutorPages(bridge, request);
  const snapshot = directory.pages.some(value => value.page === page) ? await readMa2ExecutorPage(bridge, { ...request, page }) : null;
  const items = snapshot?.items ?? [];
  const covers = (slot: number): boolean => items.some(item => slot >= item.slot && slot < item.slot + item.width);
  const current = items.find(item => item.sequence === sequence);
  if (existing) {
    const [oldPage, oldSlot] = existing.split('.').map(Number);
    if (oldPage === page && items.some(item => item.slot === oldSlot && item.sequence === sequence)) return { address: existing, slot: oldSlot!, pageExists: true, assigned: true };
    if (current) return { address: `${page}.${current.slot}`, slot: current.slot, pageExists: true, assigned: true };
    if (oldPage === page && !covers(oldSlot!)) return { address: existing, slot: oldSlot!, pageExists: snapshot !== null, assigned: false };
  }
  let slot = 101; while (slot <= 190 && covers(slot)) slot++;
  if (slot <= 190) return { address: `${page}.${slot}`, slot, pageExists: snapshot !== null, assigned: false };
  for (let next = page + 1; next <= Math.min(page + 9, 9999); next++) {
    const items = directory.pages.some(value => value.page === next) ? (await readMa2ExecutorPage(bridge, { ...request, page: next })).items : null;
    stopped();
    let free = 101; while (free <= 190 && items?.some(item => free >= item.slot && free < item.slot + item.width)) free++;
    if (free <= 190) return { address: `${next}.${free}`, slot: free, pageExists: items !== null, assigned: false };
  }
  throw new Error(`按钮第 ${page}–${Math.min(page + 9, 9999)} 页的 101–190 都已放满了，请选另一页（原有内容没有被覆盖）`);
}

/**
 * Puts the Sequence where `planMa2SongExecutor` read the page before the write, without reading the
 * page again first: the assignment itself refuses a slot or page that changed since, and the page is
 * read once afterwards to confirm it.
 */
export async function assignMa2SongExecutor(connection: Pick<Ma2Telnet, 'command'>, bridge: Pick<Ma2OnpcBridge, 'request'>, source: Ma2LayoutDirectoryRequest, sequence: number, destination: Ma2SongExecutorPlan, show: ShowGateReader): Promise<string> {
  const { address, slot, pageExists, assigned } = destination;
  if (assigned) return address;
  // The plan may have continued on a later page when the requested one was full.
  const page = Number(address.split('.')[0]);
  const stopped = (): void => { holdForShow(show, 'ma2.executor.mutate', '执行器位置没有改。'); };
  stopped();
  const guard = `assert(gma.show.getvar('SHOWFILE')==${ma2LuaString(source.expectedSource.show)} and TBLINK_BRIDGE_GENERATION==${ma2LuaString(source.expectedSource.generation)},'Show or session changed');`;
  const createPage = pageExists ? '' : `assert(not gma.show.getobj.handle('Page ${page}'),'Page appeared during creation');gma.cmd('Store Page ${page} /nc');assert(gma.show.getobj.handle('Page ${page}'),'Page creation failed');`;
  await runMa2GuardedLua(connection, `${guard}assert(gma.show.getobj.handle('Sequence ${sequence}'),'Song Sequence missing');${createPage}assert(not gma.show.getobj.handle('Executor ${address}'),'Executor became occupied');gma.cmd('Assign Sequence ${sequence} At Executor ${address} /nc');return 'assigned'`, stopped);
  const after = await readMa2ExecutorPage(bridge, { network: source.network, expectedSource: source.expectedSource, page });
  if (!after.items.some(item => item.slot === slot && item.sequence === sequence)) throw new Error(`序列 ${sequence} 已保留，但 ${address} 的分配还没确认，请读取这一页检查`);
  return address;
}
