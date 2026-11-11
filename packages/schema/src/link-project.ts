import { z } from 'zod';
import { audioSegmentSchema, audioBeatMapSchema } from './audio-edit';
import { lightingDocumentSchema } from './lighting';
import { ma2ReadStateSchema } from './ma2-catalog';
import { ma2EffectLibrarySchema } from './ma2-effect-library';
import { lightingUserLibrarySchema } from './lighting-library';

export const LINK_PROJECT_SCHEMA_VERSION = 1 as const;

export const mtcFrameRateSchema = z.enum(['24', '25', '29.97df', '30']);

export const outputCanvasSchema = z.object({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(320).max(7680)
});

export const smpteTimecodeSchema = z.object({
  hours: z.number().int().min(0).max(23),
  minutes: z.number().int().min(0).max(59),
  seconds: z.number().int().min(0).max(59),
  frames: z.number().int().min(0).max(29)
});

const actionBase = z.object({
  id: z.string().min(1),
  label: z.string().min(1)
});

const sceneItemTransformSchema = z.object({
  positionX: z.number(),
  positionY: z.number(),
  scaleX: z.number(),
  scaleY: z.number(),
  rotation: z.number(),
  cropTop: z.number().int().min(0),
  cropRight: z.number().int().min(0),
  cropBottom: z.number().int().min(0),
  cropLeft: z.number().int().min(0),
  alignment: z.number().int().min(0).max(15).optional()
});

export const linkActionSchema = z.discriminatedUnion('kind', [
  actionBase.extend({
    kind: z.literal('obs.setProgramScene'),
    sceneName: z.string().min(1),
    sceneLayers: z.array(z.string().min(1)).min(1).max(128).optional(),
    transition: z.object({
      name: z.string().min(1),
      durationMs: z.number().int().min(50).max(20_000)
    }).optional()
  }),
  actionBase.extend({
    kind: z.literal('obs.setSceneItemEnabled'),
    sceneName: z.string().min(1),
    sourceName: z.string().min(1),
    enabled: z.boolean()
  }),
  actionBase.extend({
    kind: z.literal('obs.setSceneItemTransform'),
    sceneName: z.string().min(1),
    sourceName: z.string().min(1),
    transform: sceneItemTransformSchema
  }),
  actionBase.extend({
    kind: z.literal('obs.setSceneItemIndex'),
    sceneName: z.string().min(1),
    sourceName: z.string().min(1),
    sceneItemIndex: z.number().int().nonnegative()
  }),
  actionBase.extend({
    kind: z.literal('obs.setSourceFilterEnabled'),
    sourceName: z.string().min(1),
    filterName: z.string().min(1),
    enabled: z.boolean()
  }),
  actionBase.extend({
    kind: z.literal('obs.setInputMute'),
    inputName: z.string().min(1),
    muted: z.boolean()
  }),
  actionBase.extend({
    kind: z.literal('obs.setInputVolume'),
    inputName: z.string().min(1),
    volumeDb: z.number().min(-100).max(26)
  }),
  actionBase.extend({
    kind: z.literal('obs.mediaAction'),
    inputName: z.string().min(1),
    action: z.enum(['restart', 'start', 'stop', 'pause', 'next', 'previous'])
  }),
  actionBase.extend({
    kind: z.literal('obs.setTransition'),
    transitionName: z.string().min(1),
    durationMs: z.number().int().min(0).max(20_000).refine((value) => value === 0 || value >= 50, {
      message: 'OBS 转场时长必须是 0 或 50–20000 ms'
    })
  }),
  actionBase.extend({
    kind: z.literal('obs.saveSourceScreenshot'),
    sourceName: z.string().min(1),
    fileName: z.string().min(1)
  }),
  actionBase.extend({
    kind: z.literal('midi.noteOn'),
    durationMs: z.number().int().min(20).max(2000).optional(),
    portProfileId: z.string().min(1),
    channel: z.number().int().min(1).max(16),
    note: z.number().int().min(0).max(127),
    velocity: z.number().int().min(1).max(127)
  }),
  actionBase.extend({
    kind: z.literal('midi.noteOff'),
    portProfileId: z.string().min(1),
    channel: z.number().int().min(1).max(16),
    note: z.number().int().min(0).max(127),
    velocity: z.number().int().min(0).max(127)
  }),
  actionBase.extend({
    kind: z.literal('midi.controlChange'),
    portProfileId: z.string().min(1),
    channel: z.number().int().min(1).max(16),
    controller: z.number().int().min(0).max(127),
    value: z.number().int().min(0).max(127)
  }),
  actionBase.extend({
    kind: z.literal('midi.programChange'),
    portProfileId: z.string().min(1),
    channel: z.number().int().min(1).max(16),
    program: z.number().int().min(0).max(127)
  }),
  actionBase.extend({
    kind: z.literal('midi.showControl'),
    portProfileId: z.string().min(1),
    deviceId: z.number().int().min(0).max(127),
    commandFormat: z.number().int().min(0).max(127),
    command: z.enum(['go', 'stop', 'resume', 'load']),
    cueNumber: z.string().min(1).optional(),
    cueList: z.string().min(1).optional(),
    cuePath: z.string().min(1).optional()
  })
]);

