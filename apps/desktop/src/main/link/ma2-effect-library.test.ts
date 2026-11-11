import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { readMa2EffectLibrary } from './ma2-effect-library';
import { inspectMa2CueFixtures } from './ma2-timecode-xml';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { showStopped } from './fixtures/show-gates';
const xml = readFileSync(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
const directory = { show: '测试 Show', generation: '1', version: '3.3.4', entries: [{ target: 9901, name: '效果' }] };
it('只读取 Cue 明确记录的灯具并去重，不虚构追踪继承灯具', () => {
  const fixtureXml = xml.replace('<CuePart index="0" />', '<CuePart index="0" /><CueDatas><CueData><Channel fixture_id="101" attribute_name="DIM" /></CueData><CueData><Channel fixture_id="101" attribute_name="PAN" /></CueData><CueData><Channel fixture_id="205" attribute_name="DIM" /></CueData></CueDatas>');
  expect(inspectMa2CueFixtures(fixtureXml)).toEqual([{ sequence: 9901, cueIndex: 1, fixtureIds: [101, 205] }, { sequence: 9901, cueIndex: 2, fixtureIds: [] }]);
});
it('完整 Cue 池读取不依赖 Timecode，保留小数编号', async () => {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(xml).mockResolvedValueOnce(JSON.stringify(directory));
  const library = await readMa2EffectLibrary({ request }, showStopped);
  expect(library.sequences[0]?.cues.map(cue => cue.number)).toEqual(['1.250', '7.500']);
  expect(request.mock.calls.map(call => call[0])).toEqual(['LISTSEQ', 'SEQUENCE', 'LISTSEQ']);
});
it('部分失败明确报告；换 Show 拒绝结果', async () => {
  const request = vi.fn<Ma2OnpcBridge['request']>().mockResolvedValueOnce(JSON.stringify(directory)).mockRejectedValueOnce(new Error('导出失败')).mockResolvedValueOnce(JSON.stringify(directory));
  expect((await readMa2EffectLibrary({ request }, showStopped)).errors).toEqual([{ sequence: 9901, message: '导出失败' }]);
  request.mockResolvedValueOnce(JSON.stringify(directory)).mockResolvedValueOnce(xml).mockResolvedValueOnce(JSON.stringify({ ...directory, show: '另一个' }));
  await expect(readMa2EffectLibrary({ request }, showStopped)).rejects.toThrow('Show');
});
