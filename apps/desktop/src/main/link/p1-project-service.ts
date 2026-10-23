import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, opendir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode
} from '@xmldom/xmldom';
import {
  p1MediaBindingSchema,
  type LinkProject,
  type P1MediaBinding,
  type P1PlaylistBinding,
  type LinkP1ProjectImportProgress,
  type RundownItem
} from '@tb/schema';
import type {
  LinkP1ProjectExportPreview,
  LinkP1ProjectExportResult,
  LinkP1ProjectImportResult
} from '@tb/core/link';
import { writeFileAtomically } from './atomic-file';
import { validateP1TimecodeRanges, parseP1TimeOrigin, programTimeOrigin, REFERENCE_AUDIO_EXTENSIONS } from '@tb/core/link';
import { LinkProjectService, REFERENCE_AUDIO_CONTAINER_EXTENSIONS } from './link-project-service';

type ParsedP1Media = {
  element: XmlElement;
  resourcePath: string;
  sourceKey: string;
  occurrence: number;
  index: number;
  title: string;
};

type ParsedP1Playlist = {
  binding: P1PlaylistBinding;
  element: XmlElement;
  media: ParsedP1Media[];
};

type ParsedP1Project = {
  document: XmlDocument;
  sourcePath: string;
  sourceSha256: string;
  videoPlayList: XmlElement;
  audioPlayList: XmlElement | null;
  playlists: ParsedP1Playlist[];
};

type ExportPlan = {
  parsed: ParsedP1Project;
  targetPath: string;
  exportItems: RundownItem[];
  preview: LinkP1ProjectExportPreview;
};

export class P1ProjectService {
  constructor(private readonly projects: LinkProjectService) {}

  async importProject(p1ProjectPath: string, linkProjectPath: string, options: { signal?: AbortSignal; onProgress?: (progress: Omit<LinkP1ProjectImportProgress, 'id'>) => void } = {}): Promise<LinkP1ProjectImportResult> {
    const parsed = await this.parseProject(p1ProjectPath);
    const items: LinkP1ProjectImportResult['items'] = [];
    const skippedItems: NonNullable<LinkP1ProjectImportResult['skippedItems']> = [];
    let relocatedFiles: Promise<Map<string, string[]>> | null = null;
    const total = parsed.playlists.reduce((count, playlist) => count + playlist.media.length, 0);
    let completed = 0;
    options.signal?.throwIfAborted();
    options.onProgress?.({ completed, total, song: '', state: 'starting' });
    for (const playlist of parsed.playlists) {
      for (const media of playlist.media) {
        options.signal?.throwIfAborted();
        let state: 'imported' | 'skipped' = 'imported';
        try {
        requiredAttribute(media.element, 'mediaType', media.title);
        requiredAttribute(media.element, 'resourceFilePath', media.title);
        const binding = readMediaBinding(media.element, media.resourcePath, media.occurrence, playlist.binding.id, playlist.binding.name, media.index);
        parseP1TimeOrigin(binding.midiStartTime);
        let readablePath = media.resourcePath;
        // The .hia is the operator's, its song paths are not: check the text before touching the path.
        const refusal = songPathRefusal(media.element.getAttribute('resourceFilePath') ?? '', media.resourcePath, dirname(parsed.sourcePath));
        try { if (refusal) throw new Error(refusal); await access(readablePath, constants.R_OK); }
        catch {
          relocatedFiles ??= indexCopiedP1Media(dirname(parsed.sourcePath), options.signal);
          const matches = (await relocatedFiles).get(basename(media.resourcePath).toLocaleLowerCase()) ?? [];
          if (matches.length !== 1) throw new Error(matches.length ? `复制的歌曲目录中存在多个同名文件，无法确认“${media.title}”` : refusal ? `${refusal}；P1 工程文件夹中也没有同名文件` : `未找到“${media.title}”的歌曲文件；请把 P1 工程和歌曲文件夹一起复制到本机`);
          readablePath = matches[0]!;
        }
        const realSong = await realpath(readablePath);
        const realRefusal = songPathRefusal('', realSong, await realpath(dirname(parsed.sourcePath)));
        if (realRefusal) throw new Error(`“${media.title}”的实际文件：${realRefusal}`);
        const fileStat = await stat(readablePath);
        if (!fileStat.isFile() || fileStat.size <= 0) throw new Error(`音频文件为空或不是文件：${readablePath}`);
        const audio = await importP1Audio(this.projects, linkProjectPath, media, readablePath);
        items.push({
          title: media.title,
          ...audio,
          p1Media: { ...binding, ...(!audio.importNotes ? { sourceTrim: { startMs: Number(media.element.getAttribute('cut_start')) * 1000, endMs: Number(media.element.getAttribute('cut_end')) * 1000, applied: true } } : { importedFullSource: true }) }
        });
        } catch (error) {
          options.signal?.throwIfAborted();
          state = 'skipped';
          skippedItems.push({ sourceKey: media.sourceKey, title: media.title, playlistName: playlist.binding.name, playlistId: playlist.binding.id, reason: error instanceof Error ? error.message : String(error) });
        }
        completed += 1;
        options.onProgress?.({ completed, total, song: media.title, state });
      }
    }
    if (!items.length && !skippedItems.length) throw new Error('P1 工程中没有歌曲条目');
    return {
      skippedItems,
      sourceOrder: parsed.playlists.flatMap(playlist => playlist.media.map(media => media.sourceKey)),
      sourcePath: parsed.sourcePath,
      sourceSha256: parsed.sourceSha256,
      playlists: parsed.playlists.map((playlist) => playlist.binding),
      items
    };
  }