export const p1StartTriggerSchema = z.discriminatedUnion('kind', [
  actionBase.extend({
    kind: z.literal('p1.midiNotePulse'),
    portProfileId: z.string().min(1),
    channel: z.number().int().min(1).max(16),
    note: z.number().int().min(0).max(127),
    velocity: z.number().int().min(1).max(127),
    durationMs: z.number().int().min(20).max(2_000)
  }),
  actionBase.extend({
    kind: z.literal('midi.controlChange'),
    portProfileId: z.string().min(1),
    channel: z.number().int().min(1).max(16),
    controller: z.number().int().min(0).max(127),
    value: z.number().int().min(0).max(127)
  }),
  actionBase.extend({
    kind: z.literal('midi.programChange'),
    portProfileId: z.string().min(1),
    channel: z.number().int().min(1).max(16),
    program: z.number().int().min(0).max(127)
  }),
  actionBase.extend({
    kind: z.literal('midi.showControl'),
    portProfileId: z.string().min(1),
    deviceId: z.number().int().min(0).max(127),
    commandFormat: z.number().int().min(0).max(127),
    command: z.enum(['go', 'load']),
    cueNumber: z.string().min(1).optional(),
    cueList: z.string().min(1).optional(),
    cuePath: z.string().min(1).optional()
  })
]);

export const linkCueSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timecode: smpteTimecodeSchema,
  durationMs: z.number().int().positive().max(86_400_000).optional(),
  enabled: z.boolean().default(true),
  notes: z.string().default(''),
  actions: z.array(linkActionSchema).default([]),
  layerId: z.string().min(1).optional()
});

export const referenceAudioSourceSchema = z.object({
  sourceMediaAssetId: z.string().min(1).optional(),
  assetId: z.string().min(1),
  relativePath: z.string().min(1).refine(isSafeProjectPath, '参考音频必须使用工程内相对路径'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  durationMs: z.number().int().positive()
});

export const audioTrackSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), source: referenceAudioSourceSchema,
  segments: z.array(audioSegmentSchema).min(1).max(10_000)
}).strict().superRefine((track, ctx) => {
  const sorted = [...track.segments].sort((a, b) => a.startMs - b.startMs);
  if (new Set(sorted.map(segment => segment.id)).size !== sorted.length) ctx.addIssue({ code: 'custom', message: '音频片段 ID 不能重复' });
  for (const [index, segment] of sorted.entries()) {
    if (segment.sourceOffsetMs + segment.durationMs > track.source.durationMs) ctx.addIssue({ code: 'custom', message: '音频片段超出源文件范围' });
    if (index && segment.startMs < sorted[index - 1]!.startMs + sorted[index - 1]!.durationMs) ctx.addIssue({ code: 'custom', message: '同一音轨的片段不能重叠，请使用不同音轨' });
  }
});
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export const audioTracksSchema = z.array(audioTrackSchema).min(1).max(64).superRefine((tracks, ctx) => {
  if (new Set(tracks.map(track => track.id)).size !== tracks.length) ctx.addIssue({ code: 'custom', message: '音轨 ID 不能重复' });
});

export const referenceAudioSchema = referenceAudioSourceSchema.extend({
  // Keep multitrack metadata inside the strict timeline object: old versions
  // reject the project instead of silently discarding independently edited tracks.
  timeline: z.object({ source: referenceAudioSourceSchema, segments: z.array(audioSegmentSchema).min(1).max(10_000), tracks: audioTracksSchema.optional() }).strict().optional(),
  beats: audioBeatMapSchema.optional()
}).superRefine((audio, ctx) => {
  const segments = audio.timeline?.segments;
  if (audio.timeline?.tracks?.some(track => track.segments.some(segment => segment.startMs + segment.durationMs > audio.durationMs))) ctx.addIssue({ code: 'custom', message: '音轨超出混合音频时长' });
  if (segments && audio.timeline) {
    const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
    for (const [index, segment] of sorted.entries()) {
      if (segment.sourceOffsetMs + segment.durationMs > audio.timeline.source.durationMs || segment.startMs + segment.durationMs > audio.durationMs) ctx.addIssue({ code: 'custom', message: '音频片段超出素材或时间线范围' });
      if (index && segment.startMs < sorted[index - 1]!.startMs + sorted[index - 1]!.durationMs) ctx.addIssue({ code: 'custom', message: '歌曲音频片段不能重叠' });
    }
    if (new Set(segments.map((segment) => segment.id)).size !== segments.length) ctx.addIssue({ code: 'custom', message: '音频片段 ID 不能重复' });
  }
  if (audio.beats && (audio.beats.sourceSha256 !== audio.sha256 || audio.beats.pointsMs.some((time) => time >= audio.durationMs))) ctx.addIssue({ code: 'custom', message: '节拍标记与当前音频不匹配' });
});

export const p1PlayEndActionSchema = z.enum(['playNext', 'loop', 'stop']);

