import { beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type Ma2TimecodePreview } from '@tb/schema';
import { reconcileMa2ReadState, setLightingCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { useShowStateStore } from '../stores/show-state-store';
import { selectMa2Timeline } from './ma2-timeline-actions';

vi.hoisted(() => { vi.stubGlobal('window', { tbLink: {} }); vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined }); });
const { archive } = vi.hoisted(() => ({ archive: vi.fn<() => Promise<string | null>>() }));
vi.mock('./ma2-project-archive', () => ({ archiveMa2Project: archive }));

beforeEach(() => {
  vi.stubGlobal('window', { tbLink: { getMa2NetworkStatus: () => Promise.resolve({ state: 'disconnected' }) } });
  archive.mockReset().mockResolvedValue('C:/archive.tblink');
  useShowStateStore.setState({ show: { phase: 'idle', program: null } });
  useMa2SyncStore.setState({ songs: {} });
  const project = createEmptyLinkProject('选择时间线');
  const lighting = createLightingDocument();
  lighting.tracks = [{ id: 'local', name: '原编排', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [] }];
  project.schemaVersion = 2;
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting,
    referenceAudio: { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10000 } }];
  const preview: Ma2TimecodePreview = { target: 10, name: '控台时间线', readAt: '2026-11-16T00:00:00Z', sourceXml: '<MA/>', document: createLightingDocument(), mappings: [], warnings: [], unconverted: [], timeOriginMs: 60000 };
  project.ma2ReadState = reconcileMa2ReadState(project, 'console', { directory: { show: 'Show', generation: '1', version: '3.7.0.5', entries: [{ target: 10, name: preview.name }] }, readAt: preview.readAt,
    entries: [{ target: 10, name: preview.name, eventCount: 0, frameFormat: '30 FPS', offset: '1800', slot: 'TC Slot 2', events: [], error: null, warnings: [], preview }] });
  useDocumentStore.getState().setProject(project, 'song.tblink');
});

it('替换先保存完整旧编排，再以一条可撤销的命令更换', async () => {
  const before = useDocumentStore.getState().project;
  await selectMa2Timeline('song', 10);
  expect(archive).toHaveBeenCalledWith(useDocumentStore.getState().documentId, before, 'manual');
  expect(useDocumentStore.getState().project?.rundown[0]?.lighting?.ma2Bindings?.map(binding => binding.timecode)).toEqual([10]);
  useDocumentStore.getState().undo();
  expect(useDocumentStore.getState().project).toEqual(before);
});

it.each([null, new Error('磁盘已满')])('存档未完成不替换，也不创建撤销记录：%s', async result => {
  if (result instanceof Error) archive.mockRejectedValue(result); else archive.mockResolvedValue(result);
  const before = useDocumentStore.getState().project;
  await expect(selectMa2Timeline('song', 10)).rejects.toThrow();
  expect(useDocumentStore.getState().project).toBe(before);
  expect(useDocumentStore.getState().past).toHaveLength(0);
});

it('等待存档时用户修改工程，不用旧快照覆盖刚改的内容', async () => {
  archive.mockImplementation(() => {
    const lighting = structuredClone(useDocumentStore.getState().project!.rundown[0]!.lighting!);
    lighting.tracks[0]!.name = '用户刚改的名字';
    useDocumentStore.getState().execute(setLightingCommand('song', lighting, '改名'));
    return Promise.resolve('C:/archive.tblink');
  });
  await expect(selectMa2Timeline('song', 10)).rejects.toThrow('存档期间工程有变化');
  expect(useDocumentStore.getState().project?.rundown[0]?.lighting?.tracks[0]?.name).toBe('用户刚改的名字');
  expect(useDocumentStore.getState().project?.rundown[0]?.lighting?.ma2Bindings ?? []).toEqual([]);
});

it('存档期间开始播放，停止更换且保留原编排', async () => {
  const before = useDocumentStore.getState().project;
  archive.mockImplementation(() => {
    useShowStateStore.setState({ show: { phase: 'running', source: 'internal', itemId: 'song', program: null } });
    return Promise.resolve('C:/archive.tblink');
  });
  await expect(selectMa2Timeline('song', 10)).rejects.toThrow();
  expect(useDocumentStore.getState().project).toBe(before);
});