  async previewExport(
    p1ProjectPath: string,
    linkProjectPath: string,
    project: LinkProject
  ): Promise<LinkP1ProjectExportPreview> {
    return (await this.createExportPlan(p1ProjectPath, linkProjectPath, project)).preview;
  }

  async exportProject(
    p1ProjectPath: string,
    linkProjectPath: string,
    project: LinkProject,
    expectedSourceSha256: string
  ): Promise<LinkP1ProjectExportResult> {
    const plan = await this.createExportPlan(p1ProjectPath, linkProjectPath, project);
    if (plan.parsed.sourceSha256 !== expectedSourceSha256) {
      throw new Error('P1 工程在写回确认后发生变化，已停止写入；请重新预览');
    }
    const existingMedia = new Map(
      plan.parsed.playlists.flatMap((playlist) => playlist.media.map((media) => [media.sourceKey, media] as const))
    );
    const projectSync = project.p1Sync;
    if (!projectSync) throw new Error('当前联动工程尚未从 P1 导入，不能写回');
    const playlists = [...projectSync.playlists].sort((left, right) => left.sourceIndex - right.sourceIndex);
    const itemsByPlaylist = new Map(playlists.map((playlist) => [playlist.id, [] as RundownItem[]]));
    const defaultPlaylist = playlists[0];
    if (!defaultPlaylist) throw new Error('P1 同步来源没有播放列表');
    for (const item of plan.exportItems) {
      const playlistId = item.p1Media?.playlistId ?? defaultPlaylist.id;
      const list = itemsByPlaylist.get(playlistId);
      if (!list) throw new Error(`节目“${item.title}”引用不存在的 P1 播放列表：${playlistId}`);
      list.push(item);
    }

    const outputBindings: LinkP1ProjectExportResult['itemBindings'] = [];
    const emitted = new Map<XmlElement, LinkP1ProjectExportResult['itemBindings'][number]>();
    const protectedItems = new Map(projectSync.skippedItems?.map(item => [item.sourceKey, item]));
    const preserved = new Map<XmlElement, import('@tb/schema').P1ImportIssue>();
    const pathOccurrences = new Map<string, number>();
    const playlistElements: XmlElement[] = [];
    for (const playlist of playlists) {
      const sourcePlaylist = plan.parsed.playlists.find((candidate) => candidate.binding.id === playlist.id);
      const playlistElement = sourcePlaylist
        ? requireElement(sourcePlaylist.element.cloneNode(false), 'P1 播放列表')
        : plan.parsed.document.createElement('videoPlayElement');
      playlistElement.setAttribute('caption', playlist.name);
      if (!playlistElement.hasAttribute('type')) playlistElement.setAttribute('type', '0');
      for (const item of itemsByPlaylist.get(playlist.id) ?? []) {
        const existing = item.p1Media ? existingMedia.get(item.p1Media.sourceKey) : undefined;
        if (item.p1Media && !existing) {
          throw new Error(`P1 工程缺少已绑定音频“${item.title}”，请重新导入后再写回`);
        }
        if (!item.referenceAudio) throw new Error(`节目“${item.title}”没有参考音频，不能写入 P1`);
        const resourcePath = existing?.resourcePath
          ?? this.projects.resolveReferenceAudio(linkProjectPath, item.referenceAudio.relativePath);
        const element = existing
          ? requireElement(existing.element.cloneNode(true), 'P1 音频')
          : createMediaElement(plan.parsed.document, resourcePath, item.referenceAudio.durationMs);
        const occurrence = pathOccurrences.get(normalizePathKey(resourcePath)) ?? 0;
        pathOccurrences.set(normalizePathKey(resourcePath), occurrence + 1);
        const sourceKey = createSourceKey(resourcePath, occurrence);
        const binding = p1MediaBindingSchema.parse({
          sourceKey,
          playlistId: playlist.id,
          sourceFileName: basename(resourcePath),
          playEndAction: item.p1Media?.playEndAction ?? 'stop',
          volume: item.p1Media?.volume ?? 100,
          muted: item.p1Media?.muted ?? false,
          shortcut: item.p1Media?.shortcut ?? '',
          midiStartTime: project.p1AutoFollow?.enabled
            ? String(project.p1AutoFollow.ranges.find((range) => range.itemId === item.id)?.startSeconds ?? (() => { throw new Error(`缺少 P1 时间码区间：${item.title}`); })())
            : String(programTimeOrigin(item) / 1000)
        });
        if (item.p1Media?.importedFullSource) element.setAttribute('cut_start', '0');
        applyMediaBinding(element, resourcePath, item.title, item.referenceAudio.durationMs, binding);
        playlistElement.appendChild(element);
        const outputBinding = { itemId: item.id, p1Media: binding };
        outputBindings.push(outputBinding); emitted.set(element, outputBinding);
      }
      for (const media of sourcePlaylist?.media ?? []) {
        const issue = protectedItems.get(media.sourceKey);
        if (!issue) continue;
        const clone = requireElement(media.element.cloneNode(true), '未导入的 P1 条目');
        playlistElement.insertBefore(clone, directChildren(playlistElement, 'media')[media.index] ?? null);
        preserved.set(clone, issue);
      }
      playlistElements.push(playlistElement);
    }
    const skippedItems = reindexExportMedia(playlistElements, plan.parsed.sourcePath, emitted, preserved);

    replaceElementChildren(plan.parsed.videoPlayList, 'videoPlayElement', playlistElements);
    synchronizeAudioPlaylistNames(plan.parsed.document, plan.parsed.audioPlayList, playlists);
    const rootXml = new XMLSerializer().serializeToString(
      requireElement(plan.parsed.document.documentElement, 'P1 工程根节点'),
      {
        requireWellFormed: true
      }
    );
    const serialized = `<?xml version="1.0" encoding="UTF-8"?>\n${rootXml}\n`;
    await writeFileAtomically(plan.targetPath, serialized);
    const written = await readFile(plan.targetPath);
    return {
      outputPath: plan.targetPath,
      skippedItems,
      sourceSha256: sha256(written),
      playlists,
      itemBindings: outputBindings
    };
  }

