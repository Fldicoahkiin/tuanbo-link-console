// Writes CHANGELOG.md from release-notes/ (see scripts/release-notes.mjs). Run after changing a release-notes file
// and after raising the version in a release commit; scripts/release-notes.test.mjs fails while the two differ.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readReleaseNotes, renderChangelog } from './release-notes.mjs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const notes = readReleaseNotes(fileURLToPath(new URL('release-notes/', root)));
writeFileSync(new URL('CHANGELOG.md', root), renderChangelog(notes, version));
console.log(`CHANGELOG.md 已按 release-notes/ 更新：${notes.map(note => note.version).join('、')}（当前版本 ${version}）`);
