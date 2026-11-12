import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compareRuleTests, lostRuleTests, recordNewRuleTests, RULE_TEST_MANIFEST, ruleTestReport, ruleTestsIn, scanRuleTests,
  type RuleTestManifest } from '../../../../../scripts/rule-tests.mjs';

/*
 * Rule tests guard what the user decided (AGENTS.md 第 6 节): code that turns one red broke the rule, and the test is not
 * what gets changed. docs/rule-tests.json lists every rule test (files named *rules.test.ts and *-scan.test.ts) with a
 * fingerprint of how it is written (scripts/rule-tests.mjs). This file fails when a listed test was changed, skipped
 * or removed without a dated entry in the manifest's `changes` saying why, and when a new rule test is not listed yet
 * (pnpm rules:record adds it, and never touches a listed one). It lists itself too.
 */

const REPOSITORY = fileURLToPath(new URL('../../../../../', import.meta.url));

const manifestSchema = z.object({
  tests: z.record(z.string(), z.record(z.string(), z.string())),
  changes: z.array(z.object({ date: z.string(), file: z.string(), why: z.string(), to: z.record(z.string(), z.string().nullable()) }))
});
const parsed = (text: string): RuleTestManifest => manifestSchema.parse(JSON.parse(text));

/** The manifest as the last commit has it; `null` where there is no git, or no commit with it yet. */
function committed(): RuleTestManifest | null {
  try {
    return parsed(execFileSync('git', ['show', `HEAD:${RULE_TEST_MANIFEST}`], { cwd: REPOSITORY, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 24 }));
  } catch {
    return null;
  }
}

const SAMPLE = `
import { beforeEach, describe, expect, it } from 'vitest';
const LIMIT = 3;
const OTHER = 9;
function within(value: number) { return value <= LIMIT; }
let opened = 0;
describe('规则', () => {
  beforeEach(() => { opened = 1; });
  // 说明
  it('不超过上限', () => {
    expect(within(3)).toBe(true);
  });
  it('别的数', () => { expect(OTHER).toBe(9); });
  it.todo('以后再守');
  for (const value of [1, 2]) {
    it(\`每个 \${value}\`, () => { expect(value).toBeGreaterThan(0); });
  }
});
it('组外面的', () => { expect(opened).toBe(0); });
`;
const sample = ruleTestsIn('sample-rules.test.ts', SAMPLE);
/** The titles whose fingerprint is different, new or gone once `text` replaces the sample. */
function touched(text: string): string[] {
  const next = ruleTestsIn('sample-rules.test.ts', text);
  return [...new Set([...Object.keys(sample), ...Object.keys(next)])].filter(title => sample[title] !== next[title]).sort();
}
const FILE = 'packages/core/src/sample-rules.test.ts';
const listed = (): RuleTestManifest => ({ tests: { [FILE]: sample }, changes: [] });

