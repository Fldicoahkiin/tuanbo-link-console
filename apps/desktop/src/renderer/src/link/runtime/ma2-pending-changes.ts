import { snapshotMa2LightingBinding } from '@tb/core/link';
import type { LinkProject, Ma2SyncObject } from '@tb/schema';

export type Ma2PendingChange = {
  itemId: string; title: string; bindingId: string; target: number;
  changes: Array<{ id: string; before: Ma2SyncObject | null; after: Ma2SyncObject | null }>;
  error: string | null;
};

/** Derived from the persisted baseline, so undo, redo and reopening need no second queue. */
export function ma2PendingChanges(project: LinkProject | null): Ma2PendingChange[] {
  return project?.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).flatMap((binding): Ma2PendingChange[] => {
    if (!item.lighting || binding.nativeEvents?.length || binding.playback === 'native-timecode') return [];
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
  })) ?? [];
}
