import { readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';

const [identityFile, secondsText] = process.argv.slice(2);
const seconds = Number(secondsText);
if (process.platform !== 'win32' || !identityFile || !Number.isInteger(seconds) || seconds < 10 || seconds > 21600) throw new Error('需要验收进程身份文件和 10..21600 秒时长');
const identity = JSON.parse(await readFile(resolve(identityFile), 'utf8'));
if (!Number.isInteger(identity.pid) || identity.pid <= 0 || typeof identity.executable !== 'string' || typeof identity.started !== 'string') throw new Error('验收进程身份无效');
const directory = dirname(resolve(identityFile)), output = createWriteStream(resolve(directory, 'host-samples.ndjson'));
const run = promisify(execFile), quote = value => `'${value.replaceAll("'", "''")}'`;
const fields = ['name', 'driver_version', 'memory.total', 'memory.used', 'memory.free', 'utilization.gpu', 'utilization.decoder', 'temperature.gpu'];
const report = { seconds, sampledSeconds: 0, samples: 0, failures: [], minimumSystemFreeRatio: 1, minimumGpuFreeRatio: 1, maximumDecoderPercent: 0, maximumPrivateBytes: 0 };
output.on('error', error => report.failures.push(String(error)));
const start = performance.now();
try {
  while (performance.now() - start < seconds * 1000 && !report.failures.length) {
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-Process -Id ${identity.pid}; if($p.Path -ne ${quote(identity.executable)} -or $p.StartTime.ToUniversalTime().ToString('o') -ne ${quote(identity.started)}){throw '验收进程身份已改变'}; $os=Get-CimInstance Win32_OperatingSystem; @{privateBytes=$p.PrivateMemorySize64;workingSetBytes=$p.WorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;freeKb=$os.FreePhysicalMemory;totalKb=$os.TotalVisibleMemorySize}|ConvertTo-Json -Compress`;
    const [systemResult, gpuResult] = await Promise.all([
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 }),
      run('nvidia-smi', [`--query-gpu=${fields.join(',')}`, '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 10000 })
    ]);
    const system = JSON.parse(systemResult.stdout.replace(/^\uFEFF/, ''));
    const gpus = gpuResult.stdout.trim().split(/\r?\n/).map(line => {
      const values = line.split(',').map(value => value.trim());
      if (values.length !== fields.length) throw new Error('显卡数据字段不完整');
      const memoryTotalMiB = Number(values[2]), memoryFreeMiB = Number(values[4]), decoderPercent = Number(values[6]);
      if (![memoryTotalMiB, memoryFreeMiB, decoderPercent].every(Number.isFinite) || memoryTotalMiB <= 0) throw new Error('显卡监测数据不可用');
      report.minimumGpuFreeRatio = Math.min(report.minimumGpuFreeRatio, memoryFreeMiB / memoryTotalMiB);
      report.maximumDecoderPercent = Math.max(report.maximumDecoderPercent, decoderPercent);
      return Object.fromEntries(fields.map((field, index) => [field, values[index]]));
    });
    report.minimumSystemFreeRatio = Math.min(report.minimumSystemFreeRatio, system.freeKb / system.totalKb);
    report.maximumPrivateBytes = Math.max(report.maximumPrivateBytes, system.privateBytes);
    output.write(JSON.stringify({ at: new Date().toISOString(), elapsedMs: performance.now() - start, system, gpus }) + '\n');
    report.samples++;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
} catch (error) { report.failures.push(String(error)); process.exitCode = 1; }
finally {
  report.sampledSeconds = (performance.now() - start) / 1000;
  output.end(); await once(output, 'close');
  await writeFile(resolve(directory, 'host-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