export const p1PlaylistBindingSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceIndex: z.number().int().min(0)
});

export const p1MediaBindingSchema = z.object({
  importedFullSource: z.boolean().optional(),
  sourceTrim: z.object({ startMs: z.number().nonnegative(), endMs: z.number().positive(), applied: z.boolean() }).optional(),
  sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
  playlistId: z.string().min(1),
  sourceFileName: z.string().min(1),
  playEndAction: p1PlayEndActionSchema,
  volume: z.number().int().min(0).max(100),
  muted: z.boolean(),
  shortcut: z.string(),
  midiStartTime: z.string().regex(/^\d+(?::\d{1,2}){0,3}(?:\.\d+)?$/, 'P1 MTC 起始时间格式无效')
});

export const p1ImportIssueSchema = z.object({ sourceKey: z.string().min(1), previousSourceKey: z.string().optional(), title: z.string(), playlistName: z.string(), playlistId: z.string().optional(), reason: z.string() });
export type P1ImportIssue = z.infer<typeof p1ImportIssueSchema>;
export const p1ProjectSyncSchema = z.object({
  skippedItems: z.array(p1ImportIssueSchema).optional(),
  format: z.literal('hirender-p1-audio-project'),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  importedAt: z.string().datetime({ offset: true }),
  playlists: z.array(p1PlaylistBindingSchema).min(1)
});

export const linkMediaKindSchema = z.enum(['audio', 'video', 'image']);

export const linkMediaFolderSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  parentId: z.string().min(1).nullable().default(null)
});

export const linkMediaAssetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: linkMediaKindSchema,
  folderId: z.string().min(1).nullable().default(null),
  relativePath: z.string().min(1).refine(isSafeProjectPath, '媒体素材必须使用工程内相对路径'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive(),
  durationMs: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional()
}).superRefine((asset, ctx) => {
  if ((asset.kind === 'audio' || asset.kind === 'video') && asset.durationMs === undefined) {
    ctx.addIssue({ code: 'custom', message: '音频和视频素材必须包含时长', path: ['durationMs'] });
  }
  if ((asset.kind === 'video' || asset.kind === 'image') && (asset.width === undefined || asset.height === undefined)) {
    ctx.addIssue({ code: 'custom', message: '视频和图片素材必须包含尺寸', path: ['width'] });
  }
});

export const DEFAULT_REFERENCE_CANVAS_TRANSFORM = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  rotation: 0
} as const;

export const referenceCanvasTransformSchema = z.object({
  x: z.number().finite().min(-1).max(2),
  y: z.number().finite().min(-1).max(2),
  scale: z.number().finite().min(0.05).max(8),
  scaleX: z.number().finite().min(0.05).max(8).default(1),
  scaleY: z.number().finite().min(0.05).max(8).default(1),
  rotation: z.number().finite().min(-180).max(180)
});

export const visualLayerSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false)
});

export const referenceMediaClipSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  startTimecode: smpteTimecodeSchema,
  sourceOffsetMs: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().positive(),
  label: z.string().min(1),
  layerId: z.string().min(1).optional(),
  embeddedAudioEnabled: z.boolean().optional(),
  canvasTransform: referenceCanvasTransformSchema.default(DEFAULT_REFERENCE_CANVAS_TRANSFORM)
});

export const rundownItemSchema = z.object({
  p1UnavailableSourceKey: z.string().optional(),
  lighting: lightingDocumentSchema.optional(),
  playback: z.object({
    volume: z.number().min(0).max(100),
    // Absent: the song follows the player's own end action.
    endAction: z.enum(['next', 'loop', 'stop', 'pause']).optional(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    mtcOffsetMs: z.number().int().min(0).max(86_399_000),
    shortcut: z.string().max(80)
  }).optional(),
  playlistId: z.string().min(1).nullable().optional(),
  id: z.string().min(1),
  title: z.string().min(1),
  enabled: z.boolean().default(true),
  notes: z.string().default(''),
  p1Media: p1MediaBindingSchema.optional(),
  p1StartTrigger: p1StartTriggerSchema.optional(),
  referenceAudio: referenceAudioSchema.optional(),
  visualLayers: z.array(visualLayerSchema).default([]),
  referenceMediaClips: z.array(referenceMediaClipSchema).default([]),
  cues: z.array(linkCueSchema).default([])
});

/** What the content editor changes in a song: its tracks, clips and cues. A song's content command parses only this. */
export const rundownItemContentSchema = rundownItemSchema.pick({ visualLayers: true, referenceMediaClips: true, cues: true });

export const linkProjectSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  projectId: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  timebase: z.object({
    frameRate: mtcFrameRateSchema,
    mode: z.literal('per-item-reset')
  }),
  outputCanvas: outputCanvasSchema.default({ width: 1080, height: 1920 }),
  playbackSource: z.enum(['p1', 'internal']).optional(),
  /** Only scenes play. 'managed' marks a file from before the scene-only workflow and opens as scenes. */
  obsOutputMode: z.enum(['managed', 'scenes']).optional(),
  internalVideoAudio: z.boolean().optional(),
  playlists: z.array(z.object({ id: z.string().min(1), name: z.string().trim().min(1) })).optional(),
  p1Sync: p1ProjectSyncSchema.optional(),
  ma2ReadState: ma2ReadStateSchema.optional(),
  ma2MaterialLibrary: z.object({ version: z.union([z.literal(1), z.literal(2)]), source: z.string().min(1), library: ma2EffectLibrarySchema.optional(), userLibrary: lightingUserLibrarySchema.optional() }).strict().superRefine((value, context) => {
    if (value.version === 1 && (!value.library || value.userLibrary)) context.addIssue({ code: 'custom', message: '旧素材目录必须包含控台数据且不能包含新版分类' });
    if (value.version === 2 && !value.userLibrary) context.addIssue({ code: 'custom', message: '新版素材目录缺少分类库' });
  }).optional(),
  p1AutoFollow: z.object({
    enabled: z.boolean(),
    ranges: z.array(z.object({
      itemId: z.string().min(1),
      startSeconds: z.number().int().min(60).max(53_999),
      durationMs: z.number().int().positive()
    })).min(1)
  }).optional(),
  mediaFolders: z.array(linkMediaFolderSchema).default([]),
  mediaAssets: z.array(linkMediaAssetSchema).default([]),
  rundown: z.array(rundownItemSchema).default([])
}).superRefine(validateProjectInvariants);

