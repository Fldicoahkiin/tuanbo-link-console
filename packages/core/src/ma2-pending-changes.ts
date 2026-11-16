import { snapshotMa2LightingBinding } from './ma2-lighting-snapshot';
import type { LightingDocument, LinkProject, Ma2SyncObject } from '@tb/schema';
import { unboundMa2Tracks } from './ma2-track-routing';

export type Ma2PendingChange = {
  itemId: string; title: string; bindingId: string; target: number;
  changes: Array<{ id: string; before: Ma2SyncObject | null; after: Ma2SyncObject | null }>;
  error: string | null;
};
type BindingChange = Omit<Ma2PendingChange, 'itemId' | 'title'>;

/**
 * Kept per song lighting: commands give a new lighting object only to the song they change and the
 * store shares the rest (shareProjectStructure), so an edit compares that one song again. The song's
 * id and title are added when the project's list is put together, so a rename compares nothing.
 */
const bySong = new WeakMap<LightingDocument, readonly BindingChange[]>();
/** One list per project snapshot, so asking again for the same snapshot gives the same array. */
const byProject = new WeakMap<LinkProject, readonly Ma2PendingChange[]>();

/** Derived from the persisted baseline, so undo, redo and reopening need no second queue. */
export function ma2PendingChanges(project: LinkProject | null): readonly Ma2PendingChange[] {
  if (!project) return [];
  const known = byProject.get(project);
  if (known) return known;
  const result = project.rundown.flatMap(item => item.lighting
    ? songChanges(item.lighting).map(change => ({ itemId: item.id, title: item.title, ...change }))
    : []);
  byProject.set(project, result);
  return result;
}

function songChanges(lighting: LightingDocument): readonly BindingChange[] {
  const known = bySong.get(lighting);
  if (known) return known;
  const result = (lighting.ma2Bindings ?? []).flatMap((binding): BindingChange[] => {
    const entry = { bindingId: binding.id, target: binding.timecode };
    try {
      const { base, local } = snapshotMa2LightingBinding(lighting, binding.id, { consoleVersion: 'pending', baselineRevision: 'baseline', localRevision: 'local' });
      const before = new Map(base.objects.map(object => [object.id, object]));
      const after = new Map(local.objects.map(object => [object.id, object]));
      const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap(id => {
        const left = before.get(id) ?? null; const right = after.get(id) ?? null;
        return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ id, before: left, after: right }];
      });
      return changes.length ? [{ ...entry, changes, error: null }] : [];
    } catch (error) { return [{ ...entry, changes: [], error: error instanceof Error ? error.message : String(error) }]; }
  });
  const unbound = unboundMa2Tracks(lighting);
  const target = lighting.ma2Bindings?.[0];
  if (unbound.length && target) result.push({ bindingId: target.id, target: target.timecode, changes: [], error: `还有 ${unbound.length} 条灯光轨道没有确定控台位置（${unbound.map(track => track.name).join('、')}）。请在控台同步中关联这些轨道的执行器；这些 Cue 尚未写入控台` });
  bySong.set(lighting, result);
  return result;
}