  private async createExportPlan(
    p1ProjectPath: string,
    linkProjectPath: string,
    project: LinkProject
  ): Promise<ExportPlan> {
    validateP1TimecodeRanges(project);
    const parsed = await this.parseProject(p1ProjectPath);
    if (!project.p1Sync) throw new Error('当前联动工程尚未从 P1 导入，不能写回');
    if (project.p1Sync.sourceSha256 !== parsed.sourceSha256) {
      throw new Error('P1 工程在上次导入后已变化，已停止写回；请先重新读取 P1');
    }
    const protectedKeys = new Set(project.p1Sync.skippedItems?.map(item => item.sourceKey));
    const existingKeys = new Set(parsed.playlists.flatMap((playlist) => playlist.media.map((media) => media.sourceKey)));
    const exportItems = project.rundown.filter((item) => (item.p1Media !== undefined || item.referenceAudio !== undefined) && !protectedKeys.has(item.p1UnavailableSourceKey ?? item.p1Media?.sourceKey ?? ''));
    const matchedKeys = new Set<string>();
    let addedCount = 0;
    let updatedCount = 0;
    for (const item of exportItems) {
      if (!item.referenceAudio) throw new Error(`P1 绑定节目“${item.title}”缺少参考音频`);
      await access(this.projects.resolveReferenceAudio(linkProjectPath, item.referenceAudio.relativePath), constants.R_OK);
      if (!item.p1Media) {
        addedCount += 1;
        continue;
      }
      if (!existingKeys.has(item.p1Media.sourceKey)) {
        throw new Error(`P1 工程找不到已绑定节目“${item.title}”，请重新导入`);
      }
      matchedKeys.add(item.p1Media.sourceKey);
      updatedCount += 1;
    }
    const removedCount = [...existingKeys].filter(key => !matchedKeys.has(key) && !protectedKeys.has(key)).length;
    const targetPath = linkedOutputPath(parsed.sourcePath);
    return {
      parsed,
      targetPath,
      exportItems,
      preview: {
        sourcePath: parsed.sourcePath,
        targetPath,
        sourceSha256: parsed.sourceSha256,
        playlistCount: project.p1Sync.playlists.length,
        addedCount,
        updatedCount,
        removedCount,
        ignoredCount: project.rundown.length - exportItems.length
      }
    };
  }