export type MtcFrameRate = z.infer<typeof mtcFrameRateSchema>;
export type OutputCanvas = z.infer<typeof outputCanvasSchema>;
export type SmpteTimecode = z.infer<typeof smpteTimecodeSchema>;
export type LinkAction = z.infer<typeof linkActionSchema>;
export type SceneItemTransform = z.infer<typeof sceneItemTransformSchema>;
export type P1StartTrigger = z.infer<typeof p1StartTriggerSchema>;
export type LinkCue = z.infer<typeof linkCueSchema>;
export type VisualLayer = z.infer<typeof visualLayerSchema>;
export type ReferenceAudio = z.infer<typeof referenceAudioSchema>;
export type P1PlayEndAction = z.infer<typeof p1PlayEndActionSchema>;
export type P1PlaylistBinding = z.infer<typeof p1PlaylistBindingSchema>;
export type P1MediaBinding = z.infer<typeof p1MediaBindingSchema>;
export type P1ProjectSync = z.infer<typeof p1ProjectSyncSchema>;
export type LinkMediaKind = z.infer<typeof linkMediaKindSchema>;
export type LinkMediaFolder = z.infer<typeof linkMediaFolderSchema>;
export type LinkMediaAsset = z.infer<typeof linkMediaAssetSchema>;
export type ReferenceMediaClip = z.infer<typeof referenceMediaClipSchema>;
export type ReferenceCanvasTransform = z.infer<typeof referenceCanvasTransformSchema>;
export type RundownItem = z.infer<typeof rundownItemSchema>;
export type RundownItemContent = z.infer<typeof rundownItemContentSchema>;
export type LinkProject = z.infer<typeof linkProjectSchema>;

export function parseLinkProject(value: unknown): LinkProject {
  return linkProjectSchema.parse(value);
}

/** Domain-only validation for immutable updates to already parsed projects.
 * Callers must parse each changed item/field with its schema first. External
 * input and saved files must still go through parseLinkProject. */
const projectRelationsSchema = z.custom<LinkProject>().superRefine(validateProjectInvariants);
export function validateLinkProjectRelations(project: LinkProject): void {
  projectRelationsSchema.parse(project);
}

/** The checks validateLinkProjectRelations makes on one song, for a project where only this song changed: its
 * playlist and playback range, its shortcut against the other songs, its P1 binding, its ids against every other id in
 * the project, and its tracks, clips and cues against the project's media assets and frame rate. The same code as the
 * whole-project check, which runs it for each song. Callers parse the song's changed fields with their schema first. */
const itemRelationsSchema = z.custom<{ project: LinkProject; item: RundownItem }>().superRefine(({ project, item }, ctx) => {
  const itemIndex = project.rundown.indexOf(item);
  if (itemIndex < 0) {
    ctx.addIssue({ code: 'custom', message: `节目不在工程里：${item.id}` });
    return;
  }
  const relations = projectItemRelations(project);
  validateItemSettings(relations.playlistIds, item, itemIndex,
    (shortcut) => project.rundown.some((other) => other !== item && other.playback?.shortcut.toLowerCase() === shortcut), ctx);
  const own = new Set<string>();
  const others = project.rundown.filter((other) => other !== item).map(itemIds);
  const claim: IdClaim = (id, path) => {
    if (own.has(id) || relations.ids.has(id) || others.some((ids) => ids.has(id))) {
      ctx.addIssue({ code: 'custom', message: `ID 重复：${id}`, path });
      return;
    }
    own.add(id);
  };
  validateItemContent(project.timebase.frameRate, relations.assetById, relations.p1PlaylistIds, item, itemIndex, claim, ctx);
});
export function validateItemRelations(project: LinkProject, item: RundownItem): void {
  itemRelationsSchema.parse({ project, item });
}

