import { parseIntegrationProfile, parseLinkProject, type IntegrationProfile, type LinkAction, type LinkProject, type MtcFrameRate } from '@tb/schema';
import { compileManagedMediaTimeline } from './managed-media-timeline';
import { clipObsTransform, obsMaterialPresentation } from './media-obs-transform';
import { validateP1TimecodeRanges } from './p1-auto-follow';
import { expectedMa2Shows, ma2ShowMismatch } from './ma2-show-identity';

export type PreflightMode = 'rehearsal' | 'live';
export type PreflightCheckStatus = 'passed' | 'warning' | 'blocking';

export type PreflightCheck = {
  id: string;
  label: string;
  status: PreflightCheckStatus;
  detail: string;
};

export type PreflightReport = {
  checkedAt: string;
  mode: PreflightMode;
  passed: boolean;
  checks: PreflightCheck[];
};

export type PreflightContext = {
  mode: PreflightMode;
  mtcRequirement: 'running' | 'start-on-go' | 'awaiting-external-start' | 'internal';
  internalMtcOutputEnabled?: boolean;
  project: LinkProject;
  profile: IntegrationProfile;
  currentItemId: string | null;
  referenceAssets: Record<string, { audioAvailable: boolean; waveformAvailable: boolean }>;
  mediaAssets: Record<string, { fileAvailable: boolean }>;
  obs: {
    authenticated: boolean;
    version: string | null;
    scenes: string[];
    inputs: string[];
    inputAudioStates: Record<string, { supported: boolean; muted: boolean | null; error: string | null }>;
    sceneItems: Record<string, string[]>;
    filters: Record<string, string[]>;
    transitions: string[];
    videoSettings?: { baseWidth: number; baseHeight: number; outputWidth?: number; outputHeight?: number };
  };
  midi: {
    ports: Array<{ name: string; direction: 'input' | 'output'; connected: boolean }>;
    mtcUpdating: boolean;
    mtcStable: boolean;
    detectedFrameRate: MtcFrameRate | null;
  };
  processes: {
    p1: { running: boolean; version: string | null };
  };
  availableDiskBytes: number;
  minimumDiskBytes: number;
  credentialsDecryptable: boolean;
  logRedactionReady: boolean;
  /** Show loaded on the connected MA2 console; absent when no console was queried. */
  ma2Show?: string;
  now?: () => string;
};

