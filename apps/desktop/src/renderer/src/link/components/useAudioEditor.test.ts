import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject } from '@tb/schema';
import { songBeats, songBeatsAtDensity } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useAudioEditor, type AudioEditor } from './useAudioEditor';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
afterEach(() => { useRuntimeStore.getState().reset(); useDocumentStore.getState().setProject(null, null); });

it('最后一条音轨可以删除，清空后可撤销恢复完整源信息', async () => {
  const project = createEmptyLinkProject('删除音轨');
  project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', durationMs: 5000, sha256: 'a'.repeat(64) } });
  useDocumentStore.getState().setProject(project, 'test.tblink');
  const before = useDocumentStore.getState().project;
  const notify = vi.fn();
  const result: AudioEditor[] = [];
  function Harness() { result.push(useAudioEditor(useDocumentStore.getState().project!.rundown[0]!, 'test.tblink', false, notify)); return null; }
  renderToString(createElement(Harness));
  await result[0]!.removeTrack(result[0]!.tracks[0]!.id);
  expect(notify).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().project!.rundown[0]!.referenceAudio).toBeUndefined();
  useDocumentStore.getState().undo();
  expect(useDocumentStore.getState().project).toEqual(before);
});

it('内部暂停会话先正常停止，再删除独立音轨，视频片段保持不变', async () => {
  const project = createEmptyLinkProject('暂停编辑');
  project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', durationMs: 5000, sha256: 'a'.repeat(64) } });
  useDocumentStore.getState().setProject(project, 'test.tblink');
  useRuntimeStore.getState().setState({ state: 'paused' });
  const stop = vi.fn(() => { useRuntimeStore.getState().setState({ state: 'idle' }); return Promise.resolve(); });
  const notify = vi.fn(); const result: AudioEditor[] = [];
  function Harness() { result.push(useAudioEditor(useDocumentStore.getState().project!.rundown[0]!, 'test.tblink', false, notify, stop)); return null; }
  renderToString(createElement(Harness));
  await result[0]!.removeTrack(result[0]!.tracks[0]!.id);
  expect(stop).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
  expect(useDocumentStore.getState().project!.rundown[0]!.referenceAudio).toBeUndefined();
  expect(useRuntimeStore.getState().state).toBe('idle');
});

it('打开旧工程后，编辑器的节拍来自歌上的那一份；暂停时照样保留音频编辑保护', async () => {
  const project = createEmptyLinkProject('暂停节拍测试');
  project.rundown.push({ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'audio', relativePath: 'audio.wav', durationMs: 5000, sha256: 'a'.repeat(64),
      beats: { sourceSha256: 'a'.repeat(64), level: 'standard', pointsMs: [500, 1000, 1500, 2000] } } });
  useDocumentStore.getState().setProject(project, 'test.tblink');
  const song = () => useDocumentStore.getState().project!.rundown[0]!;
  // Opening moved the old beats to the song, the one copy the lighting workspace reads too.
  expect(song().referenceAudio?.beats).toBeUndefined();
  expect(song().music?.method).toBe('ibt');
  expect(useDocumentStore.getState().dirty).toBe(true);
  useRuntimeStore.getState().setState({ state: 'paused' });
  const notify = vi.fn();
  const editor = (): AudioEditor => {
    const result: AudioEditor[] = [];
    function Harness() {
      result.push(useAudioEditor(song(), 'test.tblink', true, notify));
      return null;
    }
    renderToString(createElement(Harness));
    return result[0]!;
  };
  const beats = songBeats(song());
  expect(beats.state === 'ready' ? songBeatsAtDensity(beats.beats, 'standard').map(beat => beat.atMs) : []).toEqual(editor().points);
  expect(editor().points).toEqual([500, 1500]);
  // The editor has no beat detection of its own any more (0.5.9 E11): beats are recognised and cleared in the
  // 音乐识别 panel, the same as the lighting workbench's.
  expect(Object.keys(editor()).filter(key => ['analyze', 'mark', 'clearMarks', 'pendingBeats'].includes(key))).toEqual([]);
  const revision = useDocumentStore.getState().revision;
  await editor().split(2000);
  expect(notify).toHaveBeenCalledWith('请停止播放后编辑音频片段', 'error');
  expect(useDocumentStore.getState().revision).toBe(revision);
});