export function serializeLinkProject(project: LinkProject): string {
  return `${JSON.stringify(parseLinkProject(project), null, 2)}\n`;
}

export function createEmptyLinkProject(name: string, now = new Date()): LinkProject {
  const timestamp = now.toISOString();
  return parseLinkProject({
    schemaVersion: LINK_PROJECT_SCHEMA_VERSION,
    projectId: crypto.randomUUID(),
    name,
    createdAt: timestamp,
    updatedAt: timestamp,
    timebase: { frameRate: '30', mode: 'per-item-reset' },
    outputCanvas: { width: 1080, height: 1920 },
    mediaFolders: [],
    mediaAssets: [],
    rundown: []
  });
}

function isSafeProjectPath(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]/.test(value)) return false;
  return !value.split(/[\\/]/).some((segment) => segment === '..');
}

export type LinkProjectSchemaVersion = 1 | 2 | 3;
/** The newest file version this release opens and saves. A newer file is refused: unknown fields are stripped on parse,
 * so opening it would drop them on the next save without a word. Raise this only in the commit that adds the first
 * field needing the next version; until then 3 exists in the types alone. */
export const latestSchemaVersion: LinkProjectSchemaVersion = 2;

/** The lowest file version that keeps everything in this project, and the only place that decides it.
 * 2: lighting, a console read state or a console material library, which releases before lighting would drop.
 * 3: fields only releases after 0.5.8 understand; nothing writes one yet, so no project needs 3 today.
 * 1: everything else. Pure, so a save can compare it with the version the file has now. */
export function requiredSchemaVersion(project: Pick<LinkProject, 'ma2ReadState' | 'ma2MaterialLibrary' | 'rundown'>): LinkProjectSchemaVersion {
  if (project.ma2ReadState || project.ma2MaterialLibrary || project.rundown.some((item) => item.lighting !== undefined)) return 2;
  return 1;
}

function validateProjectInvariants(project: z.infer<typeof linkProjectSchema>, ctx: z.RefinementCtx): void {
  if (project.schemaVersion > latestSchemaVersion) {
    ctx.addIssue({ code: 'custom', message: '这个工程是用更新版本的联动台保存的。请先更新联动台再打开，免得丢掉新版本才有的内容', path: ['schemaVersion'] });
  }
  const required = requiredSchemaVersion(project);
  if (project.schemaVersion < required) {
    ctx.addIssue({ code: 'custom', message: required === 2 ? '含灯光编排的工程必须使用 schema 2，防止旧版本丢失数据' : `工程用到了新版本的内容，必须使用 schema ${required}，防止旧版本丢失数据`, path: ['schemaVersion'] });
  }
  const relations = projectItemRelations(project, ctx);
  for (const [index, item] of project.rundown.entries()) {
    validateItemSettings(relations.playlistIds, item, index,
      (shortcut) => project.rundown.slice(0, index).some((previous) => previous.playback?.shortcut.toLowerCase() === shortcut), ctx);
  }
  const ids = relations.ids;
  const claim: IdClaim = (id, path) => addUniqueId(ids, id, path, ctx);
  for (const [itemIndex, item] of project.rundown.entries()) {
    validateItemContent(project.timebase.frameRate, relations.assetById, relations.p1PlaylistIds, item, itemIndex, claim, ctx);
  }
}

type IdClaim = (id: string, path: PropertyKey[]) => void;
type MediaAssetsById = Map<string, z.infer<typeof linkMediaAssetSchema>>;
type ProjectItemRelations = {
  playlistIds: Set<string>;
  /** The ids of the P1 playlists, media folders and media assets. */
  ids: Set<string>;
  assetById: MediaAssetsById;
  p1PlaylistIds: Set<string> | null;
};

/** What songs refer to outside themselves. With `ctx` this also reports the project's own problems (playlists, P1
 * sources, folders, assets); without it, for checking one song of a project that passed, it only collects. */
