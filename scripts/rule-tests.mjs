// 规则测试的清单（docs/rule-tests.json）。规则测试守着用户定下的规则（AGENTS.md 第 6 节）：代码让它红了
// 是代码违反了规则，不能靠改测试过关。这里把每一条规则测试记成“标题 + 写法的指纹”：
//   scripts/record-rule-tests.mjs（pnpm rules:record）         只登记新加的，已有的一条不动
//   apps/desktop/src/main/link/rule-manifest-scan.test.ts      清单里的测试被改了、删了、跳过了就红
// 指纹算的是这一条测试自己的写法，加上它用到的、写在同一个文件里的常量、函数和 beforeEach；
// 注释和空白不算。被测的代码不在里面，那正是测试要查的东西。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export const RULE_TEST_MANIFEST = 'docs/rule-tests.json';
/** 名字以 rules.test.ts 或 -scan.test.ts 结尾的文件是规则测试。 */
export const RULE_TEST_FILE = /(?:rules|-scan)\.test\.tsx?$/;
const ROOTS = ['apps', 'packages'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'out', 'release', 'test-e2e']);
const TESTS = new Set(['it', 'test']);
const GROUPS = new Set(['describe', 'suite']);
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);

/** 仓库里全部规则测试文件，路径相对仓库根、用 `/`，按名字排好。 */
export function ruleTestFiles(repository) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(join(repository, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) walk(path);
      } else if (RULE_TEST_FILE.test(entry.name)) files.push(path);
    }
  };
  for (const root of ROOTS) walk(root);
  return files.sort();
}

/** 一个规则测试文件里的每一条测试：`{ 标题: 指纹 }`。`it.todo` 什么都不守，不记。 */
export function ruleTestsIn(path, text) {
  // Windows 上检出的文件换行是 CRLF：多行的模板字符串里带着 \r，不先换成 \n 同一条测试在两个系统上指纹不一样。
  const source = ts.createSourceFile(path, text.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const declared = new Map();
  const hooks = [];
  const found = [];

  const tokens = (node, out = []) => {
    const children = node.getChildren(source);
    if (children.length === 0) {
      const token = node.getText(source);
      if (token) out.push(token);
    } else for (const child of children) tokens(child, out);
    return out;
  };
  const written = (node) => tokens(node).join(' ');
  const names = (node, out = new Set()) => {
    if (ts.isIdentifier(node)) out.add(node.text);
    node.forEachChild((child) => { names(child, out); });
    return out;
  };
  const declare = (name, statement) => {
    if (ts.isIdentifier(name)) declared.set(name.text, [...(declared.get(name.text) ?? []), statement]);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) declare(element.name, statement);
  };
  /** `it.skipIf(x)('…', fn)` 这样的调用，最里面叫的是谁。 */
  const calls = (expression) => {
    let callee = expression;
    for (;;) {
      if (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) callee = callee.expression;
      else if (ts.isTaggedTemplateExpression(callee)) callee = callee.tag;
      else return ts.isIdentifier(callee) ? callee.text : null;
    }
  };
  const titleOf = (call) => {
    const [first] = call.arguments;
    if (first === undefined) return '';
    return ts.isStringLiteralLike(first) ? first.text : first.getText(source).replace(/\s+/g, ' ');
  };
  /** 这条语句里的测试（不进测试自己的函数体）。 */
  const testsWithin = (node, out = []) => {
    if (ts.isCallExpression(node)) {
      const callee = calls(node);
      if (callee !== null && TESTS.has(callee)) { out.push(node); return out; }
    }
    node.forEachChild((child) => { testsWithin(child, out); });
    return out;
  };

  const block = (statements, groups) => {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) declare(declaration.name, statement);
        continue;
      }
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        || ts.isInterfaceDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name !== undefined) {
        declare(statement.name, statement);
        continue;
      }
      if (ts.isImportDeclaration(statement)) continue;
      const call = ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) ? statement.expression : null;
      const callee = call === null ? null : calls(call);
      if (call !== null && callee !== null && GROUPS.has(callee)) {
        const body = call.arguments.at(-1);
        const inner = body !== undefined && (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) && ts.isBlock(body.body) ? body.body.statements : [];
        block(inner, [...groups, { title: titleOf(call), how: written(call.expression) }]);
        continue;
      }
      if (call !== null && callee !== null && HOOKS.has(callee)) {
        hooks.push({ groups, statement });
        continue;
      }
      // 写在循环或条件里的测试，连同整条语句一起算。
      for (const test of testsWithin(statement)) found.push({ groups, statement, test });
    }
  };
  block(source.statements, []);

  const result = {};
  for (const { groups, statement, test } of found) {
    if (/\. todo$/.test(written(test.expression))) continue;
    const used = new Map();
    const pending = [statement, ...hooks.filter((hook) => hook.groups.every((group, index) => groups[index] === group)).map((hook) => hook.statement)];
    const parts = pending.map(written);
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      for (const name of names(node)) {
        if (used.has(name)) continue;
        const declarations = declared.get(name);
        if (declarations === undefined) continue;
        used.set(name, declarations.map(written).join('\n'));
        pending.push(...declarations);
      }
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([groups.map((group) => [group.how, group.title]), parts, [...used].sort(([a], [b]) => (a < b ? -1 : 1))]))
      .digest('hex')
      .slice(0, 16);
    const title = [...groups.map((group) => group.title), titleOf(test)].join(' › ');
    let key = title;
    for (let copy = 2; key in result; copy += 1) key = `${title}（第 ${copy} 个）`;
    result[key] = fingerprint;
  }
  return result;
}

