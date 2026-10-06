import { LightingNetworkOutput as NetworkOutput } from '@tb/core/link';

/** Browser host only; the scheduler itself has no page lifetime dependency. */
export class LightingNetworkOutput extends NetworkOutput {
  constructor() { super(window.tbLink, error => console.error('取消灯光网络输出失败', error)); }
}