  private async parseProject(projectPathValue: string): Promise<ParsedP1Project> {
    const sourcePath = resolve(projectPathValue);
    if (extname(sourcePath).toLowerCase() !== '.hia') throw new Error('P1 音频工程必须使用 .hia 扩展名');
    const sourceBuffer = await readFile(sourcePath);
    const content = sourceBuffer.toString('utf8');
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('P1 工程包含不允许的 XML DTD 或实体声明');
    const document = new DOMParser().parseFromString(content, 'application/xml');
    const parserErrors = document.getElementsByTagName('parsererror');
    if (parserErrors.length > 0) throw new Error(`P1 工程 XML 无效：${parserErrors.item(0)?.textContent ?? sourcePath}`);
    const root = document.documentElement;
    if (!root || root.tagName !== 'playerRoot') throw new Error('P1 工程缺少 playerRoot 根节点');
    const videoPlayList = requireDirectChild(root, 'videoPlayList');
    const audioPlayList = optionalDirectChild(root, 'audioPlayList');
    const playlistElements = directChildren(videoPlayList, 'videoPlayElement');
    if (playlistElements.length === 0) throw new Error('P1 音频工程没有播放列表');
    const pathOccurrences = new Map<string, number>();
    const playlists = playlistElements.map((element, sourceIndex): ParsedP1Playlist => {
      const name = requiredAttribute(element, 'caption', `P1 播放列表 ${sourceIndex + 1}`);
      const playlistBinding: P1PlaylistBinding = { id: `p1-playlist-${sourceIndex + 1}`, name, sourceIndex };
      const media = directChildren(element, 'media').map((mediaElement, mediaIndex) => {
        const rawPath = mediaElement.getAttribute('resourceFilePath') || `missing-${sourceIndex}-${mediaIndex}`;
        const resourcePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(dirname(sourcePath), rawPath);
        const pathKey = normalizePathKey(resourcePath);
        const occurrence = pathOccurrences.get(pathKey) ?? 0;
        pathOccurrences.set(pathKey, occurrence + 1);
        const title = mediaElement.getAttribute('audio_caption_')?.trim() || basename(resourcePath);
        return { element: mediaElement, resourcePath, title, sourceKey: createSourceKey(resourcePath, occurrence), occurrence, index: mediaIndex };
      });
      return { binding: playlistBinding, element, media };
    });
    return {
      document,
      sourcePath,
      sourceSha256: sha256(sourceBuffer),
      videoPlayList,
      audioPlayList,
      playlists
    };
  }

}

