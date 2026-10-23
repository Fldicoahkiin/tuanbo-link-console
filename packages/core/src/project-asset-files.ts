import type { LinkMediaKind, LinkProject } from '@tb/schema';

/** A file the project keeps inside its own folder, addressed by a path relative to the .tblink. */
export type ProjectAssetFile = { relativePath: string; sha256: string; label: string };

/** Extensions the software imports as song audio, into assets/reference-audio. */
export const REFERENCE_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.wav']);
/** Extensions the software imports as media of each kind, into assets/reference-media. */
export const MEDIA_EXTENSIONS: Readonly<Record<LinkMediaKind, ReadonlySet<string>>> = {
  audio: REFERENCE_AUDIO_EXTENSIONS,
  video: new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']),
  image: new Set(['.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp'])
};
const ASSET_FOLDER_EXTENSIONS = new Map<string, ReadonlySet<string>>([
  ['reference-audio', REFERENCE_AUDIO_EXTENSIONS],
  ['reference-media', new Set(Object.values(MEDIA_EXTENSIONS).flatMap(extensions => [...extensions]))]
]);

/** A file the software keeps in a project's own asset folders: `assets/reference-audio/<file>`
 * or `assets/reference-media/<file>` with an extension it imports. Only these are checked and restored. */
export function isProjectAssetPath(relativePath: string): boolean {
  const [root, folder, name, ...deeper] = relativePath.split('/');
  const extensions = folder === undefined ? undefined : ASSET_FOLDER_EXTENSIONS.get(folder);
  if (root !== 'assets' || !extensions || name === undefined || deeper.length > 0 || name.includes('\\')) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && extensions.has(name.slice(dot).toLowerCase());
}

/** Every file a project references, once per relative path, whatever the path:
 * song audio, the sources behind an edited song, and imported media. */
export function projectFileReferences(project: LinkProject): ProjectAssetFile[] {
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

/** The referenced files kept in the asset folders; paths of hand-written projects are left out. */
export function projectAssetFiles(project: LinkProject): ProjectAssetFile[] {
  return projectFileReferences(project).filter(file => isProjectAssetPath(file.relativePath));
}

const MEDIA_KIND_LABELS: Record<LinkMediaKind, string> = { audio: '音频素材', video: '视频素材', image: '图片素材' };
