import { describe, expect, it } from 'vitest';
import { AUDIO_HRESULT, classifyAudioError, classifyMidiCode, classifyObsFailure, midiCodeFailure, OutputFailureRecord, outputFailureEffect, type OutputFailure } from './output-failure';

const item: OutputFailure = { scope: 'item', channel: 'obs', item: 'decoder:M1', kind: 'obs-request-rejected', detail: '被拒绝' };
const channel: OutputFailure = { scope: 'channel', channel: 'obs', kind: 'obs-disconnected', detail: '断开了' };
const waiting: OutputFailure = { scope: 'waiting', channel: 'obs', kind: 'reconnecting', detail: '正在重连' };

describe('只有整条通道坏了才停整路（2026-11-10 第 2 题，01 设计 4.5）', () => {
  it('OBS：断线和已发出的请求 2 秒没回应停整路；单个请求被拒绝、排队没发出只算这一项；没连上、过时算等待', () => {
    expect(classifyObsFailure({ kind: 'disconnected', detail: '断开了' }, 'program')).toMatchObject({ scope: 'channel', kind: 'obs-disconnected' });
    expect(classifyObsFailure({ kind: 'unanswered', label: '切场景' }, 'program')).toMatchObject({ scope: 'channel', kind: 'obs-unanswered' });
    expect(classifyObsFailure({ kind: 'owned-scene-missing', sceneName: '素材一', detail: '建不出来' }, 'program')).toMatchObject({ scope: 'channel' });
    expect(classifyObsFailure({ kind: 'rejected', label: '切场景', detail: '场景不存在' }, 'program')).toMatchObject({ scope: 'item', item: 'program', kind: 'obs-request-rejected' });
    expect(classifyObsFailure({ kind: 'queue-timeout', label: '开播素材' }, 'decoder:M1')).toMatchObject({ scope: 'item', kind: 'obs-request-not-sent' });
    expect(classifyObsFailure({ kind: 'not-connected' }, 'program')).toMatchObject({ scope: 'waiting', kind: 'not-connected' });
    expect(classifyObsFailure({ kind: 'superseded', label: '切场景' }, 'program')).toMatchObject({ scope: 'waiting', kind: 'superseded' });
  });

  it('MIDI：过期、SysEx 没发完、消息无效只丢这一条；接口没了、驱动没响应、被占用和不认识的错误码停整路', () => {
    expect([0, -7, -6, -1].map(classifyMidiCode)).toEqual(['ok', 'message', 'message', 'message']);
    expect([5, 6, -2, -4, 4, 7, -3, -5, 99].map(classifyMidiCode)).toEqual(Array(9).fill('channel'));
    expect(midiCodeFailure(-7, 'actionMidi', 'cue1', '晚了')).toMatchObject({ scope: 'item', kind: 'midi-message-late' });
    expect(midiCodeFailure(-1, 'mtc', 'frame', '失败')).toMatchObject({ scope: 'item', kind: 'mtc-send-failed' });
    expect(midiCodeFailure(5, 'mtc', 'frame', '拔了')).toMatchObject({ scope: 'channel', kind: 'midi-port-gone' });
    expect(midiCodeFailure(7, 'actionMidi', 'cue1', '占用')).toMatchObject({ scope: 'channel', kind: 'midi-port-busy' });
    expect(midiCodeFailure(-4, 'actionMidi', 'cue1', '没响应')).toMatchObject({ scope: 'channel', kind: 'midi-driver-unresponsive' });
    expect(midiCodeFailure(0, 'actionMidi', 'cue1', '')).toBeNull();
  });

  it('声卡：一次断流、一次时钟读数不准、一次读文件失败只算这一下；设备失效和其他错误停这首歌的音频', () => {
    expect(classifyAudioError(0, 'song', '')).toBeNull();
    expect(classifyAudioError(AUDIO_HRESULT.bufferError, 'song', '断流')).toMatchObject({ scope: 'item', kind: 'audio-underrun' });
    expect(classifyAudioError(0x88890018, 'song', '断流')).toMatchObject({ scope: 'item', kind: 'audio-underrun' });
    expect(classifyAudioError(AUDIO_HRESULT.timeSkew, 'song', '时钟')).toMatchObject({ scope: 'item', kind: 'audio-clock-skew' });
    expect(classifyAudioError(AUDIO_HRESULT.readFault, 'song', '读文件')).toMatchObject({ scope: 'item', kind: 'audio-read-failed' });
    expect(classifyAudioError(AUDIO_HRESULT.deviceInvalidated, 'song', '拔了')).toMatchObject({ scope: 'channel', kind: 'audio-device-invalidated' });
    expect(classifyAudioError(0x80004005, 'song', '其他')).toMatchObject({ scope: 'channel', kind: 'audio-device-failed' });
  });
});

describe('排练和直播的失败语义（AGENTS §4.8；00 设计 2 节第 8 条）', () => {
  it('直播：单条失败标红、接着走、可以补；通道失败停这一路；等待不算失败', () => {
    expect(outputFailureEffect('live', item)).toEqual({ stopChannel: false, holdLater: false, repair: true, mark: 'red' });
    expect(outputFailureEffect('live', channel)).toEqual({ stopChannel: true, holdLater: false, repair: false, mark: 'red' });
    expect(outputFailureEffect('live', waiting)).toEqual({ stopChannel: false, holdLater: false, repair: false, mark: 'none' });
  });

  it('排练：第一个失败挡住后面的动作，不补', () => {
    expect(outputFailureEffect('rehearsal', item)).toEqual({ stopChannel: false, holdLater: true, repair: false, mark: 'red' });
    expect(outputFailureEffect('rehearsal', channel)).toEqual({ stopChannel: true, holdLater: true, repair: false, mark: 'red' });
    expect(outputFailureEffect('rehearsal', waiting).holdLater).toBe(false);
    const record = new OutputFailureRecord('rehearsal');
    record.report(waiting);
    expect(record.holding).toBeNull();
    record.report(item);
    record.report({ ...item, item: 'decoder:M2' });
    expect(record.holding).toBe(item);
  });

  it('直播：失败只记在它自己那一项上，不挡别的；过了切点那一项清掉', () => {
    const record = new OutputFailureRecord('live');
    record.report(item);
    record.report({ ...item, item: 'decoder:M2' });
    expect(record.holding).toBeNull();
    expect(record.items().map(entry => entry.item)).toEqual(['decoder:M1', 'decoder:M2']);
    expect(record.stopped('obs')).toBe(false);
    record.clearItem('obs', 'decoder:M1');
    expect(record.items().map(entry => entry.item)).toEqual(['decoder:M2']);
    record.report(channel);
    expect(record.stopped('obs')).toBe(true);
    record.clearChannel('obs');
    expect(record.channels()).toEqual([]);
  });
});
