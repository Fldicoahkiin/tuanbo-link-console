import type { IntegrationProfile, MtcFrameRate } from '@tb/schema';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';

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
  const configured = ports.find((port) => port.direction === direction && port.state === 'connected' && port.name === configuredName);
  if (configured) return configured;
  const namedMatches = ports.filter((port) => port.direction === direction && port.state === 'connected' && /hirender|\bp1\b/i.test(port.name));
  if (namedMatches.length === 1) return namedMatches[0] ?? null;
  const connected = ports.filter((port) => port.direction === direction && port.state === 'connected');
  return connected.length === 1 ? connected[0] ?? null : null;
}
