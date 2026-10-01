import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { ma2CatalogSchema } from '@tb/schema';
import { convertMa2TimecodeReferences } from './ma2-timecode-conversion';

/** Opt-in offline reproduction of an actual exported package. No console requests or writes. */
it.skipIf(!process.env.MA2_SITE_PACKAGE)('现场核对包离线转换，逐条输出保留事件与失败原因', async () => {
  const path = process.env.MA2_SITE_PACKAGE;
  if (!path) throw new Error('缺少 MA2_SITE_PACKAGE');
  const raw = JSON.parse(gunzipSync(await readFile(path)).toString('utf8')) as unknown;
  const site = z.object({ context: z.object({ ma2Site: z.object({ catalog: ma2CatalogSchema, raw: z.array(z.object({ target: z.number().int(), xml: z.string() })) }) }) }).parse(raw).context.ma2Site;
  const reports = site.raw.map(entry => {
    const cached = site.catalog.entries.find(value => value.target === entry.target);
    const cueCatalog = cached?.preview?.cueCatalog;
    if (!cueCatalog && cached?.events.some(event => event.cue)) return { target: entry.target, error: '旧包缺少原生 Cue 索引映射；需用新版读取一次再导出，不能从显示编号反推内部索引' };
    try {
      const preview = convertMa2TimecodeReferences(entry.xml, [{ version: site.catalog.directory.version, sequences: (cueCatalog ?? []).map(sequence => ({ number: sequence.sequence, name: sequence.name, cues: sequence.cues })) }], entry.target);
      expect(preview.sourceXml).toBe(entry.xml);
      return { target: entry.target, timing: preview.timing, knownEvents: preview.document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)), nativeEvents: preview.unconverted, writeback: preview.unconverted.length ? 'blocked' : 'requires-live-readback', warnings: preview.warnings };
    } catch (error) { return { target: entry.target, error: error instanceof Error ? error.message : String(error) }; }
  });
  await writeFile(process.env.MA2_SITE_REPORT ?? `${path}.replay.json`, JSON.stringify({ source: path, show: site.catalog.directory.show, readAt: site.catalog.readAt, metrics: site.catalog.metrics, reports }, null, 2), 'utf8');
  expect(reports).toHaveLength(site.raw.length);
});
