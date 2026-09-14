import { describe, expect, it } from 'vitest';
import type { IntegrationProfile } from '@tb/schema';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { applyDetectedP1MidiPorts, isMtcSignalReady } from './local-integration-midi';

describe('isMtcSignalReady', () => {
  const signal = { portConnected: true, stable: true, lastMtcAt: 1000, now: 1100, detectedFrameRate: '30' as const, expectedFrameRate: '30' as const };
  it('不能把枚举到 MIDI 端口当作收到时间码', () => {
    expect(isMtcSignalReady({ ...signal, lastMtcAt: null, stable: false, detectedFrameRate: null })).toBe(false);
  });
  it('仅新鲜稳定且帧率匹配的样本显示就绪，停止发送后取消就绪', () => {
    expect(isMtcSignalReady(signal)).toBe(true);
    expect(isMtcSignalReady({ ...signal, now: 1501 })).toBe(false);
    expect(isMtcSignalReady({ ...signal, stable: false })).toBe(false);
    expect(isMtcSignalReady({ ...signal, portConnected: false })).toBe(false);
    expect(isMtcSignalReady({ ...signal, detectedFrameRate: '25' })).toBe(false);
  });
});

describe('applyDetectedP1MidiPorts', () => {
  it('使用本次最新枚举的一对唯一端口完成 P1 自动配置', () => {
    const result = applyDetectedP1MidiPorts(profile('', ''), [
      port('input', '团播联动台 P1 MTC'),
      port('output', '团播联动台 P1 MTC')
    ]);

    expect(result.profile.midiPortProfiles).toEqual([
      { id: 'p1-mtc', direction: 'input', portName: '团播联动台 P1 MTC' },
      { id: 'p1-output', direction: 'output', portName: '团播联动台 P1 MTC' }
    ]);
    expect(result.issues).toEqual([]);
  });

  it('端口临时不可用时保留已有配置并明确报告', () => {
    const result = applyDetectedP1MidiPorts(profile('P1 MTC', 'P1 Control'), []);

    expect(result.profile.midiPortProfiles).toEqual([
      { id: 'p1-mtc', direction: 'input', portName: 'P1 MTC' },
      { id: 'p1-output', direction: 'output', portName: 'P1 Control' }
    ]);
    expect(result.issues).toEqual([
      'P1：已配置的 MTC 输入端口当前不可用：P1 MTC',
      'P1：已配置的控制输出端口当前不可用：P1 Control'
    ]);
  });

  it('直接由 P1 播放时不把未配置的可选控制输出误报为阻断', () => {
    const result = applyDetectedP1MidiPorts(profile('', ''), [port('input', 'P1 MTC')]);

    expect(result.profile.midiPortProfiles).toEqual([
      { id: 'p1-mtc', direction: 'input', portName: 'P1 MTC' },
      { id: 'p1-output', direction: 'output', portName: '' }
    ]);
    expect(result.issues).toEqual([]);
  });

  it('没有输入端口时明确提示验证 P1 发送链路', () => {
    const result = applyDetectedP1MidiPorts(profile('', ''), []);

    expect(result.issues).toEqual([
      'P1：未检测到可用的 MTC 输入端口；请建立已验证的输入链路，P1 对软件环回仍显示“未发送”时需使用物理 USB-MIDI OUT→IN'
    ]);
  });
});

function profile(inputPortName: string, outputPortName: string): IntegrationProfile {
  return {
    schemaVersion: 1,
    profileId: 'windows-stage',
    name: 'Windows 现场机器',
    updatedAt: '2026-08-28T00:00:00.000Z',
    obs: executable('C:\\OBS\\obs64.exe', { webSocketUrl: 'ws://127.0.0.1:4455', credentialId: 'obs-main' }),
    p1: {
      ...executable('C:\\P1\\P1.exe'),
      mtcInputPortProfileId: 'p1-mtc',
      controlOutputPortProfileId: 'p1-output',
      expectedFrameRate: '30',
      obsAudioInputName: ''
    },
    midiPortProfiles: [
      { id: 'p1-mtc', direction: 'input', portName: inputPortName },
      { id: 'p1-output', direction: 'output', portName: outputPortName }
    ],
    acceptedVersions: { obs: '32.2.2', p1: '1.14.2' }
  };
}

function executable<T extends Record<string, string>>(executablePath: string, extra?: T): {
  executablePath: string;
  arguments: string[];
  workingDirectory: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
} & T {
  return {
    executablePath,
    arguments: [],
    workingDirectory: executablePath.slice(0, executablePath.lastIndexOf('\\')),
    startupTimeoutMs: 20_000,
    shutdownTimeoutMs: 10_000,
    ...(extra ?? {} as T)
  };
}

function port(direction: MidiPortSnapshot['direction'], name: string): MidiPortSnapshot {
  return {
    id: `${direction}-${name}`,
    name,
    manufacturer: 'Microsoft Corporation',
    direction,
    state: 'connected',
    connection: 'closed'
  };
}