function reindexExportMedia(playlists: XmlElement[], sourcePath: string, emitted: Map<XmlElement, LinkP1ProjectExportResult['itemBindings'][number]>, preserved: Map<XmlElement, import('@tb/schema').P1ImportIssue>): import('@tb/schema').P1ImportIssue[] {
  const occurrences = new Map<string, number>();
  const skipped: import('@tb/schema').P1ImportIssue[] = [];
  for (const [listIndex, playlist] of playlists.entries()) for (const [index, element] of directChildren(playlist, 'media').entries()) {
    const raw = element.getAttribute('resourceFilePath') || `missing-${listIndex}-${index}`;
    const path = isAbsolute(raw) ? resolve(raw) : resolve(dirname(sourcePath), raw);
    const key = normalizePathKey(path);
    const occurrence = occurrences.get(key) ?? 0; occurrences.set(key, occurrence + 1);
    const sourceKey = createSourceKey(path, occurrence);
    const binding = emitted.get(element); if (binding) binding.p1Media.sourceKey = sourceKey;
    const issue = preserved.get(element); if (issue) skipped.push({ ...issue, previousSourceKey: issue.sourceKey, sourceKey });
  }
  return skipped;
}

const SONG_EXTENSIONS: ReadonlySet<string> = new Set([...REFERENCE_AUDIO_EXTENSIONS, ...REFERENCE_AUDIO_CONTAINER_EXTENSIONS]);

/** Why a song path from a .hia is refused, or null: the attribute text (`raw`) names no network share or
 * device path, and the path is an audio or video file on a local disk or inside the .hia's folder. */
function songPathRefusal(raw: string, path: string, hiaFolder: string): string | null {
  if (/^[\\/]{2}/.test(raw) || /[\u0000-\u001f]/.test(raw)) return `歌曲路径指向网络共享或设备路径，不会访问：${raw}`;
  if (!SONG_EXTENSIONS.has(extname(path).toLowerCase())) return `歌曲路径不是可导入的音视频文件：${path}`;
  const inFolder = relative(hiaFolder, path);
  const local = process.platform === 'win32' ? /^[a-z]:\\/i.test(path) : path.startsWith('/') && !path.startsWith('//');
  if (!local && (inFolder === '' || inFolder.startsWith('..') || isAbsolute(inFolder))) return `歌曲文件不在本机磁盘或 P1 工程文件夹内：${path}`;
  return null;
}

function readMediaBinding(
  element: XmlElement,
  resourcePath: string,
  occurrence: number,
  playlistId: string,
  playlistName: string,
  mediaIndex: number
): P1MediaBinding {
  const context = `${playlistName} 第 ${mediaIndex + 1} 个音频`;
  const playEndValue = requiredAttribute(element, 'playEndAction', context);
  const playEndAction = playEndValue === '0' ? 'playNext' : playEndValue === '1' ? 'loop' : playEndValue === '2' ? 'stop' : null;
  if (!playEndAction) throw new Error(`${context} 的 playEndAction 无效：${playEndValue}`);
  return p1MediaBindingSchema.parse({
    sourceKey: createSourceKey(resourcePath, occurrence),
    playlistId,
    sourceFileName: basename(resourcePath),
    playEndAction,
    volume: readIntegerAttribute(element, 'volume', 0, 100, context),
    muted: readBooleanAttribute(element, 'mute', context),
    shortcut: element.getAttribute('shortcut') ?? '',
    midiStartTime: element.getAttribute('MidiStartTime') ?? '0'
  });
}

