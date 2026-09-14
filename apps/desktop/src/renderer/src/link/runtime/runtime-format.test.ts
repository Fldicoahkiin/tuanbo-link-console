import { describe, expect, it } from 'vitest';
import { mtcDevicePresentation } from './runtime-format';

describe('mtcDevicePresentation', () => {
  it('只有最近 500ms 内收到 MTC 才显示运行中', () => {
    expect(mtcDevicePresentation({ runtimeState: 'running', detectedFrameRate: '30', lastMtcAt: 1_000, now: 1_500 }))
      .toEqual({ state: 'running', detail: '30' });
    expect(mtcDevicePresentation({ runtimeState: 'preflight', detectedFrameRate: '30', lastMtcAt: 1_000, now: 1_501 }))
      .toEqual({ state: 'notRunning', detail: '无信号' });
    expect(mtcDevicePresentation({ runtimeState: 'idle', detectedFrameRate: null, lastMtcAt: null, now: 1_000 }))
      .toEqual({ state: 'notRunning', detail: '无信号' });
  });

  it('时间码丢失时明确显示错误而不是沿用 running', () => {
    expect(mtcDevicePresentation({ runtimeState: 'timecodeLost', detectedFrameRate: '29.97df', lastMtcAt: 1_000, now: 2_000 }))
      .toEqual({ state: 'error', detail: '29.97df · 已丢失' });
  });
});
