import type { LinkMidiAdapter } from '../../registry/link-midi-adapter';
import { useIntegrationStore } from '../stores/integration-store';
import { recordMidiPortUpdate } from './runtime-midi-log';

type MtcListener = Parameters<LinkMidiAdapter['subscribeMtc']>[2];

export class RuntimeMidiSession {
  private unsubscribeMtc: (() => void) | null = null;
  private unsubscribePorts: (() => void) | null = null;
  private subscriptionKey: string | null = null;
  constructor(private readonly midi: LinkMidiAdapter, private readonly projectId: string,
    private readonly receive: MtcListener, private readonly failed: (error: unknown) => void) {}

  async initialize(receiveTimecode: boolean): Promise<void> {
    if (!receiveTimecode) { this.unsubscribeMtc?.(); this.unsubscribeMtc = null; this.subscriptionKey = null; }
    useIntegrationStore.getState().setMidiPorts(await this.midi.initialize());
    this.unsubscribePorts?.();
    this.unsubscribePorts = this.midi.subscribePorts(next => {
      useIntegrationStore.getState().setMidiPorts(next);
      void recordMidiPortUpdate(this.projectId, next).catch(this.failed);
    });
    const profile = useIntegrationStore.getState().profile;
    if (!profile) throw new Error('尚未配置集成档案');
    const key = `${profile.p1.mtcInputPortProfileId}:${profile.p1.expectedFrameRate}`;
    if (receiveTimecode && (!this.unsubscribeMtc || this.subscriptionKey !== key || !this.midi.hasActiveMtcSubscription(profile.p1.mtcInputPortProfileId))) {
      this.unsubscribeMtc?.(); this.unsubscribeMtc = null; this.subscriptionKey = null;
      this.unsubscribeMtc = await this.midi.subscribeMtc(profile.p1.mtcInputPortProfileId, profile.p1.expectedFrameRate, this.receive);
      this.subscriptionKey = key;
    }
  }

  async waitForInput(timeoutMs: number): Promise<void> {
    const profile = useIntegrationStore.getState().profile;
    if (!profile) throw new Error('尚未配置集成档案');
    await this.midi.waitForConnectedInput(profile.p1.mtcInputPortProfileId, timeoutMs, ports => useIntegrationStore.getState().setMidiPorts(ports));
  }

  dispose(): void { this.unsubscribeMtc?.(); this.unsubscribePorts?.(); this.unsubscribeMtc = null; this.unsubscribePorts = null; this.subscriptionKey = null; }
}