async function importP1Audio(projects: LinkProjectService, projectPath: string, media: ParsedP1Media, readablePath: string): Promise<Pick<LinkP1ProjectImportResult['items'][number], 'referenceAudio' | 'importNotes'>> {
  const startText = media.element.getAttribute('cut_start');
  const endText = media.element.getAttribute('cut_end');
  const start = Number(startText), end = Number(endText);
  const valid = startText?.trim() && endText?.trim() && Number.isFinite(start) && start >= 0 && Number.isFinite(end) && end > start && Math.round((end - start) * 1000) > 0;
  if (!valid) return { referenceAudio: await projects.importReferenceAudio(projectPath, readablePath, null), importNotes: `P1 裁剪时长无效（${startText ?? '缺失'}～${endText ?? '缺失'} 秒），已按完整原音频导入；原起始时间码保留，请核对灯光结束位置。` };
  const durationMs = Math.round((end - start) * 1000);
  try {
    const referenceAudio = await projects.importReferenceAudio(projectPath, readablePath, durationMs, start * 1000, true);
    if (referenceAudio.durationMs < durationMs - 2) throw new Error('声明时长超出可解码音频');
    return { referenceAudio };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!/裁剪区间超出可解码音频|声明时长超出可解码音频/.test(reason)) throw error;
    return { referenceAudio: await projects.importReferenceAudio(projectPath, readablePath, null), importNotes: `P1 裁剪范围 ${start}～${end} 秒超出实际音频，已按完整原音频导入；原起始时间码保留，请核对灯光结束位置。` };
  }
}

async function indexCopiedP1Media(root: string, signal?: AbortSignal): Promise<Map<string, string[]>> {
  const files = new Map<string, string[]>();
  const pending = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    signal?.throwIfAborted();
    const current = pending.shift()!;
    const directory = await opendir(current.directory);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      visited += 1;
      if (visited > 12_000) throw new Error('P1 歌曲目录超过 12000 项；请将 .hia 与歌曲文件放入单独文件夹后重试');
      const path = join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < 8 && !entry.name.startsWith('.')) pending.push({ directory: path, depth: current.depth + 1 });
      else if (entry.isFile()) {
        const name = entry.name.toLocaleLowerCase();
        const candidates = files.get(name) ?? [];
        candidates.push(path);
        files.set(name, candidates);
      }
    }
  }
  return files;
}

