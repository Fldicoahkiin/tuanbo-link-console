import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { ma2PendingChanges } from './ma2-pending-changes';
import { setLightingCommand } from './lighting-edit';

it('同一工程快照只算一次，逐首查询不再每次整工程重算；命令生成的新快照重新计算', () => {
  const project = createEmptyLinkProject('待同步缓存');
  project.rundown = [{ id: 'song', title: '歌', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() }];
  const first = ma2PendingChanges(project);
  expect(ma2PendingChanges(project)).toBe(first);
  const next = setLightingCommand('song', createLightingDocument()).execute(project);
  expect(ma2PendingChanges(next)).not.toBe(first);
});
