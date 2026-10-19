import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ma2AttributeGroupSchema } from '@tb/schema';
import { classifyMa2Attributes } from '@tb/core/link';
import { parseMa2AttributeCatalog, readMa2AttributeCatalog } from './ma2-attribute-catalog';
import type { Ma2Telnet } from './ma2-telnet';

const groups = ma2AttributeGroupSchema.array().parse(JSON.parse(readFileSync(new URL('./fixtures/ma2-attribute-catalog-3.7.json', import.meta.url), 'utf8')));
const rows = groups.map(g => [g.attribute, g.attributeName, g.presetType, g.presetName, g.feature, g.featureName].map(value => Buffer.from(value).toString('hex')).join(','));
it('covers all 226 native onPC attributes in all nine types without prefix guessing', () => {
  const catalog = parseMa2AttributeCatalog(['ok', ...rows].join(';'));
  expect(catalog).toEqual(groups); expect(catalog).toHaveLength(226);
  for (const group of catalog) {
    const result = classifyMa2Attributes({ attributes: [group.attribute], groups: [group], hasEffects: false });
    expect(result.unknown).toEqual([]); expect(result.roles).not.toContain('other'); expect(result.roles).not.toContain('unresolved');
  }
});
it('refuses malformed and duplicate mappings and blocks before sending during playback', async () => {
  expect(() => parseMa2AttributeCatalog(`ok;${rows[0]};${rows[0]}`)).toThrow('重复');
  expect(() => parseMa2AttributeCatalog('ok;61,62')).toThrow('不完整');
  const connection = { command: vi.fn<Ma2Telnet['command']>() };
  await expect(readMa2AttributeCatalog(connection, () => { throw new Error('播放中'); })).rejects.toThrow('播放中');
  expect(connection.command).not.toHaveBeenCalled();
});
