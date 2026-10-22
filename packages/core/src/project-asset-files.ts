import type { LinkMediaKind, LinkProject } from '@tb/schema';

/** A file the project keeps inside its own folder, addressed by a path relative to the .tblink. */
export type ProjectAssetFile = { relativePath: string; sha256: string; label: string };

/** Every file a project references, once per relative path: song audio, the
 * sources behind an edited song, and imported media. */
export function projectAssetFiles(project: LinkProject): ProjectAssetFile[] {
  const files = new Map<string, ProjectAssetFile>();
  const add = (file: { relativePath: string; sha256: string }, label: string): void => {
    if (!files.has(file.relativePath)) files.set(file.relativePath, { relativePath: file.relativePath, sha256: file.sha256, label });
  };
  for (const item of project.rundown) {
    const audio = item.referenceAudio;
    if (!audio) continue;
    add(audio, `歌曲音频 · ${item.title}`);
    if (!audio.timeline) continue;
    add(audio.timeline.source, `编辑前音频 · ${item.title}`);
    for (const track of audio.timeline.tracks ?? []) add(track.source, `音轨「${track.title}」 · ${item.title}`);
  }
  for (const asset of project.mediaAssets) add(asset, `${MEDIA_KIND_LABELS[asset.kind]} · ${asset.name}`);
  return [...files.values()];
}

const MEDIA_KIND_LABELS: Record<LinkMediaKind, string> = { audio: '音频素材', video: '视频素材', image: '图片素材' };