export function runLinkPreflight(context: PreflightContext): PreflightReport {
  const checks: PreflightCheck[] = [];
  let project: LinkProject;
  let profile: IntegrationProfile;
  try {
    project = parseLinkProject(context.project);
    if (context.mtcRequirement !== 'internal') validateP1TimecodeRanges(project);
    checks.push(passed('project.schema', '工程结构', '工程文件结构正常'));
  } catch (error) {
    checks.push(blocking('project.schema', '工程结构', toErrorMessage(error)));
    return report(context, checks);
  }
  try {
    profile = parseIntegrationProfile(context.profile);
    checks.push(passed('profile.schema', '本机设备设置', '本机设备设置正常'));
  } catch (error) {
    checks.push(blocking('profile.schema', '本机设备设置', toErrorMessage(error)));
    return report(context, checks);
  }

  const currentItem = context.currentItemId === null
    ? null
    : project.rundown.find((item) => item.id === context.currentItemId) ?? null;
  checks.push(currentItem?.enabled
    ? passed('project.currentItem', '当前节目', currentItem.title)
    : blocking('project.currentItem', '当前节目', currentItem ? '当前节目已停用' : '还没选择节目'));

  // Internal playback prepares one song at a time; unfinished neighbours must
  // not block it. P1/session preflight continues to inspect the whole rundown.
  if (context.mtcRequirement === 'internal') project = { ...project, rundown: currentItem ? [currentItem] : [] };

  for (const item of project.rundown.filter((candidate) => candidate.enabled)) {
    const expectedShows = expectedMa2Shows(project, item.id);
    if (context.ma2Show !== undefined && expectedShows.length) {
      const mismatch = ma2ShowMismatch(expectedShows, context.ma2Show);
      checks.push(mismatch ? warning(`ma2.show.${item.id}`, `MA2 控台 Show：${item.title}`, mismatch)
        : passed(`ma2.show.${item.id}`, `MA2 控台 Show：${item.title}`, context.ma2Show));
    }
    const incompatible = item.cues.filter((cue) => cue.enabled).flatMap((cue) => cue.actions).find((action) =>
      action.kind.startsWith('obs.') && action.kind !== 'obs.setProgramScene' && action.kind !== 'obs.setTransition' && action.kind !== 'obs.saveSourceScreenshot'
      // Show/hide source acts on the scene on program (operator decision 2026-10-19).
      && action.kind !== 'obs.setSceneItemEnabled');
    checks.push(incompatible
      ? blocking(`obs.sceneMode.${item.id}`, `完整场景模式：${item.title}`, `动作“${incompatible.label}”和完整场景模式冲突。请在这个节目的 Cue 编排里删掉这个动作，或停用它所在的 Cue；需要切换画面时，改用“切换完整场景”动作。`)
      : passed(`obs.sceneMode.${item.id}`, `完整场景模式：${item.title}`, '沿用 OBS 场景里的位置、裁剪和滤镜；本地画面素材只用来预览'));
    try {
      const timeline = compileManagedMediaTimeline(project, item.id);
      checks.push(passed(`media.timeline.${item.id}`, `媒体时间线：${item.title}`, `${timeline.events.length / 2} 个 OBS 媒体片段`));
    } catch (error) {
      checks.push(blocking(`media.timeline.${item.id}`, `媒体时间线：${item.title}`, toErrorMessage(error)));
    }
  }

  for (const item of project.rundown) {
    if (!item.enabled) continue;
    if (!item.referenceAudio) {
      checks.push(blocking(`asset.audio.${item.id}`, `参考音频：${item.title}`, '还没导入音频'));
      checks.push(blocking(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '没有音频，无法生成波形'));
      continue;
    }
    const availability = context.referenceAssets[item.id];
    checks.push(availability?.audioAvailable
      ? passed(`asset.audio.${item.id}`, `参考音频：${item.title}`, '文件可读')
      : blocking(`asset.audio.${item.id}`, `参考音频：${item.title}`, '音频文件不见了或读不了'));
    checks.push(availability?.waveformAvailable
      ? passed(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '波形缓存可用')
      : context.mtcRequirement === 'internal'
        ? warning(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '波形缓存不见了；不影响播放，可以在编辑器里重新生成')
        : blocking(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '波形缓存不见了，上场前必须重新生成'));
    for (const clip of item.referenceMediaClips) {
      const asset = project.mediaAssets.find((candidate) => candidate.id === clip.assetId);
      if (!asset) continue;
      // Only a clip whose look the project sends to OBS is sized by it; the others show as OBS has them (E16).
      // A mirror is a negative scale; a crop does not change how much the picture is enlarged (E17).
      const look = clipObsTransform(clip);
      const size = asset.width && asset.height ? { width: asset.width, height: asset.height } : null;
      const { scaleX, scaleY } = look && size ? obsMaterialPresentation(look, project.outputCanvas, size).sceneItemTransform : { scaleX: 1, scaleY: 1 };
      if (size && (Math.abs(scaleX) > 1 || Math.abs(scaleY) > 1)) {
        checks.push(warning(`quality.upscale.${clip.id}`, `素材清晰度：${asset.name}`,
          `原图 ${size.width}×${size.height}，会放大到约 ${Math.round(size.width * Math.abs(scaleX))}×${Math.round(size.height * Math.abs(scaleY))}；放大不会让画面更清晰`));
      }
      checks.push(context.mediaAssets[asset.id]?.fileAvailable
        ? passed(`asset.media.${clip.id}`, `时间线素材：${asset.name}`, '文件可读')
        : blocking(`asset.media.${clip.id}`, `时间线素材：${asset.name}`, '素材文件不见了或读不了'));
    }
  }

  checks.push(context.credentialsDecryptable
    ? passed('security.credentials', 'OBS 密码', '已保存的密码可以正常读取')
    : blocking('security.credentials', 'OBS 密码', '已保存的密码无法读取，请重新输入'));
  checks.push(context.logRedactionReady
    ? passed('security.redaction', '日志隐私处理', '日志会自动去掉隐私信息，自检通过')
    : blocking('security.redaction', '日志隐私处理', '日志隐私处理自检没通过'));
  checks.push(context.obs.authenticated
    ? passed('obs.authentication', 'OBS WebSocket', '已连接并登录')
    : blocking('obs.authentication', 'OBS WebSocket', '没连上或登录失败'));
  checks.push(outputCanvasCheck(context.obs));
  const video = context.obs.videoSettings;
  if (video?.outputWidth !== undefined && video.outputHeight !== undefined) {
    checks.push(video.outputWidth === video.baseWidth && video.outputHeight === video.baseHeight
      ? passed('quality.outputScale', 'OBS 输出像素', `${video.outputWidth}×${video.outputHeight}，与画布一致`)
      : warning('quality.outputScale', 'OBS 输出像素', `画布 ${video.baseWidth}×${video.baseHeight}，输出 ${video.outputWidth}×${video.outputHeight}；OBS 会缩放画面，可能不够清晰`));
  }

  if (context.obs.authenticated) {
    for (const item of project.rundown) {
      if (!item.enabled) continue;
      for (const cue of item.cues) {
        if (!cue.enabled) continue;
        for (const action of cue.actions) {
          const missing = missingObsTarget(action, context.obs);
          if (missing) checks.push(blocking(`target.${action.id}`, `动作目标：${action.label}`, missing));
        }
      }
    }
  }

  // The saved OBS version is an operator's test record, not a compatibility allowlist.
  checks.push(versionCheck('version.obs', 'OBS 版本', context.obs.version, profile.acceptedVersions.obs, true));
  if (context.mtcRequirement !== 'internal') {
  checks.push(p1AudioCheck(profile, context.obs));
  checks.push(context.processes.p1.running
    ? passed('process.p1', 'P1 进程', '运行中')
    : blocking('process.p1', 'P1 进程', '未运行'));
  checks.push(versionCheck('version.p1', 'P1 版本', context.processes.p1.version, profile.acceptedVersions.p1));
  }

  const inputProfile = profile.midiPortProfiles.find((port) => port.id === profile.p1.mtcInputPortProfileId);
  const outputProfiles = new Set(collectCueMidiOutputProfileIds(project));
  if (context.mtcRequirement === 'internal' && context.internalMtcOutputEnabled !== false && profile.internalPlayer?.mtcOutputPortProfileId) outputProfiles.add(profile.internalPlayer.mtcOutputPortProfileId);
  if (context.mtcRequirement === 'start-on-go') outputProfiles.add(profile.p1.controlOutputPortProfileId);
  if (context.mtcRequirement !== 'internal') checks.push(portCheck('midi.mtcInput', 'P1 MTC 输入', inputProfile, context.midi.ports));
  for (const profileId of outputProfiles) {
    const portProfile = profile.midiPortProfiles.find((port) => port.id === profileId);
    checks.push(portCheck(`midi.output.${profileId}`, `MIDI 输出：${profileId}`, portProfile, context.midi.ports));
  }
  if (context.mtcRequirement === 'internal') {
    checks.push(passed('clock.internal', '联动台播放', '按联动台的音频播放位置走，不需要 P1 或外部时间码'));
  } else if (context.mtcRequirement !== 'running') {
    if (context.mtcRequirement === 'start-on-go') checks.push(validateP1StartTrigger(currentItem, profile));
    checks.push(context.midi.mtcUpdating
      ? passed('mtc.updating', 'MTC 启动前状态', '时间码已经在走了；开始前请确认 P1 没有误播')
      : warning('mtc.updating', 'MTC 启动前状态', context.mtcRequirement === 'start-on-go'
        ? 'P1 还没播放；发出播放命令后 500 ms 内要收到时间码'
        : '还没收到时间码，只能等 P1 播放。收到信号后才会跟随；如果 P1 播放后还是没有信号，请检查 P1 的 MIDI 输出设备'));
    checks.push(context.midi.detectedFrameRate === null || context.midi.detectedFrameRate === profile.p1.expectedFrameRate
      ? context.midi.detectedFrameRate === null
        ? warning('mtc.frameRate', 'MTC 帧率', `开始后再确认 ${profile.p1.expectedFrameRate}`)
        : passed('mtc.frameRate', 'MTC 帧率', profile.p1.expectedFrameRate)
      : blocking('mtc.frameRate', 'MTC 帧率', `期望 ${profile.p1.expectedFrameRate}，检测到 ${context.midi.detectedFrameRate}`));
  } else {
    checks.push(context.midi.mtcUpdating
      ? passed('mtc.updating', 'MTC 更新', '时间码正在更新')
      : blocking('mtc.updating', 'MTC 更新', '连续 500 ms 没收到有效时间码'));
    checks.push(!context.midi.mtcUpdating
      ? blocking('mtc.stable', 'MTC 稳定性', '还没有持续的时间码，无法判断是否稳定')
      : context.midi.mtcStable
        ? passed('mtc.stable', 'MTC 稳定性', '时间码稳定')
        : blocking('mtc.stable', 'MTC 稳定性', '时间码有意外跳变'));
    checks.push(context.midi.detectedFrameRate === profile.p1.expectedFrameRate
      ? passed('mtc.frameRate', 'MTC 帧率', profile.p1.expectedFrameRate)
      : blocking('mtc.frameRate', 'MTC 帧率', `期望 ${profile.p1.expectedFrameRate}，检测到 ${context.midi.detectedFrameRate ?? '未知'}`));
  }
  if (context.mtcRequirement !== 'internal') checks.push(project.timebase.frameRate === profile.p1.expectedFrameRate
    ? passed('timebase.profileFrameRate', '工程与 P1 帧率', project.timebase.frameRate)
    : blocking(
      'timebase.profileFrameRate',
      '工程与 P1 帧率',
      `工程是 ${project.timebase.frameRate}，P1 设置是 ${profile.p1.expectedFrameRate}`
    ));

  checks.push(context.availableDiskBytes >= context.minimumDiskBytes
    ? passed('system.disk', '可用磁盘空间', `${context.availableDiskBytes} bytes`)
    : blocking('system.disk', '可用磁盘空间', `少于需要的 ${context.minimumDiskBytes} 字节`));
  return report(context, deduplicateChecks(checks));
}

