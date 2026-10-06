import { expect, it, vi } from 'vitest';
import { OBSWebSocket } from 'obs-websocket-js';
import { ObsBeauty } from './obs-beauty';

const target = { sourceName: '机位 A', filterName: '联动台美颜' };
const values = { smooth: 40, white: 20, slim: 30, eye: 10, exposure: -20, contrast: 15, saturation: -30, temperature: 25, sharpen: 10, texture: 20, evenSkin: 30, shine: 40, nose: 20, noseLength: -10, mouth: 30, eyeDistance: -20, teeth: 55, lipstick: 40, lipstickTone: -50, blushTone: 60, brow: 10, eyeliner: 20, blush: 30, jaw: 20, cheek: 30, chin: -10, forehead: 10, darkCircles: 20, nasolabial: 30, blemish: 45, bodySlim: 20, waist: 30, shoulder: -10, neck: 20, legSlim: 30, legLength: 10 };
const response = { filterKind: 'tblink_beauty_prototype', filterIndex: 0, filterEnabled: true,
  filterSettings: { controls_version: 14, live_mode: true } };

it.each([4, 5, 6])('旧分析通道 %s 在启用滤镜之前明确拒绝，不自动重启 OBS', async version => {
  const client = new OBSWebSocket();
  const call = vi.spyOn(client, 'call')
    .mockResolvedValueOnce({ filters: [{ filterName: '团播·人像美颜', filterKind: 'tblink_beauty_prototype' }] })
    .mockResolvedValueOnce(response)
    .mockResolvedValueOnce({ ...response, filterSettings: { ...response.filterSettings, transport_version: version } });
  const beauty = new ObsBeauty(client, operation => operation(), operation => operation());
  await expect(beauty.prepare('机位 A')).rejects.toThrow('更新美颜组件');
  expect(call.mock.calls.map(args => args[0])).toEqual(['GetSourceFilterList', 'GetSourceFilter', 'GetSourceFilter']);
});

it('拒绝其他滤镜、旧版组件及非法参数，不发送修改请求', async () => {
  const client = new OBSWebSocket(); const call = vi.spyOn(client, 'call');
  const beauty = new ObsBeauty(client, operation => operation(), operation => operation());
  call.mockResolvedValueOnce({ ...response, filterKind: 'color_filter' });
  await expect(beauty.apply({ ...target, values })).rejects.toThrow('不是联动台美颜');
  expect(call).toHaveBeenCalledTimes(1);
  call.mockResolvedValueOnce({ ...response, filterSettings: {} });
  await expect(beauty.apply({ ...target, values })).rejects.toThrow('版本');
  expect(call).toHaveBeenCalledTimes(2);
  await expect(beauty.apply({ ...target, values: { ...values, smooth: 101 } })).rejects.toThrow();
  expect(call).toHaveBeenCalledTimes(2);
});

it('仅更新选中滤镜的已实现参数并回读确认，保留调色与美型正负值', async () => {
  const client = new OBSWebSocket();
  const filterSettings = { uniform_controls: true, smooth: .4, white: .2, slim: .3, eye: .1,
    exposure: -.2, contrast: .15, saturation: -.3, temperature: .25, sharpen: .1, texture: .2, evenSkin: .3, shine: .4, nose: .2, noseLength: -.1, mouth: .3, eyeDistance: -.2, teeth: .55, lipstick: .4, lipstickTone: -.5, blushTone: .6, brow: .1, eyeliner: .2, blush: .3, jaw: .2, cheek: .3, chin: -.1, forehead: .1, darkCircles: .2, nasolabial: .3, blemish: .45, bodySlim: .2, waist: .3, shoulder: -.1, neck: .2, legSlim: .3, legLength: .1 };
  const call = vi.spyOn(client, 'call').mockResolvedValueOnce(response).mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ ...response, filterSettings: { ...response.filterSettings, ...filterSettings } });
  const result = await new ObsBeauty(client, operation => operation(), operation => operation()).apply({ ...target, values });
  expect(result.values).toEqual(values);
  expect(call.mock.calls.map(args => args[0])).toEqual(['GetSourceFilter', 'SetSourceFilterSettings', 'GetSourceFilter']);
  expect(call).toHaveBeenNthCalledWith(2, 'SetSourceFilterSettings', { ...target, overlay: true, filterSettings });
});

it('回读不一致和外部异常明确失败，不自动重试', async () => {
  const client = new OBSWebSocket();
  const call = vi.spyOn(client, 'call').mockResolvedValueOnce(response).mockResolvedValueOnce(undefined).mockResolvedValueOnce(response);
  const beauty = new ObsBeauty(client, operation => operation(), operation => operation());
  await expect(beauty.apply({ ...target, values })).rejects.toThrow('不一致');
  expect(call).toHaveBeenCalledTimes(3);
  call.mockReset().mockRejectedValueOnce(new Error('OBS 请求超时'));
  await expect(beauty.apply({ ...target, values })).rejects.toThrow('超时');
  expect(call).toHaveBeenCalledTimes(1);
});

it('对比只连接当前本机 OBS 的自有启用滤镜，不改变来源设置', async () => {
  const client = new OBSWebSocket();
  const path = '\\\\.\\pipe\\tblink-beauty-compare-123-1';
  const call = vi.spyOn(client, 'call').mockResolvedValue({ ...response, filterSettings: { ...response.filterSettings, comparison_pipe: path } });
  const beauty = new ObsBeauty(client, operation => operation(), operation => operation());
  expect(await beauty.comparisonPipe(target, 123)).toBe(path);
  await expect(beauty.comparisonPipe(target, 456)).rejects.toThrow('不匹配');
  expect(call.mock.calls.every(args => args[0] === 'GetSourceFilter')).toBe(true);
  call.mockResolvedValue({ ...response, filterEnabled: false });
  await expect(beauty.comparisonPipe(target, 123)).rejects.toThrow('已关闭');
  call.mockResolvedValue(response);
  await expect(beauty.comparisonPipe(target, 123)).rejects.toThrow('不支持对比');
});
