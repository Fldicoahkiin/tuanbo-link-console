import { describe, expect, it } from 'vitest';
import { PreparationSteps, SLOW_PREPARATION_STEP_MS } from './preparation-log';

describe('PreparationSteps', () => {
  it('各步骤合成一份记录；明显偏慢的步骤当场单独报出', () => {
    const slow: [string, number][] = [];
    const steps = new PreparationSteps((step, ms) => slow.push([step, ms]));
    steps.add('设备检查', 12.4);
    steps.add('解码预填充', SLOW_PREPARATION_STEP_MS + 1);
    expect(slow).toEqual([['解码预填充', SLOW_PREPARATION_STEP_MS + 1]]);
    expect(steps.take()).toEqual([{ step: '设备检查', ms: 12 }, { step: '解码预填充', ms: SLOW_PREPARATION_STEP_MS + 1 }]);
    expect(steps.take()).toEqual([]);
  });
});
