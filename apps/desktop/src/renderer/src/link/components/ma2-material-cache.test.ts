import { beforeEach, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, serializeLinkProject, type Ma2EffectLibrary } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { loadMa2MaterialCache, rememberMa2MaterialCache } from './ma2-material-cache';

const library: Ma2EffectLibrary = { directory: { show: '测试 Show', generation: 'session', version: '3.7.0.5', entries: [{ target: 36, name: '控台原名' }] }, sequences: [{ sequence: 36, name: '控台原名', cues: [{ index: 1, number: '1.100', name: '第一步' }, { index: 2, number: '2.000', name: '第二步' }] }], fixtureUsage: [], fixtureDetails: 'unavailable', errors: [], readAt: '2026-10-05T00:00:00.000Z' };
beforeEach(() => useDocumentStore.getState().setProject(createEmptyLinkProject('素材缓存'), null));

it('未选素材也保存完整序列目录，序列化重开保留原名和小数编号', () => {
  const original = useDocumentStore.getState().project!;
  rememberMa2MaterialCache(original.projectId, { dataDirectory: '' }, library);
  const saved = useDocumentStore.getState().project!;
  expect(saved.schemaVersion).toBe(2);
  useDocumentStore.getState().setProject(parseLinkProject(JSON.parse(serializeLinkProject(saved))), 'saved.tblink');
  expect(loadMa2MaterialCache(original.projectId)?.library).toEqual(library);
});

it('切换工程拒绝迟到结果，同名 Show 不同会话不混用素材', () => {
  const original = useDocumentStore.getState().project!;
  rememberMa2MaterialCache(original.projectId, { dataDirectory: '' }, library);
  const saved = useDocumentStore.getState().project!;
  useDocumentStore.getState().setProject(createEmptyLinkProject('其他工程'), null);
  expect(() => rememberMa2MaterialCache(original.projectId, { dataDirectory: '' }, library)).toThrow('工程已切换');
  expect(loadMa2MaterialCache(original.projectId)).toBeNull();
  saved.ma2ReadState = { source: '本机 onPC', catalog: { directory: { ...library.directory, generation: 'new-session' }, readAt: library.readAt, entries: [] }, pairs: {}, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' };
  useDocumentStore.getState().setProject(saved, 'saved.tblink');
  expect(loadMa2MaterialCache(original.projectId)).toBeNull();
});

it('新读取素材目录不会被较早的时间线会话缓存屏蔽', () => {
  const project = useDocumentStore.getState().project!;
  project.schemaVersion = 2;
  project.ma2ReadState = { source: '本机 onPC', catalog: { directory: { ...library.directory, generation: 'old-session' }, readAt: '2026-10-04T00:00:00.000Z', entries: [] }, pairs: {}, failures: [], selectedTarget: null, query: '', filter: 'all', message: '' };
  useDocumentStore.getState().setProject(project, 'saved.tblink');
  rememberMa2MaterialCache(project.projectId, { dataDirectory: '' }, library);
  expect(loadMa2MaterialCache(project.projectId)?.library).toEqual(library);
  expect(useDocumentStore.getState().project?.ma2ReadState?.catalog.directory.generation).toBe('old-session');
});
