import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { showRestoredFiles } from './MissingAssetsDialog';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
afterEach(() => { useDocumentStore.getState().setProject(null, null); });

it('找回素材后重新载入当前工程：未保存修改和已写入控台的标记都保留', () => {
  const project = createEmptyLinkProject('找回后刷新');
  useDocumentStore.getState().setProject(project, 'show.tblink', { restored: true });
  const before = useDocumentStore.getState();
  before.markConsoleSynced(before.documentId);
  expect(showRestoredFiles(before.documentId, 'show.tblink')).toBe(true);
  const after = useDocumentStore.getState();
  expect(after.documentId).toBe(before.documentId + 1);
  expect(after.project).toEqual(before.project);
  expect(after).toMatchObject({ path: 'show.tblink', dirty: true, consoleSynced: true });
});

it('找回素材后已无未保存修改的工程重新载入后仍是已保存状态；工程已切换时不动', () => {
  useDocumentStore.getState().setProject(createEmptyLinkProject('已保存'), 'show.tblink');
  const opened = useDocumentStore.getState();
  opened.markSaved('show.tblink', opened.stateId, opened.documentId);
  const { documentId } = useDocumentStore.getState();
  expect(useDocumentStore.getState().dirty).toBe(false);
  expect(showRestoredFiles(documentId, 'show.tblink')).toBe(true);
  expect(useDocumentStore.getState()).toMatchObject({ dirty: false, consoleSynced: false });
  const current = useDocumentStore.getState().documentId;
  expect(showRestoredFiles(documentId, 'show.tblink')).toBe(false);
  expect(showRestoredFiles(current, 'other.tblink')).toBe(false);
  expect(useDocumentStore.getState().documentId).toBe(current);
});
