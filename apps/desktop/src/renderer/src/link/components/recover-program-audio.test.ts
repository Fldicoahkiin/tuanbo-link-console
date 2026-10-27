import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type AudioTrack } from '@tb/schema';
import { setReferenceAudioCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { recoverProgramAudio } from './recover-program-audio';

const bridge = vi.hoisted(() => ({ ensureMediaAudioUrl: vi.fn(), importReferenceAudio: vi.fn(), renderAudioSegments: vi.fn() }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: bridge }));
afterEach(() => { vi.resetAllMocks(); useRuntimeStore.getState().reset(); useDocumentStore.getState().setProject(null, null); });

function fixture(muted = false): void {
  const project = parseLinkProject({ ...createEmptyLinkProject('旧工程'), playbackSource: 'internal', obsOutputMode: 'scenes', mediaAssets: [{ id: 'video', kind: 'video', name: '旧视频.mp4', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 100, durationMs: 10000, width: 448, height: 960 }], rundown: [{ id: 'song', title: '节目 4', referenceMediaClips: [{ id: 'clip', assetId: 'video', label: '旧视频', startTimecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 }, sourceOffsetMs: 1000, durationMs: 5000, ...(muted ? { embeddedAudioEnabled: false } : {}) }], cues: [] }] });
  useDocumentStore.getState().setProject(project, 'C:/show/project.tblink');
  bridge.ensureMediaAudioUrl.mockResolvedValue('audio-url');
  const source = { assetId: 'audio', relativePath: 'assets/source.wav', sha256: 'b'.repeat(64), durationMs: 10000 };
  bridge.importReferenceAudio.mockResolvedValue(source);
  bridge.renderAudioSegments.mockImplementation(({ tracks }: { tracks: AudioTrack[] }) => {
    const audio = { ...source, durationMs: Math.max(...tracks.flatMap(track => track.segments.map(segment => segment.startMs + segment.durationMs))) };
    return Promise.resolve({ ...audio, timeline: { source: audio, segments: [{ id: 'mix', startMs: 0, sourceOffsetMs: 0, durationMs: audio.durationMs }], tracks } });
  });
}

it('旧节目的视频恢复独立原声，保留位置和裁剪，单次撤销恢复原工程', async () => {
  fixture(); const before = useDocumentStore.getState().project;
  await recoverProgramAudio('song');
  const item = useDocumentStore.getState().project!.rundown[0]!;
  expect(item.referenceAudio?.timeline?.tracks?.[0]?.segments[0]).toMatchObject({ startMs: 2000, sourceOffsetMs: 1000, durationMs: 5000 });
  expect(item.referenceAudio?.durationMs).toBe(7000);
  expect(item.referenceMediaClips[0]?.embeddedAudioEnabled).toBe(false);
  useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project).toEqual(before);
});
it('不自动复活用户已删除的音轨', async () => {
  fixture(true);
  await expect(recoverProgramAudio('song')).rejects.toThrow('已删除或关闭');
  expect(bridge.importReferenceAudio).not.toHaveBeenCalled();
  fixture(); await recoverProgramAudio('song');
  useDocumentStore.getState().execute(setReferenceAudioCommand('song', null));
  await expect(recoverProgramAudio('song')).rejects.toThrow('已删除或关闭');
});
it('无声视频不伪造音轨，后端旧协议不写入不完整多轨结果', async () => {
  fixture(); bridge.ensureMediaAudioUrl.mockRejectedValueOnce(new Error('素材不包含音频轨道'));
  await expect(recoverProgramAudio('song')).rejects.toThrow('没有可用的声音');
  bridge.renderAudioSegments.mockResolvedValueOnce({ assetId: 'old', relativePath: 'assets/old.wav', sha256: 'c'.repeat(64), durationMs: 7000 });
  await expect(recoverProgramAudio('song')).rejects.toThrow('后台还是旧版本');
  expect(useDocumentStore.getState().project!.rundown[0]!.referenceAudio).toBeUndefined();
});
it('提取途中修改工程取消写入', async () => {
  fixture();
  bridge.renderAudioSegments.mockImplementationOnce(() => {
    useDocumentStore.getState().setProject(createEmptyLinkProject('其他工程'), 'C:/other.tblink');
    return Promise.resolve({ assetId: 'audio', relativePath: 'audio.wav', sha256: 'b'.repeat(64), durationMs: 10000, timeline: { source: { assetId: 'audio', relativePath: 'audio.wav', sha256: 'b'.repeat(64), durationMs: 10000 }, segments: [{ id: 'mix', startMs: 0, sourceOffsetMs: 0, durationMs: 10000 }], tracks: [{ id: 'track', title: '原声', source: { assetId: 'audio', relativePath: 'audio.wav', sha256: 'b'.repeat(64), durationMs: 10000 }, segments: [{ id: 'clip', startMs: 0, sourceOffsetMs: 0, durationMs: 10000 }] }] } });
  });
  await expect(recoverProgramAudio('song')).rejects.toThrow('工程被修改了');
  expect(useDocumentStore.getState().project!.name).toBe('其他工程');
});
