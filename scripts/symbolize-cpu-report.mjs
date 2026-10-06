import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';

// Resolve only sampled addresses, retaining raw addresses and requiring the
// exact PDB identity from ETW. Breakpad symbols avoid a multi-GB PDB download.
const [reportPath, symbolsPath, destination] = process.argv.slice(2);
assert(reportPath && symbolsPath && destination);
const report = JSON.parse(await readFile(reportPath, 'utf8'));
const modules = report.Modules.filter(module => module.Name === 'electron');
assert.equal(modules.length, 1, 'PID reuse or missing module identity requires an explicit process window');
const module = modules[0], base = BigInt(module.ImageBase);
const expected = module.PdbSignature.toUpperCase() + module.PdbAge.toString(16).toUpperCase();
const addresses = [...new Set(report.Stacks.flatMap(stack => [...stack.Stack.matchAll(/electron!(0x[\da-f]+)/g)].map(match => match[1])))];
const targets = addresses.map(address => ({ address, rva: Number(BigInt(address) - base) })).sort((a, b) => a.rva - b.rva);
const names = new Map();
let verified = false;
for await (const line of createInterface({ input: createReadStream(symbolsPath), crlfDelay: Infinity })) {
  if (line.startsWith('MODULE ')) {
    assert.equal(line.split(' ')[3], expected, 'Symbol identity does not match the recorded executable'); verified = true;
  }
  const match = /^FUNC (?:m )?([\da-f]+) ([\da-f]+) [\da-f]+ (.*)$/.exec(line);
  if (!match) continue;
  assert(verified);
  const start = parseInt(match[1], 16), end = start + parseInt(match[2], 16);
  let low = 0, high = targets.length;
  while (low < high) { const middle = (low + high) >>> 1; if (targets[middle].rva < start) low = middle + 1; else high = middle; }
  for (let index = low; index < targets.length && targets[index].rva < end; index++) names.set(targets[index].address, match[3]);
}
assert(verified);
const inclusive = new Map();
const stacks = report.Stacks.map(stack => {
  const functions = new Set([...stack.Stack.matchAll(/electron!(0x[\da-f]+)/g)].flatMap(match => names.has(match[1]) ? [names.get(match[1])] : []));
  for (const name of functions) inclusive.set(name, (inclusive.get(name) ?? 0) + stack.Samples);
  return { ...stack, Symbols: stack.Stack.replace(/electron!(0x[\da-f]+)/g, (raw, address) => names.has(address) ? `electron!${names.get(address)}` : raw) };
});
await writeFile(destination, JSON.stringify({ ...report, symbolIdentity: expected, resolvedAddresses: names.size, totalAddresses: addresses.length,
  inclusiveSamples: [...inclusive].sort((a, b) => b[1] - a[1]).map(([name, samples]) => ({ name, samples })), Stacks: stacks }, null, 2));
console.log(JSON.stringify({ destination, resolvedAddresses: names.size, totalAddresses: addresses.length }));