/** 现在仓库里的全部规则测试：`{ 文件: { 标题: 指纹 } }`。 */
export function scanRuleTests(repository) {
  return Object.fromEntries(ruleTestFiles(repository).map((path) => [path, ruleTestsIn(path, readFileSync(join(repository, path), 'utf8'))]));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const keyOf = (file, test) => `${file}\n${test}`;
const partsOf = (key) => { const at = key.indexOf('\n'); return { file: key.slice(0, at), test: key.slice(at + 1) }; };

/**
 * 清单和现在的测试对一遍。清单的 `tests` 是第一次登记时的指纹，只加不改。规则测试确实要动的时候，在 `changes`
 * 末尾加一条 `{ date, file, why, to: { 标题: 新的指纹 } }`（测试删掉了，指纹写 null），那以后就认它。
 */
export function compareRuleTests(manifest, scanned) {
  const expected = new Map();
  for (const [file, tests] of Object.entries(manifest.tests)) for (const [test, fingerprint] of Object.entries(tests)) expected.set(keyOf(file, test), fingerprint);
  const invalid = [];
  manifest.changes.forEach((change, index) => {
    const where = `changes 第 ${index + 1} 条`;
    if (typeof change.date !== 'string' || !DATE.test(change.date)) invalid.push(`${where}：date 要写成 2026-11-12 这样`);
    if (typeof change.why !== 'string' || change.why.trim().length < 12) invalid.push(`${where}：why 要写清楚为什么能动这条规则测试`);
    if (typeof change.file !== 'string' || change.to === null || typeof change.to !== 'object') { invalid.push(`${where}：要有 file，to 写成 { "标题": "新的指纹" }`); return; }
    for (const [test, fingerprint] of Object.entries(change.to)) {
      if (fingerprint !== null && typeof fingerprint !== 'string') invalid.push(`${where}：「${test}」的指纹写现在的指纹，测试删掉了写 null`);
      else if (!expected.has(keyOf(change.file, test))) invalid.push(`${where}：清单的 tests 里没有「${test}」（${change.file}）`);
      else expected.set(keyOf(change.file, test), fingerprint);
    }
  });
  const now = new Map();
  for (const [file, tests] of Object.entries(scanned)) for (const [test, fingerprint] of Object.entries(tests)) now.set(keyOf(file, test), fingerprint);
  const changed = [], missing = [], added = [];
  for (const [key, fingerprint] of expected) {
    const current = now.get(key);
    if (fingerprint === null) { if (current !== undefined) changed.push({ ...partsOf(key), was: '记着已经删掉', now: current }); }
    else if (current === undefined) missing.push({ ...partsOf(key), was: fingerprint });
    else if (current !== fingerprint) changed.push({ ...partsOf(key), was: fingerprint, now: current });
  }
  for (const [key, fingerprint] of now) if (!expected.has(key)) added.push({ ...partsOf(key), now: fingerprint });
  return { changed, missing, added, invalid };
}

/** 把还没登记的测试加进清单，已有的不动。返回新的清单和加了哪些。 */
export function recordNewRuleTests(manifest, scanned) {
  const { added } = compareRuleTests(manifest, scanned);
  const tests = Object.fromEntries(Object.entries(manifest.tests).map(([file, entries]) => [file, { ...entries }]));
  for (const { file, test, now } of added) tests[file] = { ...(tests[file] ?? {}), [test]: now };
  return { manifest: { ...manifest, tests: Object.fromEntries(Object.keys(tests).sort().map((file) => [file, tests[file]])) }, added };
}

/** 对不上的地方，写成给人和给改代码的 AI 看的话；都对得上是空串。 */
export function ruleTestReport({ changed, missing, added, invalid }) {
  const lines = [];
  if (changed.length + missing.length > 0) {
    const files = new Map();
    for (const { file, test, now } of changed) files.set(file, { ...(files.get(file) ?? {}), [test]: now });
    for (const { file, test } of missing) files.set(file, { ...(files.get(file) ?? {}), [test]: null });
    lines.push('规则测试被改了、被跳过了或者不见了：');
    for (const { file, test, was, now } of changed) lines.push(`  改了    ${file} › ${test}（登记的是 ${was}，现在是 ${now}）`);
    for (const { file, test, was } of missing) lines.push(`  不见了  ${file} › ${test}（登记的是 ${was}）`);
    lines.push(
      '规则测试守着用户定下的规则（AGENTS.md 第 6 节）。代码让它红了是代码违反了规则：改代码，把测试改回去。',
      '只有两种情况能动规则测试：用户改了这条规则；或者规则没变，只是测试调用代码的写法要跟着变，断言一条没放松。',
      `那时在 ${RULE_TEST_MANIFEST} 的 changes 末尾加上下面的记录，填上 date（哪天）和 why（用户哪天怎么定的，写原话；或者变了什么、为什么断言没放松）：`,
      ...[...files].map(([file, to]) => `  ${JSON.stringify({ date: '', file, why: '', to })}`),
      'tests 里已有的指纹不要改，也不要删掉这个文件重新生成。'
    );
  }
  if (invalid.length > 0) lines.push(`${RULE_TEST_MANIFEST} 写得不对：`, ...invalid.map((line) => `  ${line}`));
  if (added.length > 0) {
    lines.push('有新的规则测试还没登记：');
    for (const { file, test } of added) lines.push(`  ${file} › ${test}`);
    lines.push(`运行 pnpm rules:record（只加新的，已有的不动），把 ${RULE_TEST_MANIFEST} 和测试放在同一次提交里。`);
  }
  return lines.join('\n');
}

/** 已经提交的清单 `committed` 里的指纹和改动记录，在现在的清单 `manifest` 里少了、改了哪些。 */
export function lostRuleTests(committed, manifest) {
  const lost = [];
  for (const [file, tests] of Object.entries(committed.tests)) {
    for (const [test, fingerprint] of Object.entries(tests)) if (manifest.tests[file]?.[test] !== fingerprint) lost.push(`${file} › ${test}`);
  }
  if (committed.changes.some((change, index) => JSON.stringify(change) !== JSON.stringify(manifest.changes[index]))) lost.push('changes 里已有的记录（只能在末尾加）');
  return lost;
}
