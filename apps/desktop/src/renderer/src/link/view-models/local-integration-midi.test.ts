import { describe, expect, it } from 'vitest';
import type { IntegrationProfile } from '@tb/schema';
import type { MidiPortSnapshot } from '../../registry/link-midi-adapter';
import { applyDetectedP1MidiPorts, applyDetectedLightingMidiPorts, internalMidiConnectionIssues, isMtcSignalReady } from './local-integration-midi';

it('本机一键连接检查配置的输出，不将缺失、错误方向或同名重复报告为正常', () => {
  const configured = { ...profile('', 'MA2'), internalPlayer: { mtcOutputPortProfileId: 'p1-output', audioOutputDeviceId: 'default' } };
  expect(internalMidiConnectionIssues(configured, [port('output', 'MA2')])).toEqual([]);
  expect(internalMidiConnectionIssues(configured, [port('input', 'MA2')])).toEqual([expect.stringContaining('找不到')]);
  expect(internalMidiConnectionIssues(configured, [port('output', 'MA2'), port('output', 'MA2')])).toEqual([expect.stringContaining('有重名')]);
  expect(internalMidiConnectionIssues({ ...configured, midiPortProfiles: [] }, [])).toEqual([expect.stringContaining('没有设置端口')]);
  expect(configured.midiPortProfiles[1]?.portName).toBe('MA2');
});

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
      'P1：设置的 MTC 输入端口现在不可用：P1 MTC',
      'P1：设置的控制输出端口现在不可用：P1 Control'
    ]);
  });

  it('已配置端口缺失或重复时不会改选其他可用端口', () => {
    const configured = profile('P1 MTC', 'P1 Control');
    for (const ports of [
      [port('input', '另一个 P1'), port('output', '其他设备')],
      [port('input', 'P1 MTC'), port('input', 'P1 MTC'), port('output', 'P1 Control'), port('output', 'P1 Control')]
    ]) {
      const result = applyDetectedP1MidiPorts(configured, ports);
      expect(result.profile).toEqual(configured);
      expect(result.issues).toHaveLength(2);
    }
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
      'P1：找不到可用的 MTC 输入端口。请先接好输入；如果用软件环回时 P1 仍显示“未发送”，需要用实体 USB-MIDI 的 OUT 接到 IN'
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


describe('灯光一键检测与配置', () => {
  it('唯一 MIDI 输出同时用于本机 MTC 与 Cue，忽略 Windows 合成器', () => {
    const result = applyDetectedLightingMidiPorts(profile('', ''), [port('output', 'USB MIDI'), port('output', 'Microsoft GS Wavetable Synth')], true);
    expect(result.issues).toEqual([]);
    expect(result.profile.internalPlayer?.mtcOutputPortProfileId).toBe('internal-mtc-output');
    expect(result.profile.midiPortProfiles.filter(value => value.id === 'internal-mtc-output' || value.id === 'lighting-events-output').map(value => value.portName)).toEqual(['USB MIDI', 'USB MIDI']);
  });
  it('多个输出要求明确选择，不随便选第一个；已配置端口缺失不换线', () => {
    const ports = [port('output', 'USB A'), port('output', 'USB B')];
    expect(applyDetectedLightingMidiPorts(profile('', ''), ports, true).issues).toHaveLength(2);
    const configured = { ...profile('', ''), internalPlayer: { mtcOutputPortProfileId: 'p1-output', audioOutputDeviceId: 'default' }, midiPortProfiles: [{ id: 'p1-mtc', direction: 'input' as const, portName: '' }, { id: 'p1-output', direction: 'output' as const, portName: '旧控台' }] };
    const result = applyDetectedLightingMidiPorts(configured, ports, true);
    expect(result.profile).toEqual(configured); expect(result.issues).toHaveLength(2);
  });
  it('多个输出时复用明确配置的控台端口，P1 模式不创建本机 MTC 输出', () => {
    const configured = profile('', ''); configured.midiPortProfiles.push({ id: 'lighting-events-output', direction: 'output', portName: 'USB B' });
    const result = applyDetectedLightingMidiPorts(configured, [port('output', 'USB A'), port('output', 'USB B')], false);
    expect(result.issues).toEqual([]); expect(result.profile.internalPlayer).toBeUndefined();
  });
});
