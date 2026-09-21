import { expect, it, vi } from 'vitest';
import { createMa2Timecode, createMa2TimecodeXml } from './ma2-create';
import { convertMa2Timecode } from './ma2-timecode-conversion';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2TimecodeXml } from './ma2-timecode-xml';

it('生成空 Timecode，名称转义且拒绝未验证版本和目标', async () => {
  const xml = createMa2TimecodeXml(9903, 'TBLINK & <测试>', '3.3.4.3');
  expect(convertMa2Timecode(xml, [], 9903)).toMatchObject({ name: 'TBLINK & <测试>', document: { tracks: [] }, unconverted: [] });
  expect(() => createMa2TimecodeXml(0, '测试', '3.3.4.3')).toThrow('编号');
  expect(() => createMa2TimecodeXml(1, '', '3.3.4.3')).toThrow('名称');
  expect(() => createMa2TimecodeXml(1, '测试', '3.9.60')).toThrow('版本');
  const request = vi.fn().mockResolvedValueOnce('3.3.4.3').mockResolvedValueOnce(xml);
  expect(await createMa2Timecode({ request }, 9903, 'TBLINK & <测试>')).toMatchObject({ target: 9903 });
  expect(request.mock.calls[1]).toEqual(['CREATE', 9903, '', xml]);
});

it.skipIf(!process.env.MA2_ONPC_CREATE_TARGET)('新建专用 Timecode 回读确认，重复创建拒绝覆盖', async () => {
  const target = Number(process.env.MA2_ONPC_CREATE_TARGET);
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const name = `TBLINK_CREATE_ACCEPTANCE_${target}`;
  const result = await createMa2Timecode(bridge, target, name);
  expect(result).toMatchObject({ target, name, document: { tracks: [] }, unconverted: [] });
  const before = await bridge.request('READ', target);
  await expect(createMa2Timecode(bridge, target, 'TBLINK_MUST_NOT_OVERWRITE')).rejects.toThrow('already exists');
  expect(inspectMa2TimecodeXml(await bridge.request('READ', target)).timecodes).toEqual(inspectMa2TimecodeXml(before).timecodes);
}, 60000);