function projectItemRelations(project: z.infer<typeof linkProjectSchema>, ctx?: z.RefinementCtx): ProjectItemRelations {
  const report = (message: string, path: PropertyKey[]): void => { ctx?.addIssue({ code: 'custom', message, path }); };
  const playlistIds = new Set<string>();
  if (project.playlists === undefined) for (const list of project.p1Sync?.playlists ?? []) playlistIds.add(`p1:${list.id}`);
  for (const [index, list] of (project.playlists ?? []).entries()) {
    if (playlistIds.has(list.id) || ['all', 'unassigned'].includes(list.id)) report('播放列表标识重复或保留', ['playlists', index, 'id']);
    playlistIds.add(list.id);
  }
  const ids = new Set<string>();
  const claim = (id: string, path: PropertyKey[]): void => {
    if (ids.has(id)) report(`ID 重复：${id}`, path);
    else ids.add(id);
  };
  const folderIds = new Set<string>();
  const assetById: MediaAssetsById = new Map();

  if (project.p1Sync) {
    const sourceIndexes = new Set<number>();
    for (const [playlistIndex, playlist] of project.p1Sync.playlists.entries()) {
      claim(`p1-playlist:${playlist.id}`, ['p1Sync', 'playlists', playlistIndex, 'id']);
      if (sourceIndexes.has(playlist.sourceIndex)) report(`P1 播放列表来源位置重复：${playlist.sourceIndex}`, ['p1Sync', 'playlists', playlistIndex, 'sourceIndex']);
      sourceIndexes.add(playlist.sourceIndex);
    }
  }

  for (const [folderIndex, folder] of project.mediaFolders.entries()) {
    claim(folder.id, ['mediaFolders', folderIndex, 'id']);
    folderIds.add(folder.id);
  }
  if (ctx) validateMediaFolders(project.mediaFolders, folderIds, ctx);

  for (const [assetIndex, asset] of project.mediaAssets.entries()) {
    claim(asset.id, ['mediaAssets', assetIndex, 'id']);
    assetById.set(asset.id, asset);
    if (asset.folderId !== null && !folderIds.has(asset.folderId)) report(`媒体素材引用不存在的文件夹：${asset.folderId}`, ['mediaAssets', assetIndex, 'folderId']);
  }
  return { playlistIds, ids, assetById, p1PlaylistIds: project.p1Sync ? new Set(project.p1Sync.playlists.map((playlist) => playlist.id)) : null };
}

/** A song's playlist and playback range. `shortcutTaken(lowercase)`: whether a song it is compared with has that shortcut. */
function validateItemSettings(playlistIds: Set<string>, item: RundownItem, index: number,
  shortcutTaken: (shortcut: string) => boolean, ctx: z.RefinementCtx): void {
  if (item.playlistId && !playlistIds.has(item.playlistId)) ctx.addIssue({ code: 'custom', message: '节目引用不存在的播放列表', path: ['rundown', index, 'playlistId'] });
  if (item.playback) {
    const end = item.playback.endMs || item.referenceAudio?.durationMs;
    if (end !== undefined && (item.playback.startMs >= end || (item.referenceAudio && end > item.referenceAudio.durationMs))) {
      ctx.addIssue({ code: 'custom', message: '歌曲裁剪范围无效', path: ['rundown', index, 'playback'] });
    }
    if (item.referenceAudio && item.playback.mtcOffsetMs + item.referenceAudio.durationMs >= 86_400_000) {
      ctx.addIssue({ code: 'custom', message: '歌曲时间码超出 24 小时', path: ['rundown', index, 'playback', 'mtcOffsetMs'] });
    }
    if (item.playback.shortcut && shortcutTaken(item.playback.shortcut.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: '歌曲快捷键重复', path: ['rundown', index, 'playback', 'shortcut'] });
    }
  }
}

/** Every id in a song that must be unique in the project: the ones validateItemContent claims. Songs are never
 * changed in place (every change is a LinkCommand), so a song object's ids are worked out once. */
const itemIdCache = new WeakMap<RundownItem, ReadonlySet<string>>();
function itemIds(item: RundownItem): ReadonlySet<string> {
  const cached = itemIdCache.get(item);
  if (cached) return cached;
  const ids = new Set<string>([item.id]);
  if (item.p1Media) ids.add(`p1:${item.p1Media.sourceKey}`);
  for (const layer of item.visualLayers) ids.add(layer.id);
  for (const clip of item.referenceMediaClips) ids.add(clip.id);
  for (const cue of item.cues) {
    ids.add(cue.id);
    for (const action of cue.actions) ids.add(action.id);
  }
  itemIdCache.set(item, ids);
  return ids;
}

