import type { ObsOperationRunner } from './obs-request-scheduler';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { OBSWebSocket } from 'obs-websocket-js';
import { obsSourceKinds, type ObsSourceDraft, type ObsSourceKind, type ObsSourceOption, type ObsSourceSettings } from '@tb/schema';

type CreatePayload = { kind: ObsSourceKind; name: string; sceneName: string };
type Settings = Record<string, string | number | boolean | { face: string; size: number; style: string; flags: number }>;

/** Drafts remain disabled until OBS acknowledges their complete configuration. */
export class ObsSourceManager {
  private readonly creations = new Set<Promise<ObsSourceDraft>>();
  private readonly drafts = new Map<string, ObsSourceDraft>();
  constructor(private readonly client: OBSWebSocket, private readonly request: <T>(operation: () => Promise<T>, label: string) => Promise<T>, private readonly run: ObsOperationRunner) {}

  async create(payload: CreatePayload): Promise<ObsSourceDraft> {
    return this.run(async () => {
      const pending = this.createInput(payload);
      this.creations.add(pending);
      try { return await pending; } finally { this.creations.delete(pending); }
    });
  }

  private async createInput(payload: CreatePayload): Promise<ObsSourceDraft> {
    const inputKind = obsSourceKinds[payload.kind].inputKind;
    const kinds = await this.request(() => this.client.call('GetInputKindList'), 'GetInputKindList');
    if (!kinds.inputKinds.includes(inputKind)) throw new Error(`当前 OBS 不支持${obsSourceKinds[payload.kind].label}（${inputKind}）`);
    const inputName = `团播·${payload.name}·${randomUUID().slice(0, 8)}`;
    const result = await this.request(() => this.client.call('CreateInput', {
      sceneName: payload.sceneName, inputName, inputKind, sceneItemEnabled: false,
      inputSettings: { device_id: '', video_device_id: '', window: '', local_file: '', url: 'about:blank', text: '' }
    }), 'CreateInput');
    const draft = { inputName, sceneName: payload.sceneName, sceneItemId: result.sceneItemId, kind: payload.kind };
    this.drafts.set(inputName, draft);
    return draft;
  }

  async options(inputName: string): Promise<ObsSourceOption[]> {
    return this.run(async () => {
      const draft = this.requireDraft(inputName);
      const propertyName = obsSourceKinds[draft.kind].property;
      if (!propertyName) return [];
      const response = await this.request(() => this.client.call('GetInputPropertiesListPropertyItems', { inputName, propertyName }), 'GetInputPropertiesListPropertyItems');
      return response.propertyItems.map((item) => {
        if (typeof item.itemName !== 'string' || (typeof item.itemValue !== 'string' && typeof item.itemValue !== 'number')) throw new Error('OBS 返回的设备列表格式无效');
        return { label: item.itemName, value: String(item.itemValue), enabled: item.itemEnabled !== false };
      });
    });
  }

  async apply(inputName: string, values: ObsSourceSettings): Promise<void> {
    return this.run(async () => {
      const draft = this.requireDraft(inputName);
      const settings = await this.settings(draft, values);
      await this.request(() => this.client.call('SetInputSettings', { inputName, inputSettings: settings, overlay: true }), 'SetInputSettings');
      const actual = await this.request(() => this.client.call('GetInputSettings', { inputName }), 'GetInputSettings');
      for (const [key, value] of Object.entries(settings)) {
        if (typeof value !== 'object' && actual.inputSettings[key] !== value) throw new Error(`OBS 没有确认参数 ${key}，来源还没应用`);
      }
      await this.request(() => this.client.call('SetSceneItemEnabled', { sceneName: draft.sceneName, sceneItemId: draft.sceneItemId, sceneItemEnabled: true }), 'SetSceneItemEnabled');
      const enabled = await this.request(() => this.client.call('GetSceneItemEnabled', { sceneName: draft.sceneName, sceneItemId: draft.sceneItemId }), 'GetSceneItemEnabled');
      if (!enabled.sceneItemEnabled) throw new Error('OBS 来源还没启用');
      this.drafts.delete(inputName);
    });
  }

  async discardPending(): Promise<void> {
    return this.run(async () => {
      await Promise.allSettled(this.creations);
      for (const inputName of this.drafts.keys()) await this.cancel(inputName);
    });
  }

  async cancel(inputName: string): Promise<void> {
    return this.run(async () => {
      this.requireDraft(inputName);
      await this.request(() => this.client.call('RemoveInput', { inputName }), 'RemoveInput');
      this.drafts.delete(inputName);
    });
  }

  private requireDraft(inputName: string): ObsSourceDraft {
    const draft = this.drafts.get(inputName);
    if (!draft) throw new Error('这不是正在添加的来源，不能覆盖或删除');
    return draft;
  }

  private async settings(draft: ObsSourceDraft, values: ObsSourceSettings): Promise<Settings> {
    const property = obsSourceKinds[draft.kind].property;
    if (property) {
      const choices = await this.options(draft.inputName);
      if (!choices.some((choice) => choice.enabled && choice.value === values.device && choice.value !== '')) throw new Error('请选择当前可用的设备或窗口');
      return { [property]: values.device };
    }
    switch (draft.kind) {
      case 'image': {
        if (!(await stat(values.path)).isFile()) throw new Error('请选择有效的图片文件');
        return { file: values.path, unload: true };
      }
      case 'media': {
        if (!(await stat(values.path)).isFile()) throw new Error('请选择有效的媒体文件');
        return { is_local_file: true, local_file: values.path, looping: values.looping, restart_on_activate: true, close_when_inactive: true };
      }
      case 'browser': {
        const url = new URL(values.url);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('浏览器地址必须以 http:// 或 https:// 开头');
        return { url: url.href, width: values.width, height: values.height };
      }
      case 'text':
        if (!values.text.trim()) throw new Error('请输入文本内容');
        return { text: values.text, font: { face: 'Microsoft YaHei', size: values.fontSize, style: 'Regular', flags: 0 } };
      default: throw new Error('来源配置缺少设备属性');
    }
  }
}