describe('规则测试只能加，不能悄悄改（2026-11-12）', () => {
  it('清单里的每一条规则测试都还在、写法没变，新加的都登记了', () => {
    const manifest = parsed(readFileSync(`${REPOSITORY}${RULE_TEST_MANIFEST}`, 'utf8'));
    expect(ruleTestReport(compareRuleTests(manifest, scanRuleTests(REPOSITORY)))).toBe('');
    // The scan really read the rule tests, this file's among them.
    expect(Object.keys(manifest.tests)).toContain('apps/desktop/src/main/link/rule-manifest-scan.test.ts');
    expect(Object.values(manifest.tests).reduce((count, tests) => count + Object.keys(tests).length, 0)).toBeGreaterThan(200);
  });

  it('已经提交的指纹和改动记录一条没少、一条没改', () => {
    const before = committed();
    const manifest = parsed(readFileSync(`${REPOSITORY}${RULE_TEST_MANIFEST}`, 'utf8'));
    expect(before === null ? [] : lostRuleTests(before, manifest)).toEqual([]);
    // A fingerprint edited by hand, a manifest written anew, a record taken out: each is seen against the commit.
    expect(lostRuleTests(listed(), listed())).toEqual([]);
    expect(lostRuleTests(listed(), { tests: { [FILE]: { ...sample, '规则 › 别的数': '0000000000000000' } }, changes: [] })).toEqual([`${FILE} › 规则 › 别的数`]);
    expect(lostRuleTests(listed(), { tests: {}, changes: [] })).toHaveLength(Object.keys(sample).length);
    const change = { date: '2026-11-12', file: FILE, why: '用户 2026-11-12 定：上限改成 4', to: { '规则 › 不超过上限': 'aaaaaaaaaaaaaaaa' } };
    expect(lostRuleTests({ ...listed(), changes: [change] }, { ...listed(), changes: [] })).toEqual(['changes 里已有的记录（只能在末尾加）']);
    expect(lostRuleTests({ ...listed(), changes: [change] }, { ...listed(), changes: [change, { ...change, date: '2026-11-13' }] })).toEqual([]);
  });

  it('认得出改断言、改用到的常量和 beforeEach、跳过、删掉；注释、空白和没用到的东西不算', () => {
    expect(Object.keys(sample).sort()).toEqual(['组外面的', '规则 › `每个 ${value}`', '规则 › 不超过上限', '规则 › 别的数']);
    expect(touched(SAMPLE.replace('// 说明', '// 别的说明\n\n').replace('toBe(true);', 'toBe( true );'))).toEqual([]);
    expect(touched(SAMPLE.replace('let opened', 'const unused = 1;\nlet opened'))).toEqual([]);
    expect(touched(SAMPLE.replace('toBe(true)', 'toBe(false)'))).toEqual(['规则 › 不超过上限']);
    expect(touched(SAMPLE.replace('LIMIT = 3', 'LIMIT = 4'))).toEqual(['规则 › 不超过上限']);
    expect(touched(SAMPLE.replace('value <= LIMIT', 'value < LIMIT + 9'))).toEqual(['规则 › 不超过上限']);
    expect(touched(SAMPLE.replace("it('别的数'", "it.skip('别的数'"))).toEqual(['规则 › 别的数']);
    expect(touched(SAMPLE.replace("it('别的数', () => { expect(OTHER).toBe(9); });", ''))).toEqual(['规则 › 别的数']);
    expect(touched(SAMPLE.replace('[1, 2]) {', '[1]) {'))).toEqual(['规则 › `每个 ${value}`']);
    expect(touched(SAMPLE.replace("describe('规则'", "describe.skip('规则'"))).toEqual(['规则 › `每个 ${value}`', '规则 › 不超过上限', '规则 › 别的数']);
    expect(touched(SAMPLE.replace('opened = 1', 'opened = 2'))).toEqual(['规则 › `每个 ${value}`', '规则 › 不超过上限', '规则 › 别的数']);
    expect(touched(`${SAMPLE}\nit('新的', () => { expect(1).toBe(1); });\n`)).toEqual(['新的']);
  });

  it('同一份测试在 Windows 上检出（换行是 CRLF）指纹不变', () => {
    // A template literal over several lines carries the line ends in its text.
    const text = `${SAMPLE}it('多行的字', () => { expect(${'`第一行\n第二行`'}).toContain('第二行'); });\n`;
    const windows = text.replace(/\n/g, '\r\n');
    expect(windows).not.toBe(text);
    expect(Object.keys(ruleTestsIn(FILE, text))).toContain('多行的字');
    expect(ruleTestsIn(FILE, windows)).toEqual(ruleTestsIn(FILE, text));
    expect(touched(SAMPLE.replace(/\n/g, '\r\n'))).toEqual([]);
  });

  it('改了、不见了的报出来并写明怎么办；changes 里写明哪天、为什么以后才认新的写法', () => {
    const weakened = { [FILE]: ruleTestsIn(FILE, SAMPLE.replace('toBe(true)', 'toBe(false)').replace("it('别的数', () => { expect(OTHER).toBe(9); });", '')) };
    const difference = compareRuleTests(listed(), weakened);
    expect(difference.changed.map(entry => entry.test)).toEqual(['规则 › 不超过上限']);
    expect(difference.missing.map(entry => entry.test)).toEqual(['规则 › 别的数']);
    const report = ruleTestReport(difference);
    expect(report).toContain('改代码，把测试改回去');
    expect(report).toContain('tests 里已有的指纹不要改');
    const to = { '规则 › 不超过上限': weakened[FILE]['规则 › 不超过上限']!, '规则 › 别的数': null };
    expect(report).toContain(JSON.stringify({ date: '', file: FILE, why: '', to }));

    // The record as the report prints it is refused until the date and the reason are filled in.
    expect(compareRuleTests({ ...listed(), changes: [{ date: '', file: FILE, why: '', to }] }, weakened).invalid).toHaveLength(2);
    expect(compareRuleTests({ ...listed(), changes: [{ date: '2026-11-12', file: FILE, why: '改一下', to }] }, weakened).invalid).toHaveLength(1);
    const accepted = { ...listed(), changes: [{ date: '2026-11-12', file: FILE, why: '用户 2026-11-12 定：超过上限也放行，「别的数」不要了', to }] };
    expect(ruleTestReport(compareRuleTests(accepted, weakened))).toBe('');
    // After that the new way is the listed one: going back is a change again, and so is a removed test that returns.
    expect(compareRuleTests(accepted, { [FILE]: sample }).changed.map(entry => entry.test)).toEqual(['规则 › 不超过上限', '规则 › 别的数']);
    // A record for a test the manifest never listed is refused.
    expect(compareRuleTests({ ...listed(), changes: [{ date: '2026-11-12', file: FILE, why: '用户 2026-11-12 定：不要这一条了', to: { 没有这一条: null } }] }, { [FILE]: sample }).invalid).toHaveLength(1);
  });

  it('登记只加新的：已有的指纹不动，被改的照旧报', () => {
    const grown = { [FILE]: ruleTestsIn(FILE, `${SAMPLE.replace('toBe(true)', 'toBe(false)')}\nit('新的', () => { expect(1).toBe(1); });\n`) };
    expect(ruleTestReport(compareRuleTests(listed(), grown))).toContain('pnpm rules:record');
    const { manifest, added } = recordNewRuleTests(listed(), grown);
    expect(added.map(entry => entry.test)).toEqual(['新的']);
    expect(manifest.tests[FILE]).toEqual({ ...sample, 新的: grown[FILE]['新的'] });
    expect(lostRuleTests(listed(), manifest)).toEqual([]);
    expect(compareRuleTests(manifest, grown).changed.map(entry => entry.test)).toEqual(['规则 › 不超过上限']);
    expect(compareRuleTests(manifest, grown).added).toEqual([]);
  });
});
