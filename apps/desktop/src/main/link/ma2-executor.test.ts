import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { inspectMa2ExecutorXml } from './ma2-timecode-xml';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';

// Native onPC 3.3.4.3 export of the owned Executor 99.219; only Info was removed.
const xml = await readFile(new URL('./fixtures/ma2-executor-3.3.xml', import.meta.url), 'utf8');
it.skipIf(!process.env.MA2_ONPC_DATA_DIRECTORY)('本机插件按地址读取已有测试执行器，不依赖 Timecode', async () => {
  const directory = process.env.MA2_ONPC_DATA_DIRECTORY;
  if (!directory) throw new Error('未指定本机 MA2 目录');
  const bridge = new Ma2OnpcBridge(directory, () => false);
  const first = inspectMa2ExecutorXml(await bridge.request('EXECUTOR', 99, '219'));
  expect(first).toMatchObject({ version: '3.3.4', sequence: 9901, assignmentName: 'TBLINK_CUE_REFERENCE_ACCEPTANCE 9901' });
  expect(inspectMa2ExecutorXml(await bridge.request('EXECUTOR', 99, '219'))).toEqual(first);
}, 40000);
describe('MA2 执行器序列关系', () => {
  it('从真实执行器导出读取 Sequence，不将相对偏移猜成执行器地址', () => {
    expect(inspectMa2ExecutorXml(xml)).toEqual({ version: '3.3.4', sequence: 9901, assignmentName: 'TBLINK_CUE_REFERENCE_ACCEPTANCE 9901' });
  });
  it('未分配、非序列和无效编号不能用于轨道关联', () => {
    expect(() => inspectMa2ExecutorXml(xml.replace(/<Assignment\s[\s\S]*?<\/Assignment>/, ''))).toThrow('尚未分配');
    expect(() => inspectMa2ExecutorXml(xml.replace('<No>25</No>', '<No>13</No>'))).toThrow('不是已支持');
    expect(() => inspectMa2ExecutorXml(xml.replace('<No>9901</No>', '<No>0</No>'))).toThrow('编号无效');
    expect(() => inspectMa2ExecutorXml(xml.replace('<No>9901</No>', '<No>100000</No>'))).toThrow('编号无效');
  });
  it('多个执行器、偏移、重复分配及未验证版本不能假定为单目标读取', () => {
    const executor = xml.match(/<Exec\s[\s\S]*?<\/Exec>/)?.[0];
    const assignment = xml.match(/<Assignment\s[\s\S]*?<\/Assignment>/)?.[0];
    if (!executor || !assignment) throw new Error('原生测试样例缺失');
    expect(() => inspectMa2ExecutorXml(xml.replace('</MA>', `${executor}</MA>`))).toThrow('不唯一');
    expect(() => inspectMa2ExecutorXml(xml.replace('offset_from_first="0"', 'offset_from_first="1"'))).toThrow('单个');
    expect(() => inspectMa2ExecutorXml(xml.replace('</Exec>', `${assignment}</Exec>`))).toThrow('不唯一');
    expect(() => inspectMa2ExecutorXml(xml.replace('minor_vers="3"', 'minor_vers="7"'))).toThrow('尚未验证');
  });
});