/** A song's ids and P1 binding, and its tracks, clips and cues against the project's media assets and frame rate. */
function validateItemContent(frameRate: MtcFrameRate, assetById: MediaAssetsById, p1PlaylistIds: Set<string> | null,
  item: RundownItem, itemIndex: number, claim: IdClaim, ctx: z.RefinementCtx): void {
  claim(item.id, ['rundown', itemIndex, 'id']);
  if (item.p1Media) {
    if (!p1PlaylistIds) {
      ctx.addIssue({
        code: 'custom',
        message: '节目包含 P1 媒体绑定，但工程缺少 P1 同步来源',
        path: ['rundown', itemIndex, 'p1Media']
      });
    } else if (!p1PlaylistIds.has(item.p1Media.playlistId)) {
      ctx.addIssue({
        code: 'custom',
        message: `P1 媒体绑定引用不存在的播放列表：${item.p1Media.playlistId}`,
        path: ['rundown', itemIndex, 'p1Media', 'playlistId']
      });
    }
    claim(`p1:${item.p1Media.sourceKey}`, ['rundown', itemIndex, 'p1Media', 'sourceKey']);
  }
  const visualLayerIds = new Set(item.visualLayers.map((layer, layerIndex) => {
    claim(layer.id, ['rundown', itemIndex, 'visualLayers', layerIndex, 'id']);
    return layer.id;
  }));
  const visualIntervalsByLayer = new Map<string, TimelineValidationInterval[]>();
  const obsIntervalsBySource = new Map<string, TimelineValidationInterval[]>();
  for (const [clipIndex, clip] of item.referenceMediaClips.entries()) {
    claim(clip.id, ['rundown', itemIndex, 'referenceMediaClips', clipIndex, 'id']);
    if (!assetById.has(clip.assetId)) {
      ctx.addIssue({
        code: 'custom',
        message: `参考素材片段引用不存在的素材：${clip.assetId}`,
        path: ['rundown', itemIndex, 'referenceMediaClips', clipIndex, 'assetId']
      });
    }
    if (clip.layerId && !visualLayerIds.has(clip.layerId)) {
      ctx.addIssue({ code: 'custom', message: `参考素材片段引用不存在的图层：${clip.layerId}`, path: ['rundown', itemIndex, 'referenceMediaClips', clipIndex, 'layerId'] });
    }
    const asset = assetById.get(clip.assetId);
    if (asset && asset.kind !== 'audio' && visualLayerIds.size > 0 && !clip.layerId) {
      ctx.addIssue({ code: 'custom', message: `视觉素材片段“${clip.label}”还没分配视觉图层`, path: ['rundown', itemIndex, 'referenceMediaClips', clipIndex, 'layerId'] });
    }
    if (asset?.durationMs !== undefined && (clip.sourceOffsetMs ?? 0) + clip.durationMs > asset.durationMs) {
      ctx.addIssue({
        code: 'custom',
        message: `素材片段“${clip.label}”超出原素材可用时长`,
        path: ['rundown', itemIndex, 'referenceMediaClips', clipIndex, 'durationMs']
      });
    }
    validateFrameNumber(clip.startTimecode.frames, frameRate, [
      'rundown', itemIndex, 'referenceMediaClips', clipIndex, 'startTimecode', 'frames'
    ], ctx);
    validateDropFrameBoundary(clip.startTimecode, frameRate, [
      'rundown', itemIndex, 'referenceMediaClips', clipIndex, 'startTimecode', 'frames'
    ], ctx);
    if (clip.layerId && asset && asset.kind !== 'audio') {
      addTimelineValidationInterval(visualIntervalsByLayer, clip.layerId, {
        label: clip.label,
        path: ['rundown', itemIndex, 'referenceMediaClips', clipIndex, 'durationMs'],
        startFrame: validationTimecodeToFrameNumber(clip.startTimecode, frameRate),
        endFrame: validationTimecodeToFrameNumber(clip.startTimecode, frameRate)
          + validationDurationFrames(clip.durationMs, frameRate)
      });
    }
  }
  for (const [cueIndex, cue] of item.cues.entries()) {
    claim(cue.id, ['rundown', itemIndex, 'cues', cueIndex, 'id']);
    if (cue.layerId && !visualLayerIds.has(cue.layerId)) {
      ctx.addIssue({ code: 'custom', message: `Cue 引用不存在的图层：${cue.layerId}`, path: ['rundown', itemIndex, 'cues', cueIndex, 'layerId'] });
    }
    validateFrameNumber(cue.timecode.frames, frameRate, [
      'rundown', itemIndex, 'cues', cueIndex, 'timecode', 'frames'
    ], ctx);
    validateDropFrameBoundary(cue.timecode, frameRate, [
      'rundown', itemIndex, 'cues', cueIndex, 'timecode', 'frames'
    ], ctx);
    const visualShowActions = cue.actions.filter((action) => action.kind === 'obs.setSceneItemEnabled' && action.enabled);
    const visualShow = visualShowActions.length > 0;
    if (visualShow && visualLayerIds.size > 0 && !cue.layerId) {
      ctx.addIssue({ code: 'custom', message: `OBS 显示 Cue“${cue.name}”还没分配视觉图层`, path: ['rundown', itemIndex, 'cues', cueIndex, 'layerId'] });
    }
    if (visualShowActions.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `OBS 显示 Cue“${cue.name}”只能包含一个启用的显示来源动作`,
        path: ['rundown', itemIndex, 'cues', cueIndex, 'actions']
      });
    }
    if (visualShow && cue.durationMs === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `OBS 显示 Cue“${cue.name}”缺少 durationMs，无法确定结束隐藏时间`,
        path: ['rundown', itemIndex, 'cues', cueIndex, 'durationMs']
      });
    }
    if (visualShow && cue.layerId && cue.durationMs !== undefined && cue.enabled) {
      const startFrame = validationTimecodeToFrameNumber(cue.timecode, frameRate);
      const interval = {
        label: cue.name,
        path: ['rundown', itemIndex, 'cues', cueIndex, 'durationMs'],
        startFrame,
        endFrame: startFrame + validationDurationFrames(cue.durationMs, frameRate)
      };
      addTimelineValidationInterval(visualIntervalsByLayer, cue.layerId, interval);
      const visualShowAction = visualShowActions[0];
      if (visualShowAction?.kind === 'obs.setSceneItemEnabled') {
        addTimelineValidationInterval(obsIntervalsBySource, visualShowAction.sourceName, interval);
      }
    }
    for (const [actionIndex, action] of cue.actions.entries()) {
      claim(action.id, ['rundown', itemIndex, 'cues', cueIndex, 'actions', actionIndex, 'id']);
    }
  }
  validateTimelineIntervals(visualIntervalsByLayer, ctx);
  validateObsSourceIntervals(obsIntervalsBySource, ctx);
}

