// Types for scripts/rule-tests.mjs, which apps/desktop/src/main/link/rule-manifest-scan.test.ts imports.
export type RuleTestScan = Readonly<Record<string, Readonly<Record<string, string>>>>;
export type RuleTestChange = { readonly date: string; readonly file: string; readonly why: string; readonly to: Readonly<Record<string, string | null>> };
export type RuleTestManifest = { readonly tests: RuleTestScan; readonly changes: readonly RuleTestChange[] };
export type RuleTestDifference = {
  readonly changed: readonly { readonly file: string; readonly test: string; readonly was: string; readonly now: string }[];
  readonly missing: readonly { readonly file: string; readonly test: string; readonly was: string }[];
  readonly added: readonly { readonly file: string; readonly test: string; readonly now: string }[];
  readonly invalid: readonly string[];
};

export declare const RULE_TEST_MANIFEST: string;
export declare const RULE_TEST_FILE: RegExp;
export function ruleTestFiles(repository: string): string[];
export function ruleTestsIn(path: string, text: string): Record<string, string>;
export function scanRuleTests(repository: string): RuleTestScan;
export function compareRuleTests(manifest: RuleTestManifest, scanned: RuleTestScan): RuleTestDifference;
export function recordNewRuleTests<Manifest extends RuleTestManifest>(manifest: Manifest, scanned: RuleTestScan): { manifest: Manifest; added: RuleTestDifference['added'] };
export function ruleTestReport(difference: RuleTestDifference): string;
export function lostRuleTests(committed: RuleTestManifest, manifest: RuleTestManifest): string[];
