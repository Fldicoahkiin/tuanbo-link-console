import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';

export async function measureDesktopResources(app, page, obsPid, directory) {
  const samples = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const duration = Number(process.env.TBLINK_RESOURCE_PHASE_SECONDS ?? 30);
  if (!Number.isInteger(duration) || duration < 10 || duration > 600) throw new Error('Resource phase must be 10–600 seconds');
  const powerShell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const ps = script => promisify(execFile)(powerShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  await page.addInitScript(() => {
    const counters = { paints: 0, lags: [], longTasks: [] };
    Reflect.set(globalThis, '__resourceCounters', counters);
    const original = globalThis.CanvasRenderingContext2D.prototype.putImageData;
    globalThis.CanvasRenderingContext2D.prototype.putImageData = function (...args) {
      if (this.canvas.getAttribute('aria-label') === 'OBS 实时画面') counters.paints++;
      return original.apply(this, args);
    };
    let previous = performance.now();
    setInterval(() => { const now = performance.now(); counters.lags.push(Math.max(0, now - previous - 100)); previous = now; if (counters.lags.length > 10000) counters.lags.shift(); }, 100);
    const observer = new globalThis.PerformanceObserver(list => { for (const entry of list.getEntries()) counters.longTasks.push(entry.duration); if (counters.longTasks.length > 10000) counters.longTasks.splice(0, counters.longTasks.length - 10000); });
    observer.observe({ type: 'longtask', buffered: false });
  });
  const originalSettings = await page.evaluate(() => ({ power: localStorage.getItem('tblink.low-power') }));
  // The isolated project is deliberately saved so reloads exercise normal restoration.
  await app.evaluate(({ dialog }, path) => { dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path }); }, join(directory, 'resource.tblink'));
  await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await page.reload();
  const editor = () => page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '编辑器', exact: true }).click();
  await editor();
  const sample = async (phase) => {
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, type, cpu, memory })));
    const pids = [...new Set([...metrics.map(entry => entry.pid), obsPid])];
    const script = `$ErrorActionPreference='Stop'; $ids=@(${pids.join(',')}); $processes=@(foreach($id in $ids){try{$p=Get-Process -Id $id -ErrorAction Stop; [pscustomobject]@{pid=$id;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;privateBytes=$p.PrivateMemorySize64;workingSet=$p.WorkingSet64}}catch{if($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId,*'){throw}}}); $engines=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object {$_.Name -match '^pid_(\\d+)_' -and $ids -contains [int]$Matches[1]} | Select-Object Name,UtilizationPercentage); $memory=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object {$_.Name -match '^pid_(\\d+)_' -and $ids -contains [int]$Matches[1]} | Select-Object Name,DedicatedUsage,SharedUsage); @{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();processes=$processes;engines=$engines;gpuMemory=$memory}|ConvertTo-Json -Depth 5 -Compress`;
    const raw = JSON.parse((await ps(script)).stdout.replace(/^\uFEFF/, ''));
    const counters = await page.evaluate(() => {
      const counters = Reflect.get(globalThis, '__resourceCounters');
      const result = { paints: counters.paints, lags: [...counters.lags], longTasks: [...counters.longTasks] };
      counters.lags.length = 0; counters.longTasks.length = 0;
      return result;
    });
    const entry = { phase, ...raw, metrics, counters };
    samples.push(entry);
    return entry;
  };
  const phase = async (name) => {
    const deadline = Date.now() + duration * 1000;
    while (Date.now() < deadline) {
      await sample(name);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(JSON.stringify({ resourcePhase: name, samples: samples.filter(entry => entry.phase === name).length }));
  };
  try {
    await phase('preview');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await phase('minimized');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await phase('restored');
    await page.evaluate(() => localStorage.setItem('tblink.low-power', 'true'));
    await page.reload(); await editor();
    await phase('low-power');
    await page.evaluate(() => localStorage.setItem('tblink.low-power', 'false'));
    await page.reload(); await editor();
    for (let cycle = 0; cycle < 15; cycle++) {
      await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
      await editor();
      await sample('switching');
    }
    await phase('recovered');
    assert.deepEqual(errors, []);
  } finally {
    await writeFile(join(directory, 'resource-samples.json'), JSON.stringify({ duration, logicalProcessors: cpus().length, obsPid, errors, samples }, null, 2));
    await page.evaluate(value => { if (value === null) localStorage.removeItem('tblink.low-power'); else localStorage.setItem('tblink.low-power', value); }, originalSettings.power);
  }
}