type TimelineValidationInterval = {
  label: string;
  path: PropertyKey[];
  startFrame: number;
  endFrame: number;
};

function addTimelineValidationInterval(
  intervalsByLayer: Map<string, TimelineValidationInterval[]>,
  layerId: string,
  interval: TimelineValidationInterval
): void {
  const intervals = intervalsByLayer.get(layerId) ?? [];
  intervals.push(interval);
  intervalsByLayer.set(layerId, intervals);
}

function validateTimelineIntervals(
  intervalsByLayer: Map<string, TimelineValidationInterval[]>,
  ctx: z.RefinementCtx
): void {
  for (const intervals of intervalsByLayer.values()) {
    const ordered = [...intervals].sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous && current && current.startFrame < previous.endFrame) {
        ctx.addIssue({
          code: 'custom',
          message: `同一视觉图层的时间片段不能重叠：“${previous.label}”与“${current.label}”`,
          path: current.path
        });
      }
    }
  }
}

function validateObsSourceIntervals(
  intervalsBySource: Map<string, TimelineValidationInterval[]>,
  ctx: z.RefinementCtx
): void {
  for (const [sourceName, intervals] of intervalsBySource) {
    const ordered = [...intervals].sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous && current && current.startFrame < previous.endFrame) {
        ctx.addIssue({
          code: 'custom',
          message: `同一 OBS 来源不能在多个时间片段同时显示：${sourceName}（“${previous.label}”与“${current.label}”）`,
          path: current.path
        });
      }
    }
  }
}

function validationDurationFrames(durationMs: number, frameRate: z.infer<typeof mtcFrameRateSchema>): number {
  const playbackFps = frameRate === '29.97df' ? 30_000 / 1_001 : Number(frameRate);
  return Math.max(1, Math.round(durationMs / 1_000 * playbackFps));
}

function validationTimecodeToFrameNumber(
  timecode: z.infer<typeof smpteTimecodeSchema>,
  frameRate: z.infer<typeof mtcFrameRateSchema>
): number {
  const nominalFps = frameRate === '24' ? 24 : frameRate === '25' ? 25 : 30;
  const nominalFrames = (((timecode.hours * 60 + timecode.minutes) * 60 + timecode.seconds) * nominalFps) + timecode.frames;
  if (frameRate !== '29.97df') return nominalFrames;
  const totalMinutes = timecode.hours * 60 + timecode.minutes;
  return nominalFrames - 2 * (totalMinutes - Math.floor(totalMinutes / 10));
}

function validateMediaFolders(
  folders: z.infer<typeof linkMediaFolderSchema>[],
  folderIds: Set<string>,
  ctx: z.RefinementCtx
): void {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  for (const [folderIndex, folder] of folders.entries()) {
    if (folder.parentId !== null && !folderIds.has(folder.parentId)) {
      ctx.addIssue({
        code: 'custom',
        message: `资源文件夹引用不存在的父文件夹：${folder.parentId}`,
        path: ['mediaFolders', folderIndex, 'parentId']
      });
      continue;
    }
    const visited = new Set<string>([folder.id]);
    let parentId = folder.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        ctx.addIssue({
          code: 'custom',
          message: `资源文件夹层级存在循环：${folder.name}`,
          path: ['mediaFolders', folderIndex, 'parentId']
        });
        break;
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }
}

function validateDropFrameBoundary(
  timecode: { minutes: number; seconds: number; frames: number },
  frameRate: z.infer<typeof mtcFrameRateSchema>,
  path: PropertyKey[],
  ctx: z.RefinementCtx
): void {
  if (frameRate === '29.97df' && timecode.seconds === 0 && timecode.minutes % 10 !== 0 && timecode.frames < 2) {
    ctx.addIssue({
      code: 'custom',
      message: '29.97 drop-frame 在非整十分钟的整分钟处必须从 02 帧开始',
      path
    });
  }
}

function validateFrameNumber(
  frames: number,
  frameRate: z.infer<typeof mtcFrameRateSchema>,
  path: PropertyKey[],
  ctx: z.RefinementCtx
): void {
  const maxFrame = frameRate === '24' ? 23 : frameRate === '25' ? 24 : 29;
  if (frames > maxFrame) {
    ctx.addIssue({ code: 'custom', message: `帧号超出 ${frameRate} fps 范围`, path });
  }
}

function addUniqueId(ids: Set<string>, id: string, path: PropertyKey[], ctx: z.RefinementCtx): void {
  if (ids.has(id)) {
    ctx.addIssue({ code: 'custom', message: `ID 重复：${id}`, path });
    return;
  }
  ids.add(id);
}
