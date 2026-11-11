import { beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingDocument, type LightingTrack, type LinkProject } from '@tb/schema';
import { snapshotMa2LightingBinding } from './ma2-lighting-snapshot';
import { ma2PendingChanges } from './ma2-pending-changes';
import { setLightingCommand } from './lighting-edit';

vi.mock('./ma2-lighting-snapshot', async importOriginal => {
  const actual = await importOriginal<typeof import('./ma2-lighting-snapshot')>();
  return { ...actual, snapshotMa2LightingBinding: vi.fn(actual.snapshotMa2LightingBinding) };
});
const snapshots = vi.mocked(snapshotMa2LightingBinding);
beforeEach(() => { snapshots.mockClear(); });

const track = (at: number): LightingTrack => ({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
  clips: [{ id: 'clip', name: '原编排', start: 0, duration: 40_000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at, sequence: 1, executor: '1.101', cue: '1', action: 'goto', label: '开场' }] }] });

/** A song holding the Cues of console Timecode `timecode`, edited locally when `editedAt` differs from 0. */
function lighting(timecode: number, editedAt = 0): LightingDocument {
  const value = createLightingDocument(); value.tracks = [track(editedAt)];
  value.ma2Bindings = [{ id: `binding-${timecode}`, timecode, name: `灯光 ${timecode}`, readAt: '2026-10-28T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(0)], mappings: [], playback: 'editable', timeOriginMs: 0 }];
  return value;
}
const song = (id: string, value: LightingDocument) => ({ id, title: `歌曲${id}`, enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: value });

function project(): LinkProject {
  const value = createEmptyLinkProject('待同步缓存'); value.schemaVersion = 2;
  value.rundown = [song('甲', lighting(7, 500)), song('乙', lighting(8)), song('丙', lighting(9, 800))];
  return value;
}
/** What a command and the store's structure sharing give: the other songs keep their objects. */
function withSong(value: LinkProject, itemId: string, patch: Partial<LinkProject['rundown'][number]>): LinkProject {
  return { ...value, rundown: value.rundown.map(item => item.id === itemId ? { ...item, ...patch } : item) };
}

it('同一工程快照只算一次，逐首查询不再每次整工程重算；命令生成的新快照重新计算', () => {
  const value = createEmptyLinkProject('待同步缓存');
  value.rundown = [{ id: 'song', title: '歌', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() }];
  const first = ma2PendingChanges(value);
  expect(ma2PendingChanges(value)).toBe(first);
  const next = setLightingCommand('song', createLightingDocument()).execute(value);
  expect(ma2PendingChanges(next)).not.toBe(first);
});

it('改一首歌只重算这一首，其余的歌用上次的结果', () => {
  const before = project();
  expect(ma2PendingChanges(before).map(change => change.itemId)).toEqual(['甲', '丙']);
  expect(snapshots).toHaveBeenCalledTimes(3);
  snapshots.mockClear();
  const edited = withSong(before, '乙', { lighting: lighting(8, 300) });
  expect(ma2PendingChanges(edited).map(change => change.itemId)).toEqual(['甲', '乙', '丙']);
  expect(snapshots).toHaveBeenCalledTimes(1);
  expect(snapshots.mock.calls[0]?.[1]).toBe('binding-8');
});

it('撤销后结果和改之前一样，不用重算', () => {
  const before = project();
  const original = ma2PendingChanges(before);
  const edited = withSong(before, '甲', { lighting: lighting(7) });
  expect(ma2PendingChanges(edited).map(change => change.itemId)).toEqual(['丙']);
  snapshots.mockClear();
  const undone = withSong(edited, '甲', { lighting: before.rundown[0]!.lighting! });
  expect(ma2PendingChanges(undone)).toEqual(original);
  expect(snapshots).not.toHaveBeenCalled();
  // An undo that gives a copy of the old lighting compares again and answers the same.
  expect(ma2PendingChanges(withSong(edited, '甲', { lighting: structuredClone(before.rundown[0]!.lighting!) }))).toEqual(original);
});

it('只改歌名：结果里的歌名跟着变，不重算', () => {
  const before = project();
  ma2PendingChanges(before);
  snapshots.mockClear();
  const renamed = withSong(before, '甲', { title: '新歌名' });
  expect(ma2PendingChanges(renamed).find(change => change.itemId === '甲')).toMatchObject({ title: '新歌名', target: 7, error: null });
  expect(snapshots).not.toHaveBeenCalled();
});
