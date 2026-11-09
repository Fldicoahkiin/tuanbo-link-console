import { requestMidiAccess, type MidiAccess, type MidiOutput } from './midi-access';
import { requireOutputLicense } from './license-output';
import { compileLightingPackets, compileLightingNetworkActions } from '@tb/core/link';
import { ma2NetworkStatusSchema, ma2PlaybackActionSchema, type Ma2PlaybackAction, type IntegrationProfile, type LightingDocument } from '@tb/schema';

/** A click may wait behind a sync job already on the wire; past this it is dropped, never sent late. */
const auditionDeadlineMs = 3000;

/** Explicit operator selection only; never called when restoring editor selection. */
export class LightingCueAudition {
  private readonly midiStarted = new Map<string, { output: MidiOutput; bytes: number[] }>();
  private generation = 0;
  private networkSession: string | null = null;
  private access: MidiAccess | null = null;
  /** Outputs opened for auditions; they stay open for the next click and close with `close()`. */
  private readonly ports = new Set<MidiOutput>();
  /** The editor closed: its MIDI outputs are let go, so P1 or playback can open them. */
  close(): void {
    this.cancel(); this.midiStarted.clear();
    for (const port of this.ports) void port.close().catch((error: unknown) => console.error(`MIDI 接口「${port.name}」关闭失败`, error));
    this.ports.clear();
  }
  cancel(): void { this.generation += 1; const id = this.networkSession; this.networkSession = null; if (id) void window.tbLink.cancelMa2Playback(id).catch((error: unknown) => console.error('取消 Cue 试听失败', error)); }

  /** Go continues on the console, including native triggers; no local next-Cue guessing. */
  async playAction(input: Ma2PlaybackAction): Promise<boolean> {
    this.cancel(); const generation = this.generation;
    const action = ma2PlaybackActionSchema.parse(input);
    const audition = await window.tbLink.controlMa2Audition({version:1,action:'status'});
    if(audition.phase==='stopping')throw new Error('正在停止试听，请稍后再点 Cue');
    const status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (generation !== this.generation) return false;
    if (status.state !== 'connected' || !status.settings) throw new Error('请先连接 MA2 网络');
    const { host, port, monitorPort, username } = status.settings;
    const sessionId = crypto.randomUUID(); this.networkSession = sessionId;
    try { await window.tbLink.playMa2Audition({ version:1,generation:audition.generation,sessionId, action, network: { host, port, monitorPort, username }, deadlineAt: Date.now() + auditionDeadlineMs }); }
    catch (error) { if (generation !== this.generation) return false; throw error; }
    return generation === this.generation;
  }

  /** A material click invokes its explicit Cue references, without inserting a timeline event. */
  async playTemplate(document: LightingDocument, templateId: string, profile: IntegrationProfile | null): Promise<number> {
    const template = document.templates.find(entry => entry.id === templateId);
    const stamp = template?.track.cueStamp;
    if (!template || stamp?.mode !== 'fixed') { this.cancel(); throw new Error('这个素材没有指定序列和 Cue，无法试听'); }
    const members = template.members ?? [{ sequence: stamp.sequence, cue: stamp.cue, name: template.name }];
    const events = members.map((member, index) => ({ id: `audition-${index}`, effectGroupId: 'audition-0', kind: 'ma2' as const, action: 'goto' as const, executor: '', sequence: member.sequence, cue: member.cue, label: member.name, at: 0 }));
    if (!events.length) { this.cancel(); throw new Error('素材中没有 Cue'); }
    return this.play({ ...document, ma2Bindings: [], tracks: [{ ...template.track, clips: [{ id: 'audition', name: template.name, start: 0, duration: 1, timeLock: 'time', muted: false, events }] }] }, 'audition-0', profile, true);
  }

  /** `network`: the MA2 connection this computer uses is the network, so executor Cues go there too instead of MIDI. */
  async play(document: LightingDocument, eventId: string, profile: IntegrationProfile | null, network: boolean): Promise<number> {
    this.cancel(); const generation = this.generation;
    const selected = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === eventId);
    if (!selected || selected.kind !== 'ma2') return 0;

