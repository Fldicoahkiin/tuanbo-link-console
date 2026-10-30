import { snapshotMa2LightingBinding } from './ma2-lighting-snapshot';
import type { LinkProject, Ma2SyncObject } from '@tb/schema';

export type Ma2PendingChange = {
  itemId: string; title: string; bindingId: string; target: number;
  changes: Array<{ id: string; before: Ma2SyncObject | null; after: Ma2SyncObject | null }>;
  error: string | null;
};

const computed = new WeakMap<LinkProject, readonly Ma2PendingChange[]>();

/**
 * Derived from the persisted baseline, so undo, redo and reopening need no second queue. Kept per
 * project snapshot: commands produce a new project, so one snapshot always gives the same answer
 * and asking once per song costs one pass over the project.
 */
export function ma2PendingChanges(project: LinkProject | null): readonly Ma2PendingChange[] {
  if (!project) return [];
  const known = computed.get(project);
  if (known) return known;
  const result = project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).flatMap((binding): Ma2PendingChange[] => {
    if (!item.lighting) return [];
    const entry = { itemId: item.id, title: item.title, bindingId: binding.id, target: binding.timecode };
    try {
      const { base, local } = snapshotMa2LightingBinding(item.lighting, binding.id, { consoleVersion: 'pending', baselineRevision: 'baseline', localRevision: 'local' });
      const before = new Map(base.objects.map(object => [object.id, object]));
      const after = new Map(local.objects.map(object => [object.id, object]));
      const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap(id => {
        const left = before.get(id) ?? null; const right = after.get(id) ?? null;
        return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ id, before: left, after: right }];
      });
      return changes.length ? [{ ...entry, changes, error: null }] : [];
    } catch (error) { return [{ ...entry, changes: [], error: error instanceof Error ? error.message : String(error) }]; }
  }));
  computed.set(project, result);
  return result;
}
