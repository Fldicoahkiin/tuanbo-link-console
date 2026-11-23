import { randomUUID } from 'node:crypto';
import type { Ma2LayoutDirectoryRequest } from '@tb/schema';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { listMa2ExecutorPages, readMa2ExecutorPage, readMa2ExecutorPageSnapshot } from './ma2-executor-page';
import { ma2LuaString, runMa2GuardedLua } from './ma2-lua-command';
import { ma2ExecutorNativeBlocks } from './ma2-timecode-xml';
import { holdForShow, type ShowGateReader } from '@tb/core/link';

/**
 * Where the song's Sequence sits on its executor page. A bound song keeps its slot while that slot
 * holds the song or is empty; a Sequence the operator moved on the same page is followed there; a
 * slot now taken by other content leaves it untouched and the song moves to the next free slot.
 * Buttons 101–190 of a full page are never overwritten: the song goes to the next page (2026-10-26:
 * page 1000 full continues on 1001), up to nine pages on.
 */
export type Ma2SongExecutorPlan = { address: string; slot: number; pageExists: boolean; assigned: boolean; detachedBlock?: string };
export async function planMa2SongExecutor(bridge: Pick<Ma2OnpcBridge, 'request'>, source: Ma2LayoutDirectoryRequest, sequence: number, page: number, existing: string | undefined, show: ShowGateReader, mode: 'bound' | 'requested' | 'restore-empty' = 'bound', reserved?: ReadonlySet<string>): Promise<Ma2SongExecutorPlan> {
  const fromRequested = mode === 'requested';
  const stopped = (): void => { holdForShow(show, 'ma2.executor.mutate', '执行器位置没有改。'); };
  stopped();
  const request = { network: source.network, expectedSource: source.expectedSource };
  const snapshot = await readMa2ExecutorPageSnapshot(bridge, { ...request, page });
  const pageExists = snapshot.xml !== null;
  const items = snapshot.page.items;
  const covers = (slot: number): boolean => Boolean(reserved?.has(`${page}.${slot}`)) || items.some(item => slot >= item.slot && slot < item.slot + item.width);
  const current = items.find(item => item.sequence === sequence && !reserved?.has(`${page}.${item.slot}`));
  if (existing) {
    const [oldPage, oldSlot] = existing.split('.').map(Number);
    if (oldPage === page && !reserved?.has(existing) && items.some(item => item.slot === oldSlot && item.sequence === sequence)) return { address: existing, slot: oldSlot!, pageExists: true, assigned: true };
    if (!fromRequested && current) return { address: `${page}.${current.slot}`, slot: current.slot, pageExists: true, assigned: true };
    if (oldPage === page && !covers(oldSlot!)) return { address: existing, slot: oldSlot!, pageExists, assigned: false };
    const old = items.find(item => item.slot === oldSlot);
    if (mode === 'restore-empty' && snapshot.xml && oldPage === page && old?.width === 1 && old.kind === 'other' && old.name === '' && !old.reference.length) {
      // MA2 drops zero-step Sequences on SaveShow, but keeps their unassigned executor and its keys.
      // Recognize only the unmodified native defaults at the song's own previously confirmed address.
      const block = ma2ExecutorNativeBlocks(snapshot.xml, old.slot, 1)[0]?.replace(/>\s+</g, '><');
      const buttons = old.slot <= 100 ? [12299, 12293, 12290, 0] : [12299, 0, 0, 0];
      const standard = '<Exec offset_from_first="0"><Assignment/><AssignmentExec fader="16384">'
        + buttons.map(value => `<Button>${value}</Button>`).join('') + '</AssignmentExec></Exec>';
      if (block && block.replace(/\s+\/>/g, '/>') === standard) {
        return { address: existing, slot: old.slot, pageExists: true, assigned: false, detachedBlock: block };
      }
    }
  }
  const requestedSlot = fromRequested && existing ? Number(existing.split('.')[1]) : 101;
  const firstSlot = requestedSlot >= 201 ? 201 : requestedSlot >= 101 ? 101 : 1;
  const lastSlot = firstSlot === 201 ? 240 : firstSlot === 101 ? 190 : 90;
  let slot = requestedSlot; while (slot <= lastSlot && covers(slot)) slot++;
  if (slot <= lastSlot) return { address: `${page}.${slot}`, slot, pageExists, assigned: false };
  const directory = await listMa2ExecutorPages(bridge, request);
  const lastPage = fromRequested ? 9999 : Math.min(page + 9, 9999);
  for (let next = page + 1; next <= lastPage; next++) {
    const items = directory.pages.some(value => value.page === next) ? (await readMa2ExecutorPage(bridge, { ...request, page: next })).items : null;
    stopped();
    let free = firstSlot; while (free <= lastSlot && (reserved?.has(`${next}.${free}`) || items?.some(item => free >= item.slot && free < item.slot + item.width))) free++;
    if (free <= lastSlot) return { address: `${next}.${free}`, slot: free, pageExists: items !== null, assigned: false };
  }
  throw new Error(`按钮第 ${page}–${lastPage} 页的 ${firstSlot}–${lastSlot} 都已放满了，请选另一页（原有内容没有被覆盖）`);
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
  let check = `assert(not gma.show.getobj.handle('Executor ${address}'),'Executor became occupied');`;
  if (destination.detachedBlock) {
    const file = `tblink_unassigned_${randomUUID().replaceAll('-', '')}`;
    check = `local o=gma.show.getobj;local h=assert(o.handle('Executor ${address}'),'Executor disappeared');assert(not o.label(h) or o.label(h)=='','Executor name changed');`
      + `gma.cmd('Export Executor ${address} ${file} /o');local path=gma.show.getvar('PATH')..'/importexport/${file}.xml';local f=assert(io.open(path,'rb'));local xml=f:read('*a');f:close();os.remove(path);`
      + `local block=xml:match('(<Exec%s[^>]*>.-</Exec>)');assert(block and block:gsub('>%s+<','><')==${ma2LuaString(destination.detachedBlock)},'Executor changed before write');`;
  }
  await runMa2GuardedLua(connection, `${guard}assert(gma.show.getobj.handle('Sequence ${sequence}'),'Song Sequence missing');${createPage}${check}gma.cmd('Assign Sequence ${sequence} At Executor ${address} /nc');return 'assigned'`, stopped);
  const after = await readMa2ExecutorPage(bridge, { network: source.network, expectedSource: source.expectedSource, page });
  if (!after.items.some(item => item.slot === slot && item.sequence === sequence)) throw new Error(`序列 ${sequence} 已保留，但 ${address} 的分配还没确认，请读取这一页检查`);
  return address;
}
