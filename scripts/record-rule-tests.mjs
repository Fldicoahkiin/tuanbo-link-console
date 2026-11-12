// pnpm rules:record：把新加的规则测试登记进 docs/rule-tests.json。只加新的；清单里已有的一条不动，
// 被改、被删的照旧报出来，不替你改（规矩见 scripts/rule-tests.mjs）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRuleTests, recordNewRuleTests, RULE_TEST_MANIFEST, ruleTestReport, scanRuleTests } from './rule-tests.mjs';

const repository = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(repository, RULE_TEST_MANIFEST);
const scanned = scanRuleTests(repository);
// 清单不见了就停在这里：从 git 里把它恢复回来，不重新生成。
const { manifest, added } = recordNewRuleTests(JSON.parse(readFileSync(path, 'utf8')), scanned);
if (added.length > 0) writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
for (const { file, test } of added) console.log(`登记  ${file} › ${test}`);
console.log(added.length === 0 ? '没有新的规则测试。' : `登记了 ${added.length} 条，把 ${RULE_TEST_MANIFEST} 和测试放在同一次提交里。`);
const report = ruleTestReport({ ...compareRuleTests(manifest, scanned), added: [] });
if (report) {
  console.error(report);
  process.exitCode = 1;
}
