/** Routes the formal music engine through a selected Windows output endpoint. */
export class InternalAudioOutput {
  private context: AudioContext | null = null;
  private source: MediaElementAudioSourceNode | null = null;
  private monitor: MediaStreamAudioDestinationNode | null = null;

  async prepare(audio: HTMLAudioElement, deviceId: string, sampleRate: 44100 | 48000): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      this.source = this.context.createMediaElementSource(audio);
      this.source.connect(this.context.destination);
    }
    if (this.context.sampleRate !== sampleRate) throw new Error(`音频引擎采样率不匹配：需要 ${sampleRate} Hz，实际 ${this.context.sampleRate} Hz，请停止后重新播放`);
    const context = this.context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (!context.setSinkId) throw new Error('当前音频引擎不支持选择输出线路');
    await context.setSinkId(deviceId === 'default' ? '' : deviceId);
    await this.context.resume();
  }

  /** Each consumer owns its clone; stopping it must not close the shared music monitor. */
  captureMonitoringStream(): MediaStream | null {
    if (!this.context || !this.source) return null;
    if (this.monitor && !this.monitor.stream.active) {
      this.source.disconnect(this.monitor);
      this.monitor.disconnect();
      this.monitor = null;
    }
    if (!this.monitor) { this.monitor = this.context.createMediaStreamDestination(); this.source.connect(this.monitor); }
    return this.monitor.stream.clone();
  }

  async dispose(): Promise<void> {
    this.source?.disconnect(); this.monitor?.disconnect();
    this.monitor?.stream.getTracks().forEach((track) => track.stop());
    if (this.context) await this.context.close();
    this.context = null; this.source = null; this.monitor = null;
  }
}
