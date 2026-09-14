import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectMa2TimecodeXml, patchMa2EventTimes } from './ma2-timecode-xml';

const sampleDirectory = process.env.MA2_TIMECODE_SAMPLES_DIR;
describe.skipIf(!sampleDirectory)('显式指定的本机 MA2 历史样例（只读取）', () => {
  it('批量检查原始文件并在内存中往返序列化，绝不回写源文件', () => {
    if (!sampleDirectory) throw new Error('未指定 MA2_TIMECODE_SAMPLES_DIR');
    const files = readdirSync(sampleDirectory).filter((name) => /timecode.*\.xml$/i.test(name));
    expect(files.length).toBeGreaterThan(0);
    let eventCount = 0;
    for (const name of files) {
      const xml = readFileSync(join(sampleDirectory, name), 'utf8');
      const before = inspectMa2TimecodeXml(xml);
      const events = before.timecodes.flatMap((tc) => tc.tracks.flatMap((track) => track.subtracks.flatMap((subtrack) => subtrack.events)));
      eventCount += events.length;
      const event = events.find((entry) => entry.attributes.time !== undefined);
      if (event && event.attributes.time !== undefined) {
        const output = patchMa2EventTimes(xml, before.sha256, [{ path: event.path, rawTime: event.attributes.time }]);
        expect(inspectMa2TimecodeXml(output).timecodes, name).toEqual(before.timecodes);
      }
    }
    expect(eventCount).toBeGreaterThan(0);
    console.info(`MA2 历史样例读取完成：${files.length} 个文件，${eventCount} 个事件；无控台写入。`);
  });
});
