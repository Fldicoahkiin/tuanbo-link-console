import { LightingNetworkOutput as NetworkOutput } from '@tb/core/link';

/** Browser host only; the scheduler itself has no page lifetime dependency. */
export class LightingNetworkOutput extends NetworkOutput {
  constructor() {
    super({
      getMa2NetworkStatus: () => window.tbLink.getMa2NetworkStatus(),
      cancelMa2Playback: sessionId => window.tbLink.cancelMa2Playback(sessionId),
      playMa2Cue: request => window.tbLink.playMa2Cue(request)
    }, error => console.error('取消灯光网络输出失败', error));
  }
}
