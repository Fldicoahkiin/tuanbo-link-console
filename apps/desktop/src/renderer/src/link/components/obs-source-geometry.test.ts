import { describe, expect, it } from 'vitest';
import type { LinkObsInventory, LinkObsSceneItemTransform } from '@tb/core/link';
import { hasVisibleObsPreviewPixels, obsPreviewRequestSize, obsSourceSizeOnCanvas, resolveObsSceneItemGeometry, resolveObsSourceSize } from './obs-source-geometry';

const landscape = geometry(1920, 1080);
const portrait = geometry(1080, 1920);

describe('OBS 来源原始尺寸', () => {
  it('优先使用目标场景的精确场景项数据', () => {
    const inventory = createInventory({
      原场景: { 显示器采集: landscape },
      团播联动台输出: { 显示器采集: portrait }
    });

    expect(resolveObsSceneItemGeometry(inventory, '团播联动台输出', '显示器采集')).toBe(portrait);
    expect(resolveObsSourceSize(inventory, '团播联动台输出', '显示器采集')).toEqual({ width: 1080, height: 1920 });
  });

  it('受管场景尚未创建场景项时仍按同一 OBS 来源读取原始尺寸', () => {
    const inventory = createInventory({ 原场景: { 显示器采集: landscape } });

    expect(resolveObsSceneItemGeometry(inventory, '团播联动台输出', '显示器采集')).toBeNull();
    expect(resolveObsSourceSize(inventory, '团播联动台输出', '显示器采集')).toEqual({ width: 1920, height: 1080 });
  });

  it('目标场景返回 0×0 时拒绝伪造 1×1，并改用其他场景的有效来源尺寸', () => {
    const inventory = createInventory({
      原场景: { 显示器采集: portrait },
      团播联动台输出: { 显示器采集: geometry(0, 0) }
    });

    expect(resolveObsSourceSize(inventory, '团播联动台输出', '显示器采集')).toEqual({ width: 1080, height: 1920 });
    expect(resolveObsSourceSize(createInventory({ 场景: { 显示器采集: geometry(0, 0) } }), '场景', '显示器采集')).toBeNull();
  });

  it('场景项为 0×0 时使用 OBS 适配器解析出的来源尺寸', () => {
    const inventory = createInventory({ 团播联动台输出: { 显示器采集: geometry(0, 0) } });
    inventory.sourceSizes['显示器采集'] = { width: 1920, height: 1080 };

    expect(resolveObsSourceSize(inventory, '团播联动台输出', '显示器采集')).toEqual({ width: 1920, height: 1080 });
  });

  it('不同场景返回冲突尺寸时明确拒绝猜测', () => {
    const inventory = createInventory({ 场景一: { 显示器采集: landscape }, 场景二: { 显示器采集: portrait } });

    expect(resolveObsSourceSize(inventory, '团播联动台输出', '显示器采集')).toBeNull();
  });

  it('来源不存在时不把输出画布冒充成来源尺寸', () => {
    expect(resolveObsSourceSize(createInventory({}), '团播联动台输出', '显示器采集')).toBeNull();
  });

  it('原始大小保持来源像素比例并允许超出竖屏输出边界', () => {
    const size = obsSourceSizeOnCanvas({ width: 1920, height: 1080 }, { width: 1080, height: 1920 });

    expect(size.width).toBeCloseTo(177.7778, 4);
    expect(size.height).toBeCloseTo(56.25, 4);
  });

  it('预览截图保持比例、限制带宽并满足 OBS 最小 8px 参数', () => {
    expect(obsPreviewRequestSize({ width: 1920, height: 1080 })).toEqual({ width: 960, height: 540 });
    expect(obsPreviewRequestSize({ width: 1080, height: 1920 })).toEqual({ width: 540, height: 960 });
    expect(obsPreviewRequestSize({ width: 1, height: 1 })).toEqual({ width: 8, height: 8 });
    expect(() => obsPreviewRequestSize({ width: 0, height: 1080 })).toThrow('来源尺寸无效');
  });

  it('全透明预览不是可见 OBS 画面', () => {
    expect(hasVisibleObsPreviewPixels(new Uint8ClampedArray([255, 255, 255, 0, 16, 32, 64, 0]))).toBe(false);
    expect(hasVisibleObsPreviewPixels(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(true);
    expect(() => hasVisibleObsPreviewPixels(new Uint8ClampedArray([0, 0, 0]))).toThrow('预览画面数据有误');
  });
});

function createInventory(sceneItemTransforms: NonNullable<LinkObsInventory['sceneItemTransforms']>): LinkObsInventory {
  return {
    scenes: [],
    inputs: [],
    inputKinds: {},
    inputAudioStates: {},
    sceneItems: {},
    filters: {},
    transitions: [],
    sourceSizes: {},
    sceneItemTransforms
  };
}

function geometry(sourceWidth: number, sourceHeight: number): LinkObsSceneItemTransform {
  return {
    positionX: 0,
    positionY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    cropTop: 0,
    cropRight: 0,
    cropBottom: 0,
    cropLeft: 0,
    alignment: 0,
    sourceWidth,
    sourceHeight,
    outputWidth: sourceWidth,
    outputHeight: sourceHeight
  };
}