function p1AudioCheck(profile: IntegrationProfile, obs: PreflightContext['obs']): PreflightCheck {
  const inputName = profile.p1.obsAudioInputName?.trim() ?? '';
  if (!inputName) return blocking('obs.p1AudioInput', 'P1 音乐进入 OBS', '还没选择 OBS 里接收 P1 音乐的音频输入');
  if (!obs.inputs.includes(inputName)) return blocking('obs.p1AudioInput', 'P1 音乐进入 OBS', `OBS 输入不存在：${inputName}`);
  const state = obs.inputAudioStates[inputName];
  if (!state?.supported) {
    return blocking('obs.p1AudioInput', 'P1 音乐进入 OBS', state?.error ?? `无法读取 ${inputName} 的音频状态`);
  }
  return state.muted
    ? blocking('obs.p1AudioInput', 'P1 音乐进入 OBS', `${inputName} 当前静音`)
    : passed('obs.p1AudioInput', 'P1 音乐进入 OBS', `${inputName} 存在且未静音`);
}

function outputCanvasCheck(obs: PreflightContext['obs']): PreflightCheck {
  const actual = obs.videoSettings;
  return actual
    ? passed('obs.outputCanvas', 'OBS 输出画布', `使用 OBS 现有的画布 ${actual.baseWidth}×${actual.baseHeight}`)
    : blocking('obs.outputCanvas', 'OBS 输出画布', '读不到 OBS 的画布设置，重新连接 OBS 后再检查');
}

