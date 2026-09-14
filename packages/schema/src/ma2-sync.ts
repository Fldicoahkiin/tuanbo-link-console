import { z } from 'zod';

// Normalized application data, not the MA2 XML or network wire format.
export const ma2SyncObjectSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['timecode', 'track', 'event', 'cue-reference']),
  parentId: z.string().min(1).nullable(),
  order: z.number().int().nonnegative(),
  properties: z.record(z.string(), z.string())
}).strict();

export const ma2SyncSnapshotSchema = z.object({
  bindingId: z.string().min(1),
  consoleVersion: z.string().min(1),
  revision: z.string().min(1),
  objects: z.array(ma2SyncObjectSchema)
}).strict().superRefine((snapshot, context) => {
  const byId = new Map(snapshot.objects.map((object) => [object.id, object]));
  if (byId.size !== snapshot.objects.length) {
    context.addIssue({ code: 'custom', message: 'MA2 同步对象 ID 重复', path: ['objects'] });
  }
  for (const [index, object] of snapshot.objects.entries()) {
    const visited = new Set([object.id]);
    let parentId = object.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        context.addIssue({ code: 'custom', message: 'MA2 同步对象层级循环', path: ['objects', index, 'parentId'] });
        break;
      }
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) {
        context.addIssue({ code: 'custom', message: 'MA2 同步对象父级不存在', path: ['objects', index, 'parentId'] });
        break;
      }
      parentId = parent.parentId;
    }
  }
});

export type Ma2SyncObject = z.infer<typeof ma2SyncObjectSchema>;
export type Ma2SyncSnapshot = z.infer<typeof ma2SyncSnapshotSchema>;
export const ma2SyncPreviewSchema = z.object({
  base: ma2SyncSnapshotSchema, local: ma2SyncSnapshotSchema, remote: ma2SyncSnapshotSchema,
  merged: z.array(ma2SyncObjectSchema),
  conflicts: z.array(z.object({ id: z.string().min(1), base: ma2SyncObjectSchema.nullable(), local: ma2SyncObjectSchema.nullable(), remote: ma2SyncObjectSchema.nullable() }).strict())
}).strict();
