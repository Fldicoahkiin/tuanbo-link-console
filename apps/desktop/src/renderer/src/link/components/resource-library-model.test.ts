import { describe, expect, it } from 'vitest';
import type { LinkObsInventory } from '@tb/core/link';
import { buildObsVisualResources } from './resource-library-model';

describe('OBS 可视采集媒体映射', () => {
  it('显示摄像头、媒体和场景音频，跨场景来源去重', () => {
    const inventory: LinkObsInventory = {
      scenes: ['主场景', '备用场景'],
      inputs: ['主摄像头', '片头视频', '人声'],
      inputKinds: {
        主摄像头: 'dshow_input',
        片头视频: 'ffmpeg_source',
        人声: 'wasapi_input_capture'
      },
      inputAudioStates: {},
      sceneItems: {
        主场景: ['主摄像头', '片头视频'],
        备用场景: ['主摄像头', '人声']
      },
      filters: { 主摄像头: ['调色'] },
      transitions: ['淡入淡出'],
      sourceSizes: {}
    };

    expect(buildObsVisualResources(inventory).map((resource) => resource.name).sort()).toEqual(['主摄像头', '人声', '片头视频'].sort());
    expect(buildObsVisualResources(inventory).filter((resource) => resource.group === '摄像头')).toEqual([{
      id: 'sceneItem:主场景:主摄像头',
      kind: 'sceneItem',
      name: '主摄像头',
      group: '摄像头',
      sceneName: '主场景',
      sourceName: '主摄像头',
      inputKind: 'dshow_input',
      canvasWidth: 1080,
      canvasHeight: 1920
    }]);
  });

  it('识别来源组和暂未放入场景的摄像头输入', () => {
    const inventory: LinkObsInventory = {
      scenes: ['主场景'],
      inputs: ['组内摄像头', 'NDI 机位'],
      inputKinds: { 组内摄像头: 'dshow_input', 'NDI 机位': 'ndi_source' },
      inputAudioStates: {},
      sceneItems: { 主场景: ['机位组'], 机位组: ['组内摄像头'] },
      filters: {},
      transitions: [],
      sourceSizes: {}
    };

    expect(buildObsVisualResources(inventory)).toEqual([
      {
        id: 'sceneItem:机位组:组内摄像头',
        kind: 'sceneItem',
        name: '组内摄像头',
        group: '摄像头',
        sceneName: '机位组',
        sourceName: '组内摄像头',
        inputKind: 'dshow_input',
        canvasWidth: 1080,
        canvasHeight: 1920
      },
      {
        id: 'input:NDI 机位',
        kind: 'input',
        name: 'NDI 机位',
        group: '摄像头',
        sourceName: 'NDI 机位',
        inputKind: 'ndi_source'
      }
    ]);
  });

  it('显示现场 OBS 的显示器采集并排除桌面音频', () => {
    const inventory: LinkObsInventory = {
      scenes: ['场景', '场景 2'],
      inputs: ['桌面音频', '显示器采集', '显示器采集 2'],
      inputKinds: {
        桌面音频: 'wasapi_output_capture',
        显示器采集: 'monitor_capture',
        '显示器采集 2': 'monitor_capture'
      },
      inputAudioStates: {},
      sceneItems: { 场景: ['显示器采集', '显示器采集 2'], '场景 2': [] },
      filters: {},
      transitions: [],
      sourceSizes: {}
    };

    expect(buildObsVisualResources(inventory)).toEqual([
      {
        id: 'sceneItem:场景:显示器采集',
        kind: 'sceneItem',
        name: '显示器采集',
        group: 'OBS 采集',
        sceneName: '场景',
        sourceName: '显示器采集',
        inputKind: 'monitor_capture',
        canvasWidth: 1080,
        canvasHeight: 1920
      },
      {
        id: 'sceneItem:场景:显示器采集 2',
        kind: 'sceneItem',
        name: '显示器采集 2',
        group: 'OBS 采集',
        sceneName: '场景',
        sourceName: '显示器采集 2',
        inputKind: 'monitor_capture',
        canvasWidth: 1080,
        canvasHeight: 1920
      }
    ]);
  });

  it('携带 OBS 当前画布尺寸和来源实际变换', () => {
    const transform = {
      positionX: 120,
      positionY: 240,
      scaleX: 0.5,
      scaleY: 0.75,
      rotation: 10,
      cropTop: 1,
      cropRight: 2,
      cropBottom: 3,
      cropLeft: 4,
      sourceWidth: 1920,
      sourceHeight: 1080,
      outputWidth: 958,
      outputHeight: 807,
      alignment: 5
    };
    const inventory: LinkObsInventory = {
      scenes: ['主场景'],
      inputs: ['主摄像头'],
      inputKinds: { 主摄像头: 'dshow_input' },
      inputAudioStates: {},
      sceneItems: { 主场景: ['主摄像头'] },
      filters: {},
      transitions: [],
      sourceSizes: {},
      videoSettings: { baseWidth: 1080, baseHeight: 1920 },
      sceneItemTransforms: { 主场景: { 主摄像头: transform } }
    };

    expect(buildObsVisualResources(inventory)[0]).toMatchObject({ transform, canvasWidth: 1080, canvasHeight: 1920 });
  });
});
