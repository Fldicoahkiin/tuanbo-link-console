import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { inspectMa2ExecutorPageXml } from './ma2-timecode-xml';
import { readMa2ExecutorPage } from './ma2-executor-page';

const xml = await readFile(new URL('./fixtures/ma2-page-3.7.xml', import.meta.url), 'utf8');
it('原生 Page 99 保留空格、101 和 201 的实际地址，执行器名称没有序列编号后缀', () => {
  const page = inspectMa2ExecutorPageXml(xml, 99);
  expect(page.items).toMatchObject([{ slot: 101, name: '100步灯光测试', sequence: 9907 }, { slot: 201, name: 'AI 387 · 自动推荐 STAGING', sequence: 9001 }]);
  expect(() => inspectMa2ExecutorPageXml(xml, 100)).toThrow('编号不一致');
});
it('一次页面请求足以读取，来源变化不能使用旧页或旧名称', async () => {
  const parsed = inspectMa2ExecutorPageXml(xml, 99);
  const request = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: parsed.source!, page: 99 };
  const bridge = { request: vi.fn().mockResolvedValue(xml) };
  expect((await readMa2ExecutorPage(bridge, request)).items).toHaveLength(2);
  expect(bridge.request).toHaveBeenCalledExactlyOnceWith('PAGE', 99);
  await expect(readMa2ExecutorPage(bridge, { ...request, expectedSource: { ...request.expectedSource, generation: 'another' } })).rejects.toThrow('Show 或连接变了');
});
it('wide executors retain their leading slot and do not collapse following empty slots', () => {
  const extended = xml.replace(/(<Exec tblink_label="100步灯光测试"[\s\S]*?<\/Exec>)(\s*)<Exec xsi:nil="true" \/>/, '$1$2<Exec offset_from_first="1" />');
  const page = inspectMa2ExecutorPageXml(extended, 99);
  expect(page.items).toMatchObject([{ slot: 101, width: 2 }, { slot: 201, width: 1 }]);
  expect(() => inspectMa2ExecutorPageXml(extended.replace('offset_from_first="1"', 'offset_from_first="2"'), 99)).toThrow('起点缺失');
});
it('does not round a malformed Cue number into a different executable Cue', () => {
  expect(() => inspectMa2ExecutorPageXml(xml.replace(/(<tblink_cue[^>]*number=")[^"]+/, '$11.0004'), 99)).toThrow('Cue 编号无效');
});
it('uses only exported appearance and button functions, including the two buttons above a fader', () => {
  const colored = xml.replace('<tblink_sequence number="9907"', '<tblink_sequence color="#3366cc" number="9907"').replace('<Button>0</Button>', '<Button>12290</Button>');
  const item = inspectMa2ExecutorPageXml(colored, 99).items[0]!;
  expect(item.color).toBe('#3366cc');
  expect(item.buttons).toEqual([12299, 12290, 0, 0]);
  expect(item.priority).toBe('Normal');
  expect(item.softLtp).toBe(true);
  expect(item.revision).toMatch(/^[a-f0-9]{64}$/);
});
