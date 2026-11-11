import { z } from 'zod';
import { ITEMS_CHANGE_LIMITS, linkProjectSchema, rundownItemSchema, validateLinkProjectRelations, type LinkProject, type NativeProgramItemsChange, type RundownItem } from '@tb/schema';

/**
 * A version of the window's project as an increment on the one before it (0.5.9 S9, design 02 §3.3, §3.7). The window
 * finds what changed by reference: the document store keeps every branch an edit did not touch (shareProjectStructure),
 * so a song that is the same object is the same song. The program puts the increment on the version it has, and the
 * result is what the whole document would have given: each changed song through `rundownItemSchema`, the rest of the
 * project through the project's own fields, then `validateLinkProjectRelations` over the whole project (ids, cues and
 * clips against the media and the other songs), as `parseLinkProject` does for a whole document.
 */

type ProjectShell = Omit<LinkProject, 'rundown'>;
/** The project's own fields, parsed as the whole project parses them; the relations are checked on the whole project. */
const projectShellSchema = z.object(linkProjectSchema.shape).omit({ rundown: true });


/** What changed from `before` to `after`; null when it does not fit an increment (ITEMS_CHANGE_LIMITS: many songs
 * changed, or one very large song): the whole document goes then. */
export function projectItemsChange(before: LinkProject, after: LinkProject): NativeProgramItemsChange | null {
  const previous = new Map(before.rundown.map(item => [item.id, item]));
  const changed = after.rundown.filter(item => previous.get(item.id) !== item);
  const kept = new Set(after.rundown.map(item => item.id));
  const removed = before.rundown.filter(item => !kept.has(item.id)).map(item => item.id);
  if (changed.length > ITEMS_CHANGE_LIMITS.songs || removed.length > ITEMS_CHANGE_LIMITS.songs) return null;
  // The program keeps its own order with the removed songs left out unless told another (applyProjectItemsChange).
  const remaining = before.rundown.filter(item => kept.has(item.id));
  const sameOrder = remaining.length === after.rundown.length && after.rundown.every((item, index) => remaining[index]!.id === item.id);
  if (!sameOrder && after.rundown.length > ITEMS_CHANGE_LIMITS.order) return null;
  const shellChanged = shellKeys(before, after).some(key => before[key] !== after[key]);
  const items = changed.map(item => JSON.stringify(item)), shell = shellChanged ? JSON.stringify(shellOf(after)) : undefined;
  if (items.some(item => item.length > ITEMS_CHANGE_LIMITS.songLength) || (shell?.length ?? 0) > ITEMS_CHANGE_LIMITS.shellLength) return null;
  return {
    kind: 'items', items, removed,
    ...(sameOrder ? {} : { order: after.rundown.map(item => item.id) }),
    ...(shell === undefined ? {} : { shell })
  };
}

/** `base` with `change` on it, checked as a whole document is. Throws when the change does not fit `base`. */
export function applyProjectItemsChange(base: LinkProject, change: NativeProgramItemsChange): LinkProject {
  const songs = new Map(base.rundown.map(item => [item.id, item]));
  const changed = new Set<string>();
  for (const text of change.items) {
    const item: RundownItem = rundownItemSchema.parse(JSON.parse(text));
    if (changed.has(item.id)) throw new Error(`这一版里同一首歌出现了两次：${item.id}`);
    changed.add(item.id); songs.set(item.id, item);
  }
  for (const id of change.removed) {
    if (changed.has(id) || !songs.delete(id)) throw new Error(`这一版要删掉的歌节目这边没有：${id}`);
  }
  const order = change.order ?? base.rundown.map(item => item.id).filter(id => songs.has(id));
  if (order.length !== songs.size || new Set(order).size !== order.length || order.some(id => !songs.has(id))) {
    throw new Error('这一版的歌曲顺序和歌曲对不上');
  }
  const shell: ProjectShell = change.shell === undefined ? shellOf(base) : projectShellSchema.parse(JSON.parse(change.shell));
  const project: LinkProject = { ...shell, rundown: order.map(id => songs.get(id)!) };
  validateLinkProjectRelations(project);
  return project;
}

function shellOf(project: LinkProject): ProjectShell {
  const { rundown, ...shell } = project;
  void rundown;
  return shell;
}
function shellKeys(before: LinkProject, after: LinkProject): (keyof ProjectShell)[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete('rundown');
  return [...keys].filter((key): key is keyof ProjectShell => key in projectShellSchema.shape);
}