function validateP1StartTrigger(
  item: LinkProject['rundown'][number] | null,
  profile: IntegrationProfile
): PreflightCheck {
  const trigger = item?.p1StartTrigger;
  if (!trigger) return blocking('p1.startTrigger', 'P1 播放触发', '当前节目还没设置 P1 播放触发');
  if (trigger.portProfileId !== profile.p1.controlOutputPortProfileId) {
    return blocking('p1.startTrigger', 'P1 播放触发', `端口设置必须是 ${profile.p1.controlOutputPortProfileId}`);
  }
  return passed('p1.startTrigger', 'P1 播放触发', `${trigger.label} · ${trigger.kind}`);
}

function missingObsTarget(action: LinkAction, obs: PreflightContext['obs']): string | null {
  switch (action.kind) {
    case 'obs.setProgramScene':
      if (!obs.scenes.includes(action.sceneName)) return `OBS 场景不存在：${action.sceneName}`;
      return action.transition && !obs.transitions.includes(action.transition.name) ? `OBS 转场不存在：${action.transition.name}` : null;
    case 'obs.setSceneItemEnabled':
    case 'obs.setSceneItemTransform':
    case 'obs.setSceneItemIndex':
      if (action.sceneName === '团播联动台输出') {
        return obs.inputs.includes(action.sourceName) || obs.scenes.includes(action.sourceName)
          ? null
          : `要加入联动台画面的 OBS 来源不存在：${action.sourceName}`;
      }
      if (!obs.scenes.includes(action.sceneName)) return `OBS 场景不存在：${action.sceneName}`;
      return obs.sceneItems[action.sceneName]?.includes(action.sourceName)
        ? null
        : `场景项不存在：${action.sceneName} / ${action.sourceName}`;
    case 'obs.setSourceFilterEnabled':
      if (!obs.inputs.includes(action.sourceName)) return `OBS 来源不存在：${action.sourceName}`;
      return obs.filters[action.sourceName]?.includes(action.filterName)
        ? null
        : `滤镜不存在：${action.sourceName} / ${action.filterName}`;
    case 'obs.setInputMute':
    case 'obs.setInputVolume':
    case 'obs.mediaAction':
      return obs.inputs.includes(action.inputName) ? null : `OBS 输入不存在：${action.inputName}`;
    case 'obs.setTransition':
      return obs.transitions.includes(action.transitionName) ? null : `OBS 转场不存在：${action.transitionName}`;
    case 'obs.saveSourceScreenshot':
      return obs.inputs.includes(action.sourceName) || Object.values(obs.sceneItems).some((items) => items.includes(action.sourceName))
        ? null
        : `OBS 来源不存在：${action.sourceName}`;
    case 'midi.noteOn':
    case 'midi.noteOff':
    case 'midi.controlChange':
    case 'midi.programChange':
    case 'midi.showControl':
      return null;
  }
}