function createMediaElement(document: XmlDocument, resourcePath: string, durationMs: number): XmlElement {
  const element = document.createElement('media');
  const durationSeconds = durationMs / 1_000;
  const durationLabel = durationText(durationMs);
  const attributes: Readonly<Record<string, string>> = {
    mediaType: '4',
    resourceFilePath: toP1Path(resourcePath),
    playEndAction: '2',
    transitionType: '0',
    transitionDirection: '0',
    transitionDuration: '0.5',
    transitionMotionEnable: '0',
    transitionSpeed: '1',
    scaleType: '1',
    cut_start: '0',
    cut_end: String(durationSeconds),
    iskv: '0',
    volume: '100',
    RotationAngle: '0',
    StretchMode: '0',
    crop_rect: '0 0 1 1',
    use_transcode: '0',
    Caption: durationLabel,
    Resolution: '0x0',
    mute: '0',
    shortcut: '',
    midiport: '',
    midicut: '',
    midiname: '',
    caption_: durationLabel,
    audio_caption_: basename(resourcePath),
    MidiStartTime: '0',
    PPTName: ''
  };
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function applyMediaBinding(
  element: XmlElement,
  resourcePath: string,
  title: string,
  durationMs: number,
  binding: P1MediaBinding
): void {
  element.setAttribute('resourceFilePath', toP1Path(resourcePath));
  element.setAttribute('audio_caption_', title);
  element.setAttribute('playEndAction', binding.playEndAction === 'playNext' ? '0' : binding.playEndAction === 'loop' ? '1' : '2');
  element.setAttribute('volume', String(binding.volume));
  element.setAttribute('mute', binding.muted ? '1' : '0');
  element.setAttribute('shortcut', binding.shortcut);
  element.setAttribute('MidiStartTime', binding.midiStartTime);
  const start = Number(element.getAttribute('cut_start') ?? '0');
  element.setAttribute('cut_end', String(start + durationMs / 1_000));
  element.setAttribute('Caption', durationText(durationMs));
  element.setAttribute('caption_', durationText(durationMs));
}

function synchronizeAudioPlaylistNames(
  document: XmlDocument,
  audioPlayList: XmlElement | null,
  playlists: P1PlaylistBinding[]
): void {
  if (!audioPlayList) return;
  const existing = directChildren(audioPlayList, 'audioPlayElement');
  const elements = playlists.map((playlist, index) => {
    const element = existing[index]
      ? requireElement(existing[index].cloneNode(true), 'P1 音频播放列表')
      : document.createElement('audioPlayElement');
    element.setAttribute('caption', playlist.name);
    if (!element.hasAttribute('type')) element.setAttribute('type', '0');
    return element;
  });
  replaceElementChildren(audioPlayList, 'audioPlayElement', elements);
}

function replaceElementChildren(parent: XmlElement, tagName: string, replacements: XmlElement[]): void {
  for (const child of directChildren(parent, tagName)) parent.removeChild(child);
  for (const replacement of replacements) parent.appendChild(replacement);
}

function directChildren(parent: XmlElement, tagName: string): XmlElement[] {
  const result: XmlElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1 && (node as XmlElement).tagName === tagName) result.push(node as XmlElement);
  }
  return result;
}

function requireDirectChild(parent: XmlElement, tagName: string): XmlElement {
  const child = optionalDirectChild(parent, tagName);
  if (!child) throw new Error(`P1 工程缺少 ${tagName} 节点`);
  return child;
}

function optionalDirectChild(parent: XmlElement, tagName: string): XmlElement | null {
  return directChildren(parent, tagName)[0] ?? null;
}

function requireElement(node: XmlNode | null, context: string): XmlElement {
  if (!node || node.nodeType !== 1) throw new Error(`${context} XML 节点类型无效`);
  return node as XmlElement;
}

function requiredAttribute(element: XmlElement, name: string, context: string): string {
  const value = element.getAttribute(name)?.trim();
  if (!value) throw new Error(`${context} 缺少 ${name} 属性`);
  return value;
}

function readIntegerAttribute(element: XmlElement, name: string, minimum: number, maximum: number, context: string): number {
  const value = Number(requiredAttribute(element, name, context));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${context} 的 ${name} 必须在 ${minimum}-${maximum} 范围内`);
  }
  return value;
}

function readBooleanAttribute(element: XmlElement, name: string, context: string): boolean {
  const value = requiredAttribute(element, name, context);
  if (value === '0') return false;
  if (value === '1') return true;
  throw new Error(`${context} 的 ${name} 必须是 0 或 1`);
}

function createSourceKey(resourcePath: string, occurrence: number): string {
  return sha256(Buffer.from(`${normalizePathKey(resourcePath)}\u0000${occurrence}`, 'utf8'));
}

function normalizePathKey(resourcePath: string): string {
  return resolve(resourcePath).replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function linkedOutputPath(sourcePath: string): string {
  const parsed = parse(sourcePath);
  if (parsed.name.endsWith('.联动台')) return sourcePath;
  return join(parsed.dir, `${parsed.name}.联动台.hia`);
}

function toP1Path(resourcePath: string): string {
  return resolve(resourcePath).replaceAll('\\', '/');
}

function durationText(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
