import { parseIntegrationProfile, parseLinkProject, type IntegrationProfile, type LinkAction, type LinkProject, type MtcFrameRate } from '@tb/schema';
import { compileManagedMediaTimeline } from './managed-media-timeline';
import { validateP1TimecodeRanges } from './p1-auto-follow';

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
  now?: () => string;
};

export function runLinkPreflight(context: PreflightContext): PreflightReport {
  const checks: PreflightCheck[] = [];
  let project: LinkProject;
  let profile: IntegrationProfile;
  try {
    project = parseLinkProject(context.project);
    if (context.mtcRequirement !== 'internal') validateP1TimecodeRanges(project);
    checks.push(passed('project.schema', '工程结构', '工程结构和 ID 校验通过'));
  } catch (error) {
    checks.push(blocking('project.schema', '工程结构', toErrorMessage(error)));
    return report(context, checks);
  }
  try {
    profile = parseIntegrationProfile(context.profile);
    checks.push(passed('profile.schema', '集成档案', '本机集成档案校验通过'));
  } catch (error) {
    checks.push(blocking('profile.schema', '集成档案', toErrorMessage(error)));
    return report(context, checks);
  }

  const currentItem = context.currentItemId === null
    ? null
    : project.rundown.find((item) => item.id === context.currentItemId) ?? null;
  checks.push(currentItem?.enabled
    ? passed('project.currentItem', '当前节目', currentItem.title)
    : blocking('project.currentItem', '当前节目', currentItem ? '当前节目已停用' : '尚未选择有效的当前节目'));

  // Internal playback prepares one song at a time; unfinished neighbours must
  // not block it. P1/session preflight continues to inspect the whole rundown.
  if (context.mtcRequirement === 'internal') project = { ...project, rundown: currentItem ? [currentItem] : [] };

  for (const item of project.rundown.filter((candidate) => candidate.enabled)) {
    if (project.obsOutputMode === 'scenes') {
      const incompatible = item.cues.filter((cue) => cue.enabled).flatMap((cue) => cue.actions).find((action) =>
        action.kind.startsWith('obs.') && action.kind !== 'obs.setProgramScene' && action.kind !== 'obs.setTransition' && action.kind !== 'obs.saveSourceScreenshot');
      checks.push(incompatible
        ? blocking(`obs.sceneMode.${item.id}`, `完整场景模式：${item.title}`, `动作“${incompatible.label}”与完整场景模式冲突。请在该节目的 Cue 编排中移除此动作或停用所在 Cue；需要切换画面时，改用“切换完整场景”动作。`)
        : passed(`obs.sceneMode.${item.id}`, `完整场景模式：${item.title}`, '保留 OBS 场景的变换、裁剪和滤镜；本地视觉素材仅用于参考预览'));
    }
    try {
      const timeline = compileManagedMediaTimeline(project, item.id);
      checks.push(passed(`media.timeline.${item.id}`, `正式媒体时间线：${item.title}`, `${timeline.events.length / 2} 个 OBS 媒体片段`));
    } catch (error) {
      checks.push(blocking(`media.timeline.${item.id}`, `正式媒体时间线：${item.title}`, toErrorMessage(error)));
    }
  }

  for (const item of project.rundown) {
    if (!item.enabled) continue;
    if (!item.referenceAudio) {
      checks.push(blocking(`asset.audio.${item.id}`, `参考音频：${item.title}`, '尚未导入参考音频'));
      checks.push(blocking(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '缺少参考音频，无法生成波形缓存'));
      continue;
    }
    const availability = context.referenceAssets[item.id];
    checks.push(availability?.audioAvailable
      ? passed(`asset.audio.${item.id}`, `参考音频：${item.title}`, '文件可读')
      : blocking(`asset.audio.${item.id}`, `参考音频：${item.title}`, '参考音频缺失或不可读'));
    checks.push(availability?.waveformAvailable
      ? passed(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '波形缓存可用')
      : context.mtcRequirement === 'internal'
        ? warning(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '波形缓存缺失；不影响正式音频播放，可在编辑器重建')
        : blocking(`asset.waveform.${item.id}`, `波形缓存：${item.title}`, '波形缓存缺失，进入现场前必须重建'));
    for (const clip of item.referenceMediaClips) {
      const asset = project.mediaAssets.find((candidate) => candidate.id === clip.assetId);
      if (!asset) continue;
      const scaleX = clip.canvasTransform.scale * clip.canvasTransform.scaleX;
      const scaleY = clip.canvasTransform.scale * clip.canvasTransform.scaleY;
      if (asset.width && asset.height && (scaleX > 1 || scaleY > 1)) {
        checks.push(warning(`quality.upscale.${clip.id}`, `素材清晰度：${asset.name}`,
          `原始 ${asset.width}×${asset.height}，放大到约 ${Math.round(asset.width * scaleX)}×${Math.round(asset.height * scaleY)}；原文件未转码，放大不能增加真实细节`));
      }
      checks.push(context.mediaAssets[asset.id]?.fileAvailable
        ? passed(`asset.media.${clip.id}`, `时间线素材：${asset.name}`, '文件可读')
        : blocking(`asset.media.${clip.id}`, `时间线素材：${asset.name}`, '素材文件缺失或不可读'));
    }
  }

  checks.push(context.credentialsDecryptable
    ? passed('security.credentials', 'OBS 凭证', '凭证可由 Windows 安全存储解密')
    : blocking('security.credentials', 'OBS 凭证', '凭证不可解密'));
  checks.push(context.logRedactionReady
    ? passed('security.redaction', '日志脱敏', '脱敏规则已启用并通过自检')
    : blocking('security.redaction', '日志脱敏', '日志脱敏规则未通过自检'));
  checks.push(context.obs.authenticated
    ? passed('obs.authentication', 'OBS WebSocket', '已认证')
    : blocking('obs.authentication', 'OBS WebSocket', '未连接或认证失败'));
  checks.push(outputCanvasCheck(project, context.obs));
  const video = context.obs.videoSettings;
  if (video?.outputWidth !== undefined && video.outputHeight !== undefined) {
    checks.push(video.outputWidth === video.baseWidth && video.outputHeight === video.baseHeight
      ? passed('quality.outputScale', 'OBS 输出像素', `${video.outputWidth}×${video.outputHeight}，与画布一致`)
      : warning('quality.outputScale', 'OBS 输出像素', `画布 ${video.baseWidth}×${video.baseHeight}，输出 ${video.outputWidth}×${video.outputHeight}；OBS 正在缩放，无法保证逐像素保真`));
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

  checks.push(versionCheck('version.obs', 'OBS 版本', context.obs.version, profile.acceptedVersions.obs));
  if (context.mtcRequirement !== 'internal') {
  checks.push(p1AudioCheck(profile, context.obs));
  checks.push(context.processes.p1.running
    ? passed('process.p1', 'P1 进程', '运行中')
    : blocking('process.p1', 'P1 进程', '未运行'));
  checks.push(versionCheck('version.p1', 'P1 版本', context.processes.p1.version, profile.acceptedVersions.p1));
  }

  const inputProfile = profile.midiPortProfiles.find((port) => port.id === profile.p1.mtcInputPortProfileId);
  const outputProfiles = new Set(collectOutputProfileIds(project));
  if (context.mtcRequirement === 'internal' && profile.internalPlayer?.mtcOutputPortProfileId) outputProfiles.add(profile.internalPlayer.mtcOutputPortProfileId);
  if (context.mtcRequirement === 'start-on-go') outputProfiles.add(profile.p1.controlOutputPortProfileId);
  if (context.mtcRequirement !== 'internal') checks.push(portCheck('midi.mtcInput', 'P1 MTC 输入', inputProfile, context.midi.ports));
  for (const profileId of outputProfiles) {
    const portProfile = profile.midiPortProfiles.find((port) => port.id === profileId);
    checks.push(portCheck(`midi.output.${profileId}`, `MIDI 输出：${profileId}`, portProfile, context.midi.ports));
  }
  if (context.mtcRequirement === 'internal') {
    checks.push(passed('clock.internal', '内部音频主控', '使用实际音频播放位置；不依赖 P1 或外部时间码输入'));
  } else if (context.mtcRequirement !== 'running') {
    if (context.mtcRequirement === 'start-on-go') checks.push(validateP1StartTrigger(currentItem, profile));
    checks.push(context.midi.mtcUpdating
      ? passed('mtc.updating', 'MTC 启动前状态', '时间码已经在更新；启动前请确认 P1 未误播素材')
      : warning('mtc.updating', 'MTC 启动前状态', context.mtcRequirement === 'start-on-go'
        ? 'P1 尚未播放；发送播放命令后 500ms 内必须收到时间码'
        : '尚未收到时间码，仅允许等待 P1；收到真实信号后才会跟随，播放后仍无信号请检查 P1 的 MIDI 输出设备'));
    checks.push(context.midi.detectedFrameRate === null || context.midi.detectedFrameRate === profile.p1.expectedFrameRate
      ? context.midi.detectedFrameRate === null
        ? warning('mtc.frameRate', 'MTC 帧率', `启动后验证 ${profile.p1.expectedFrameRate}`)
        : passed('mtc.frameRate', 'MTC 帧率', profile.p1.expectedFrameRate)
      : blocking('mtc.frameRate', 'MTC 帧率', `期望 ${profile.p1.expectedFrameRate}，检测到 ${context.midi.detectedFrameRate}`));
  } else {
    checks.push(context.midi.mtcUpdating
      ? passed('mtc.updating', 'MTC 更新', '时间码正在更新')
      : blocking('mtc.updating', 'MTC 更新', '连续 500ms 未收到有效时间码'));
    checks.push(!context.midi.mtcUpdating
      ? blocking('mtc.stable', 'MTC 稳定性', '尚无持续时间码，无法判断稳定性')
      : context.midi.mtcStable
        ? passed('mtc.stable', 'MTC 稳定性', '时间码稳定')
        : blocking('mtc.stable', 'MTC 稳定性', '时间码存在非预期跳变'));
    checks.push(context.midi.detectedFrameRate === profile.p1.expectedFrameRate
      ? passed('mtc.frameRate', 'MTC 帧率', profile.p1.expectedFrameRate)
      : blocking('mtc.frameRate', 'MTC 帧率', `期望 ${profile.p1.expectedFrameRate}，检测到 ${context.midi.detectedFrameRate ?? '未知'}`));
  }
  if (context.mtcRequirement !== 'internal') checks.push(project.timebase.frameRate === profile.p1.expectedFrameRate
    ? passed('timebase.profileFrameRate', '工程与 P1 帧率', project.timebase.frameRate)
    : blocking(
      'timebase.profileFrameRate',
      '工程与 P1 帧率',
      `工程为 ${project.timebase.frameRate}，P1 档案为 ${profile.p1.expectedFrameRate}`
    ));

  checks.push(context.availableDiskBytes >= context.minimumDiskBytes
    ? passed('system.disk', '可用磁盘空间', `${context.availableDiskBytes} bytes`)
    : blocking('system.disk', '可用磁盘空间', `低于要求 ${context.minimumDiskBytes} bytes`));
  return report(context, deduplicateChecks(checks));
}

function p1AudioCheck(profile: IntegrationProfile, obs: PreflightContext['obs']): PreflightCheck {
  const inputName = profile.p1.obsAudioInputName?.trim() ?? '';
  if (!inputName) return blocking('obs.p1AudioInput', 'P1 正式音频进入 OBS', '尚未选择承载 P1 正式音乐的 OBS 音频输入');
  if (!obs.inputs.includes(inputName)) return blocking('obs.p1AudioInput', 'P1 正式音频进入 OBS', `OBS 输入不存在：${inputName}`);
  const state = obs.inputAudioStates[inputName];
  if (!state?.supported) {
    return blocking('obs.p1AudioInput', 'P1 正式音频进入 OBS', state?.error ?? `无法读取 ${inputName} 的音频状态`);
  }
  return state.muted
    ? blocking('obs.p1AudioInput', 'P1 正式音频进入 OBS', `${inputName} 当前静音`)
    : passed('obs.p1AudioInput', 'P1 正式音频进入 OBS', `${inputName} 存在且未静音`);
}

function outputCanvasCheck(project: LinkProject, obs: PreflightContext['obs']): PreflightCheck {
  const expected = project.outputCanvas;
  const actual = obs.videoSettings;
  if (project.obsOutputMode === 'scenes' && actual) return passed('obs.outputCanvas', 'OBS 输出画布', `使用 OBS 已有场景画布 ${actual.baseWidth}×${actual.baseHeight}`);
  if (!actual) {
    return blocking('obs.outputCanvas', 'OBS 输出画布', `无法读取 OBS 画布；工程要求 ${expected.width}×${expected.height}`);
  }
  return actual.baseWidth === expected.width && actual.baseHeight === expected.height
    ? passed('obs.outputCanvas', 'OBS 输出画布', `${expected.width}×${expected.height}`)
    : blocking(
      'obs.outputCanvas',
      'OBS 输出画布',
      `工程要求 ${expected.width}×${expected.height}，OBS 当前为 ${actual.baseWidth}×${actual.baseHeight}`
    );
}

function validateP1StartTrigger(
  item: LinkProject['rundown'][number] | null,
  profile: IntegrationProfile
): PreflightCheck {
  const trigger = item?.p1StartTrigger;
  if (!trigger) return blocking('p1.startTrigger', 'P1 播放触发', '当前节目尚未配置 P1 播放触发');
  if (trigger.portProfileId !== profile.p1.controlOutputPortProfileId) {
    return blocking('p1.startTrigger', 'P1 播放触发', `端口档案必须为 ${profile.p1.controlOutputPortProfileId}`);
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
          : `可加入受管输出的 OBS 来源不存在：${action.sourceName}`;
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

function collectOutputProfileIds(project: LinkProject): string[] {
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
  if (!profile) return blocking(id, label, '端口档案不存在');
  const matches = ports.filter((port) => port.direction === profile.direction && port.name === profile.portName && port.connected);
  if (matches.length === 1) return passed(id, label, profile.portName);
  return blocking(id, label, matches.length === 0 ? `端口不存在：${profile.portName}` : `端口名称不唯一：${profile.portName}`);
}

function versionCheck(
  id: string,
  label: string,
  actual: string | null,
  expected: string,
  warningOnly = false
): PreflightCheck {
  if (actual === expected) return passed(id, label, actual);
  const detail = `期望 ${expected}，检测到 ${actual ?? '未知'}`;
  return warningOnly ? warning(id, label, detail) : blocking(id, label, detail);
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