export function collectCueMidiOutputProfileIds(project: LinkProject): string[] {
  const ids = new Set<string>();
  for (const item of project.rundown) {
    if (!item.enabled) continue;
    for (const cue of item.cues) {
      if (!cue.enabled) continue;
      for (const action of cue.actions) {
        switch (action.kind) {
          case 'midi.noteOn':
          case 'midi.noteOff':
          case 'midi.controlChange':
          case 'midi.programChange':
          case 'midi.showControl':
            ids.add(action.portProfileId);
            break;
          case 'obs.setProgramScene':
          case 'obs.setSceneItemEnabled':
          case 'obs.setSceneItemTransform':
          case 'obs.setSceneItemIndex':
          case 'obs.setSourceFilterEnabled':
          case 'obs.setInputMute':
          case 'obs.setInputVolume':
          case 'obs.mediaAction':
          case 'obs.setTransition':
          case 'obs.saveSourceScreenshot':
            break;
        }
      }
    }
  }
  return [...ids];
}

function portCheck(
  id: string,
  label: string,
  profile: IntegrationProfile['midiPortProfiles'][number] | undefined,
  ports: PreflightContext['midi']['ports']
): PreflightCheck {
  if (!profile) return blocking(id, label, '端口设置不存在');
  const matches = ports.filter((port) => port.direction === profile.direction && port.name === profile.portName && port.connected);
  if (matches.length === 1) return passed(id, label, profile.portName);
  return blocking(id, label, matches.length === 0 ? `端口不存在：「${profile.portName}」` : `端口名称不唯一：「${profile.portName}」`);
}

function versionCheck(
  id: string,
  label: string,
  actual: string | null,
  expected: string,
  warningOnly = false
): PreflightCheck {
  if (actual === expected) return passed(id, label, actual);
  if (warningOnly && actual !== null) return warning(id, label,
    `本机记录的 ${label}是 ${expected}，当前是 ${actual}；请在开播前确认画面播放、切换和停止正常`);
  const detail = `期望 ${expected}，检测到 ${actual ?? '未知'}`;
  return blocking(id, label, detail);
}

function report(context: PreflightContext, checks: PreflightCheck[]): PreflightReport {
  return {
    checkedAt: context.now?.() ?? new Date().toISOString(),
    mode: context.mode,
    passed: !checks.some((check) => check.status === 'blocking'),
    checks
  };
}

function deduplicateChecks(checks: PreflightCheck[]): PreflightCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    if (seen.has(check.id)) return false;
    seen.add(check.id);
    return true;
  });
}

function passed(id: string, label: string, detail: string): PreflightCheck {
  return { id, label, status: 'passed', detail };
}

function warning(id: string, label: string, detail: string): PreflightCheck {
  return { id, label, status: 'warning', detail };
}

function blocking(id: string, label: string, detail: string): PreflightCheck {
  return { id, label, status: 'blocking', detail };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
