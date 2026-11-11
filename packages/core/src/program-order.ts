import { parseLinkProject } from '@tb/schema';
import type { LinkCommand } from './link-command';

/**
 * Moving songs on the home page (2026-11-11). The page shows one playlist, or a search result, so a move is
 * made among the songs on screen: `visibleIds` in their order, `movedIds` some of them, `gap` the place between
 * two of them (0 is before the first, `visibleIds.length` after the last). The songs on screen swap the places
 * they already hold in the whole rundown; songs that are not on screen keep theirs. Several songs move together
 * in their own order. Returns null when nothing would change.
 */
export function reorderedVisibleIds(visibleIds: readonly string[], movedIds: readonly string[], gap: number): string[] | null {
  const moved = new Set(movedIds);
  if (!moved.size || !Number.isInteger(gap) || gap < 0 || gap > visibleIds.length || new Set(visibleIds).size !== visibleIds.length || [...moved].some(id => !visibleIds.includes(id))) return null;
  const block = visibleIds.filter(id => moved.has(id));
  const before = visibleIds.slice(0, gap).filter(id => !moved.has(id));
  const after = visibleIds.slice(gap).filter(id => !moved.has(id));
  const next = [...before, ...block, ...after];
  return next.every((id, index) => id === visibleIds[index]) ? null : next;
}

/** The gap one place up (-1) or down (+1) from `id` among the songs on screen; null at the end of the list. */
export function neighbourGap(visibleIds: readonly string[], id: string, direction: -1 | 1): number | null {
  const index = visibleIds.indexOf(id);
  if (index < 0) return null;
  const gap = direction < 0 ? index - 1 : index + 2;
  return gap < 0 || gap > visibleIds.length ? null : gap;
}

/** The one command that changes the order of songs from the home page: drag and drop, 上移 and 下移. One undo step. */
export function moveVisibleProgramsCommand(visibleIds: readonly string[], movedIds: readonly string[], gap: number): LinkCommand {
  const visible = [...visibleIds], moved = [...movedIds];
  return {
    id: crypto.randomUUID(),
    label: moved.length > 1 ? `移动 ${moved.length} 个节目` : '移动节目',
    execute(project) {
      const order = reorderedVisibleIds(visible, moved, gap);
      if (!order) throw new Error('节目顺序没有变化');
      const slots = visible.map(id => project.rundown.findIndex(item => item.id === id));
      if (slots.some(slot => slot < 0)) throw new Error('节目单已经变了，请重新拖动');
      slots.sort((left, right) => left - right);
      const next = structuredClone(project);
      const byId = new Map(project.rundown.map(item => [item.id, item]));
      order.forEach((id, index) => { next.rundown[slots[index]!] = structuredClone(byId.get(id)!); });
      next.updatedAt = new Date().toISOString();
      return parseLinkProject(next);
    },
    undo(before) { return parseLinkProject(before); }
  };
}
