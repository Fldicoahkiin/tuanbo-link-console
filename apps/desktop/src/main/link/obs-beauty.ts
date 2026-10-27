import { z } from 'zod';
import { beautyApplySchema, beautyBasicValuesSchema, beautyTargetSchema, beautyRuntimeKeys, type BeautyApply, type BeautyFilterState, type BeautyTarget } from '@tb/schema';
import type { OBSWebSocket } from 'obs-websocket-js';
import type { ObsOperationRunner } from './obs-request-scheduler';

const settingsSchema = z.object({ controls_version: z.literal(14), uniform_controls: z.boolean().optional(), live_mode: z.boolean().optional(),
  smooth: z.number().min(0).max(1).optional(), white: z.number().min(0).max(1).optional(),
  slim: z.number().min(0).max(1).optional(), eye: z.number().min(0).max(1).optional(),
  exposure: z.number().min(-1).max(1).optional(), contrast: z.number().min(-1).max(1).optional(),
  saturation: z.number().min(-1).max(1).optional(), temperature: z.number().min(-1).max(1).optional(), sharpen: z.number().min(0).max(1).optional(),
  texture: z.number().min(0).max(1).optional(), evenSkin: z.number().min(0).max(1).optional(), shine: z.number().min(0).max(1).optional(),
  nose: z.number().min(0).max(1).optional(), noseLength: z.number().min(-1).max(1).optional(),
  mouth: z.number().min(-1).max(1).optional(), eyeDistance: z.number().min(-1).max(1).optional(), lipstick: z.number().min(0).max(1).optional(),
  teeth: z.number().min(0).max(1).optional(),
  lipstickTone: z.number().min(-1).max(1).optional(), blushTone: z.number().min(-1).max(1).optional(),
  brow: z.number().min(0).max(1).optional(), eyeliner: z.number().min(0).max(1).optional(), blush: z.number().min(0).max(1).optional(),
  jaw: z.number().min(0).max(1).optional(), cheek: z.number().min(0).max(1).optional(),
  chin: z.number().min(-1).max(1).optional(), forehead: z.number().min(-1).max(1).optional(), darkCircles: z.number().min(0).max(1).optional(), nasolabial: z.number().min(0).max(1).optional(), blemish: z.number().min(0).max(1).optional(), bodySlim: z.number().min(0).max(1).optional(), waist: z.number().min(0).max(1).optional(), shoulder: z.number().min(-1).max(1).optional(), neck: z.number().min(0).max(1).optional(), legSlim: z.number().min(0).max(1).optional(), legLength: z.number().min(0).max(1).optional() });

/** Edits only an explicitly selected instance of our filter; never changes the filter chain or its enabled state. */
export class ObsBeauty {
  constructor(private readonly client: OBSWebSocket,
    private readonly request: <T>(operation: () => Promise<T>, label: string) => Promise<T>,
    private readonly run: ObsOperationRunner) {}

  async programScene(): Promise<string> {
    return this.run(async () => {
      const result = await this.request(() => this.client.call('GetCurrentProgramScene'), '读取美颜完整输出场景');
      return z.string().min(1).parse(result.currentProgramSceneName);
    });
  }

  async disable(target: BeautyTarget): Promise<void> {
    const parsed = beautyTargetSchema.parse(target);
    await this.run(async () => {
      await this.readFilter(parsed);
      await this.request(() => this.client.call('SetSourceFilterEnabled', { ...parsed, filterEnabled: false }), '停用上一画面的联动台美颜');
    });
  }

  async read(target: BeautyTarget): Promise<BeautyFilterState> {
    const parsed = beautyTargetSchema.parse(target);
    return this.run(async () => this.readFilter(parsed));
  }

