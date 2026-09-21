import type { IntegrationProfile, MtcFrameRate } from '@tb/schema';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';

export function applyDetectedLightingMidiPorts(profile: IntegrationProfile, ports: readonly MidiPortSnapshot[], internal: boolean): { profile: IntegrationProfile; issues: string[] } {
  let next = profile;
  const issues: string[] = [];
  const outputs = ports.filter(port => port.direction === 'output' && port.state === 'connected' && !/Microsoft GS Wavetable Synth/i.test(port.name));
  const mtcId = profile.internalPlayer?.mtcOutputPortProfileId ?? 'internal-mtc-output';
  const preferred = portName(profile, mtcId) || portName(profile, 'lighting-events-output');
  const roles = internal ? [[mtcId, '灯光时间码'], ['lighting-events-output', '灯光 Cue']] as const : [['lighting-events-output', '灯光 Cue']] as const;
  for (const [id, label] of roles) {
    const configured = portName(profile, id);
    const candidates = configured ? outputs.filter(port => port.name === configured) : preferred ? outputs.filter(port => port.name === preferred) : outputs;
    if (candidates.length !== 1) {
      issues.push(`${label}：${configured ? `已配置端口 ${configured} 不可用或名称重复` : outputs.length ? `检测到多个输出（${outputs.map(port => port.name).join('、')}），请在音频与 MIDI 选择控台端口` : '未检测到可用 MIDI 输出，请检查 USB-MIDI 接口和驱动'}`);
      continue;
    }
    next = updatePortProfile(next, id, 'output', candidates[0]!.name);
    if (internal && id === mtcId) next = { ...next, internalPlayer: { audioOutputDeviceId: 'default', ...next.internalPlayer, mtcOutputPortProfileId: mtcId } };
  }
  return { profile: next, issues };
}

export function internalMidiConnectionIssues(profile: IntegrationProfile, ports: readonly MidiPortSnapshot[]): string[] {
  const issues: string[] = [];
  for (const [id, direction, label] of [
    [profile.internalPlayer?.mtcOutputPortProfileId, 'output', '灯光 MIDI 时间码输出'],
    [profile.internalPlayer?.controlInputPortProfileId, 'input', '播放控制 MIDI 输入']
  ] as const) {
    if (!id) continue;
    const configured = profile.midiPortProfiles.find(port => port.id === id && port.direction === direction);
    if (!configured?.portName) { issues.push(`${label}：端口配置缺失，请在音频与 MIDI 中重新选择`); continue; }
    const matches = ports.filter(port => port.direction === direction && port.name === configured.portName && port.state === 'connected');
    if (matches.length !== 1) issues.push(`${label}：${configured.portName} ${matches.length === 0 ? '未检测到' : '名称重复'}，请在音频与 MIDI 中刷新并核对端口`);
  }
  return issues;
}

export function isMtcSignalReady(input: {
  portConnected: boolean;
  stable: boolean;
  lastMtcAt: number | null;
  now: number;
  detectedFrameRate: MtcFrameRate | null;
  expectedFrameRate: MtcFrameRate;
}): boolean {
  return input.portConnected && input.stable && input.lastMtcAt !== null
    && input.now >= input.lastMtcAt && input.now - input.lastMtcAt <= 500
    && input.detectedFrameRate === input.expectedFrameRate;
}

export function portName(profile: IntegrationProfile, profileId: string): string {
  return profile.midiPortProfiles.find((port) => port.id === profileId)?.portName ?? '';
}

export function updatePortProfile(
  profile: IntegrationProfile,
  profileId: string,
  direction: 'input' | 'output',
  portNameValue: string
): IntegrationProfile {
  const existing = profile.midiPortProfiles.some((port) => port.id === profileId);
  const midiPortProfiles = existing
    ? profile.midiPortProfiles.map((port) => port.id === profileId ? { ...port, direction, portName: portNameValue } : port)
    : [...profile.midiPortProfiles, { id: profileId, direction, portName: portNameValue }];
  return { ...profile, midiPortProfiles };
}

export function applyDetectedP1MidiPorts(
  profile: IntegrationProfile,
  ports: readonly MidiPortSnapshot[]
): { profile: IntegrationProfile; issues: string[] } {
  let next = profile;
  const issues: string[] = [];
  const configuredInputName = portName(next, 'p1-mtc');
  const inputMatch = resolveConfiguredOrNamedP1Port(next, ports, 'p1-mtc', 'input');
  if (inputMatch) next = updatePortProfile(next, 'p1-mtc', 'input', inputMatch.name);
  else if (configuredInputName !== '') issues.push(`P1：已配置的 MTC 输入端口当前不可用：${configuredInputName}`);
  else issues.push('P1：未检测到可用的 MTC 输入端口；请建立已验证的输入链路，P1 对软件环回仍显示“未发送”时需使用物理 USB-MIDI OUT→IN');

  const configuredOutputName = portName(next, 'p1-output');
  const outputMatch = resolveConfiguredOrNamedP1Port(next, ports, 'p1-output', 'output');
  if (outputMatch) next = updatePortProfile(next, 'p1-output', 'output', outputMatch.name);
  else if (configuredOutputName !== '') issues.push(`P1：已配置的控制输出端口当前不可用：${configuredOutputName}`);

  return { profile: next, issues };
}

function resolveConfiguredOrNamedP1Port(
  profile: IntegrationProfile,
  ports: readonly MidiPortSnapshot[],
  profileId: 'p1-mtc' | 'p1-output',
  direction: MidiPortSnapshot['direction']
): MidiPortSnapshot | null {
  const configuredName = portName(profile, profileId);
  if (configuredName) {
    const configured = ports.filter((port) => port.direction === direction && port.state === 'connected' && port.name === configuredName);
    return configured.length === 1 ? configured[0] ?? null : null;
  }
  const namedMatches = ports.filter((port) => port.direction === direction && port.state === 'connected' && /hirender|\bp1\b/i.test(port.name));
  if (namedMatches.length === 1) return namedMatches[0] ?? null;
  const connected = ports.filter((port) => port.direction === direction && port.state === 'connected');
  return connected.length === 1 ? connected[0] ?? null : null;
}
