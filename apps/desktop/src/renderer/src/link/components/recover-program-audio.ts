import { editReferenceAudioCommand, replaceReferenceMediaClipCommand, timecodeToMilliseconds, type LinkCommand } from '@tb/core/link';
import { referenceAudioSchema, referenceAudioSourceSchema, type AudioTrack } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

/** Explicit playback of an old video-only programme can recover its missing
 * sound. Muted/detached clips are excluded so deleting audio remains permanent. */
export async function recoverProgramAudio(itemId: string): Promise<void> {
  const before = useDocumentStore.getState();
  const { project, path, documentId, revision } = before;
  const item = project?.rundown.find(entry => entry.id === itemId);
  if (!project || !item) throw new Error('节目已不存在');
  if (item.referenceAudio) return;
  if (!path) throw new Error('请先保存工程，再提取视频原声');
  if (useRuntimeStore.getState().state !== 'idle') throw new Error('请停止播放后恢复视频原声');
  const clips = item.referenceMediaClips.filter(clip => clip.embeddedAudioEnabled !== false && project.mediaAssets.some(asset => asset.id === clip.assetId && asset.kind === 'video'));
  if (!clips.length) throw new Error('该节目没有音频，也没有可恢复原声的视频。请添加音频或重新拖入视频；已删除或关闭的原声不会自动恢复。');
  const directory = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const tracks: AudioTrack[] = [];
  const mutedClips: LinkCommand[] = [];
  for (const clip of clips) {
    const asset = project.mediaAssets.find(entry => entry.id === clip.assetId)!;
    if (!asset.durationMs) throw new Error(`无法读取视频时长：${asset.name}`);
    try { await desktop.ensureMediaAudioUrl({ projectPath: path, relativePath: asset.relativePath, sha256: asset.sha256, kind: asset.kind }); }
    catch (error) { if (error instanceof Error && error.message.includes('素材不包含音频轨道')) continue; throw error; }
    const source = referenceAudioSourceSchema.parse(await desktop.importReferenceAudio({ projectPath: path, sourcePath: directory + asset.relativePath, durationMs: asset.durationMs }));
    const sourceOffsetMs = Math.round(clip.sourceOffsetMs ?? 0);
    const durationMs = Math.floor(Math.min(clip.durationMs, source.durationMs - sourceOffsetMs));
    if (durationMs <= 0) throw new Error(`视频片段已超出原声音频范围：${asset.name}`);
    tracks.push({ id: crypto.randomUUID(), title: `${asset.name} · 原声`, source, segments: [{ id: crypto.randomUUID(), startMs: Math.round(timecodeToMilliseconds(clip.startTimecode, project.timebase.frameRate)), sourceOffsetMs, durationMs }] });
    mutedClips.push(replaceReferenceMediaClipCommand(itemId, { ...clip, embeddedAudioEnabled: false }));
  }
  if (!tracks.length) throw new Error('该节目的视频不包含可用原声，请添加歌曲音频');
  const audio = referenceAudioSchema.parse(await desktop.renderAudioSegments({ projectPath: path, source: tracks[0]!.source, segments: tracks[0]!.segments, tracks }));
  if (!audio.timeline?.tracks) throw new Error('当前后台仍是旧版本，请保存工程并重新启动软件后恢复音轨');
  const current = useDocumentStore.getState();
  if (current.documentId !== documentId || current.revision !== revision) throw new Error('恢复期间工程已修改，已取消写入，请重新点击播放');
  if (useRuntimeStore.getState().state !== 'idle') throw new Error('恢复期间已开始播放，已取消写入');
  const command = editReferenceAudioCommand(itemId, audio, '恢复已有视频的独立原声音轨');
  current.executeForDocument(documentId, { ...command, execute: value => command.execute(mutedClips.reduce((next, mute) => mute.execute(next), value)) });
}