    const group = selected.effectGroupId ?? selected.id;
    const native = document.ma2Bindings?.some(binding => binding.nativeEvents?.length || binding.playback === 'native-timecode');
    const selectedEvents = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.id === group || event.effectGroupId === group)));
    if (native && selectedEvents.some(event => event.kind !== 'ma2' || event.action !== 'goto' || !event.sequence || !event.cue)) throw new Error('控台时间线只能试听指定了序列和编号的 Cue');
    // This isolated operator audition contains only the explicitly selected Cue(s).
    // The original document and its native playback/writeback guards remain unchanged.
    const preview: LightingDocument = { ...document, ma2Bindings: [], tracks: document.tracks.map(track => ({
      ...track, muted: false, solo: false,
      clips: track.clips.map(clip => ({ ...clip, muted: false, start: 0, timeLock: 'time', events: clip.events.filter(event => event.kind === 'ma2' && (event.id === group || event.effectGroupId === group)).map(event => ({ ...event, ...(native ? { executor: '' } : {}), at: 0, preparation: undefined })) }))
    })) };
    const networkPlayback = native || network || preview.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.kind === 'ma2' && !event.executor)));
    if (networkPlayback) {
      const audition=await window.tbLink.controlMa2Audition({version:1,action:selected.runMode === 'independent' ? 'stop' : 'status'});
      if(audition.phase==='stopping')throw new Error('正在停止试听，请稍后再点 Cue');
      if (selected.runMode === 'independent' && audition.phase === 'failed') throw new Error('上一组试听没能停止，这个 Cue 没有发送');
      await requireOutputLicense();
      const status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
      if (generation !== this.generation) return 0;
      if (status.state !== 'connected' || !status.settings) throw new Error('序列池里的 Cue 通过网络播放，请先连接 MA2 网络（不需要绑定推杆或按键）');
      const { host, port, monitorPort, username } = status.settings;
      const actions = compileLightingNetworkActions(preview);
      const sessionId = crypto.randomUUID(); this.networkSession = sessionId;
      let count = 0;
      for (const entry of actions) {
        if (generation !== this.generation) return 0;
        try { await window.tbLink.playMa2Audition({ version:1,generation:audition.generation,sessionId, network: { host, port, monitorPort, username }, action: entry.action, deadlineAt: Date.now() + auditionDeadlineMs }); }
        catch (error) { if (generation !== this.generation) return 0; throw error; }
        count += 1;
      }
      return generation === this.generation ? count : 0;
    }
    await requireOutputLicense();
    const packets = compileLightingPackets(preview, profile?.lighting?.mscDeviceId ?? 127);
    try {
      const access = this.access ??= await deadline(requestMidiAccess(), '读取 MIDI 接口超时');
      if (generation !== this.generation) return 0;
      const outputs = new Map<string, MidiOutput>();
      for (const id of new Set(packets.map(packet => packet.portProfileId))) {
        const name = profile?.midiPortProfiles.find(port => port.id === id && port.direction === 'output')?.portName;
        const matches = [...access.outputs.values()].filter(port => port.name === name && port.state === 'connected');
        const port = matches[0];
        if (!port || matches.length !== 1) throw new Error(`Cue 的 MIDI 输出不可用，或有多个同名端口：${name || '请先一键连接或配置灯光动作输出'}`);
        this.ports.add(port);
        await deadline(port.open(), 'Cue MIDI 端口打开超时');
        if (generation !== this.generation) return 0;
        outputs.set(id, port);
      }
      if (selected.runMode === 'independent') for (const [key, previous] of this.midiStarted) {
        if (previous.output.state !== 'connected' || previous.output.connection !== 'open') throw new Error('上一组的 MIDI 输出已断开，无法确认已关闭，这个 Cue 没有发送');
        const separator = previous.bytes.indexOf(0, 6);
        previous.output.send([...previous.bytes.slice(0, 5), 0x0b, 48, 46, 48, 48, 48, 0, ...previous.bytes.slice(separator + 1)]);
        this.midiStarted.delete(key);
      }
      for (const packet of packets) {
        const output = outputs.get(packet.portProfileId);
        if (!output || output.state !== 'connected' || output.connection !== 'open') throw new Error(output?.closedReason ?? 'Cue 发送中断：MIDI 端口断开了，部分动作可能已经发出');
        output.send(packet.bytes);
        const separator = packet.bytes.indexOf(0, 6);
        if (packet.bytes[0] === 0xf0 && separator >= 6) {
          const key = `${packet.portProfileId}:${packet.bytes.slice(separator + 1).join(',')}`;
          if (packet.bytes[5] === 0x0b) this.midiStarted.delete(key); else this.midiStarted.set(key, { output, bytes: packet.bytes });
        }
      }
      return packets.length;
    } catch (error) {
      if (generation !== this.generation) return 0;
      throw error;
    }
  }
}

async function deadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), 5000); })]);
  } finally { clearTimeout(timer); }
}
