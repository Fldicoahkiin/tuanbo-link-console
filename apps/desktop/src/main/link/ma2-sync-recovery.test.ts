import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { inspectMa2TimecodeXml, sameMa2XmlObjects } from './ma2-timecode-xml';

it.skipIf(!process.env.MA2_SYNC_RECOVERY_BACKUP)('恢复专用同步验收时间线并核对完整对象', async () => {
  const original = await readFile(process.env.MA2_SYNC_RECOVERY_BACKUP!, 'utf8');
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes).toHaveLength(1);
  expect(report.timecodes[0]?.index).toBe(9906);
  expect(report.timecodes[0]?.attributes.name).toBe('100步灯光测试');
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const current = await bridge.request('READ', 9907);
  if (!sameMa2XmlObjects(current, original)) await bridge.exchange('APPLY', 9907, current, original);
  expect(sameMa2XmlObjects(await bridge.request('READ', 9907), original)).toBe(true);
}, 120000);

it.skipIf(!process.env.MA2_AUTO_BIND_RECOVERY_BACKUP)('恢复自动关联专用验收的空时间线', async () => {
  const original = await readFile(process.env.MA2_AUTO_BIND_RECOVERY_BACKUP!, 'utf8');
  const report = inspectMa2TimecodeXml(original);
  expect(report.timecodes).toHaveLength(1);
  expect(report.timecodes[0]?.index).toBe(9998);
  expect(report.timecodes[0]?.attributes.name).toBe('TBLINK_cec482d366b8806ecf7d19e8');
  expect(report.timecodes[0]?.tracks).toHaveLength(0);
  const bridge = new Ma2OnpcBridge(process.env.MA2_ONPC_DATA_DIRECTORY ?? '', () => false);
  const current = await bridge.request('READ', 9999);
  expect(inspectMa2TimecodeXml(current).timecodes[0]?.attributes.name).toBe(report.timecodes[0]?.attributes.name);
  await bridge.exchange('APPLY', 9999, current, original);
  expect(sameMa2XmlObjects(await bridge.request('READ', 9999), original)).toBe(true);
}, 120000);