  async comparisonPipe(target: BeautyTarget, localPid: number): Promise<string> {
    const parsed = beautyTargetSchema.parse(target);
    if (!Number.isSafeInteger(localPid) || localPid <= 0) throw new Error('美颜对比需要连接本机 OBS');
    return this.run(async () => {
      const state = await this.readFilter(parsed);
      if (!state.enabled) throw new Error('美颜滤镜已关闭，无法读取对比画面');
      const result = await this.request(() => this.client.call('GetSourceFilter', parsed), '读取美颜对比通道');
      const path = z.string().regex(/^\\\\\.\\pipe\\tblink-beauty-compare-\d+-\d+$/).safeParse(result.filterSettings.comparison_pipe);
      if (!path.success) throw new Error('美颜组件版本太旧，不支持对比，请更新组件后重启 OBS');
      if (!path.data.startsWith(`\\\\.\\pipe\\tblink-beauty-compare-${localPid}-`)) throw new Error('美颜对比连接和当前 OBS 对不上，请重新打开对比');
      return path.data;
    });
  }

  async prepare(sourceName: string): Promise<{ sourceName: string; filterName: string; channel: string }> {
    return this.run(async () => {
      const filterName = '团播·人像美颜';
      const filters = await this.request(() => this.client.call('GetSourceFilterList', { sourceName }), '读取美颜来源滤镜');
      const existing = filters.filters.find(filter => filter.filterName === filterName);
      if (existing && existing.filterKind !== 'tblink_beauty_prototype') throw new Error('有一个同名滤镜属于其他插件，请先在 OBS 里给它改名');
      if (!existing) await this.request(() => this.client.call('CreateSourceFilter', { sourceName, filterName,
        filterKind: 'tblink_beauty_prototype', filterSettings: { live_mode: true, uniform_controls: true, smooth: 0, white: 0, slim: 0, eye: 0 }
      }), '创建联动台美颜滤镜');
      await this.readFilter({ sourceName, filterName });
      const result = await this.request(() => this.client.call('GetSourceFilter', { sourceName, filterName }), '读取美颜分析通道');
      if (result.filterSettings.transport_version !== 7) throw new Error('美颜分析组件版本不匹配，请更新美颜组件后重启 OBS');
      const channel = z.string().regex(/^Local\\tblink-beauty-\d+-\d+$/).parse(result.filterSettings.transport_name);
      await this.request(() => this.client.call('SetSourceFilterSettings', { sourceName, filterName, overlay: true, filterSettings: { live_mode: true } }), '启用实时美颜分析');
      await this.request(() => this.client.call('SetSourceFilterEnabled', { sourceName, filterName, filterEnabled: true }), '启用联动台美颜');
      return { sourceName, filterName, channel };
    });
  }

  async apply(payload: BeautyApply): Promise<BeautyFilterState> {
    const { values, ...target } = beautyApplySchema.parse(payload);
    return this.run(async () => {
      await this.readFilter(target);
      await this.request(() => this.client.call('SetSourceFilterSettings', { ...target, overlay: true,
        filterSettings: { uniform_controls: true, ...Object.fromEntries(beautyRuntimeKeys.map(key => [key, values[key] / 100])) }
      }), '应用基础美颜参数');
      const confirmed = await this.readFilter(target);
      if (!confirmed.uniform || Object.keys(values).some(key => confirmed.values[key as keyof typeof values] !== values[key as keyof typeof values])) {
        throw new Error('OBS 返回的美颜参数和设置的不一致，请检查滤镜（没有自动重试）');
      }
      return confirmed;
    });
  }

  private async readFilter(target: BeautyTarget): Promise<BeautyFilterState> {
    const result = await this.request(() => this.client.call('GetSourceFilter', target), '读取美颜滤镜');
    if (result.filterKind !== 'tblink_beauty_prototype') throw new Error('所选滤镜不是联动台美颜，已拒绝修改');
    const settings = settingsSchema.safeParse(result.filterSettings);
    if (!settings.success) throw new Error('美颜滤镜版本太旧，请先更新美颜组件');
    const value = settings.data;
    return { ...target, enabled: result.filterEnabled, liveMode: value.live_mode === true, uniform: value.uniform_controls === true,
      values: beautyBasicValuesSchema.parse(Object.fromEntries(beautyRuntimeKeys.map(key => [key, Math.round((value[key] ?? 0) * 100)]))) };
  }
}
