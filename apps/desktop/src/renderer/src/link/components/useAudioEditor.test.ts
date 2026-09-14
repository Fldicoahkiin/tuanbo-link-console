import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useAudioEditor, type AudioEditor } from './useAudioEditor';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
afterEach(() => { useRuntimeStore.getState().reset(); useDocumentStore.getState().setProject(null, null); });

it('暂停状态允许应用和清除节拍标记，同时保留音频编辑保护', async () => {
  const project = createEmptyLinkProject('暂停节拍测试');
  project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', durationMs: 5000, sha256: 'a'.repeat(64),
      beats: { sourceSha256: 'a'.repeat(64), level: 'standard', pointsMs: [500, 1000] } } });
  useDocumentStore.getState().setProject(project, 'test.tblink');
  useRuntimeStore.getState().setState({ state: 'paused' });
  const notify = vi.fn();
  const editor = (): AudioEditor => {
    const result: AudioEditor[] = [];
    function Harness() {
      result.push(useAudioEditor(useDocumentStore.getState().project!.rundown[0]!, 'test.tblink', true, notify));
      return null;
    }
    renderToString(createElement(Harness));
    return result[0]!;
  };
  await editor().mark();
  expect(notify).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().past.at(-1)?.command.label).toBe('应用音频节拍标记');
  await editor().clearMarks();
  expect(useDocumentStore.getState().project!.rundown[0]!.referenceAudio?.beats).toBeUndefined();
  expect(useRuntimeStore.getState().state).toBe('paused');
  const revision = useDocumentStore.getState().revision;
  await editor().split(2000);
  expect(notify).toHaveBeenCalledWith('请停止播放后应用音频修改', 'error');
  expect(useDocumentStore.getState().revision).toBe(revision);
});
