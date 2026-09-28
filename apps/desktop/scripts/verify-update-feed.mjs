import { app } from 'electron';
import electronUpdater from 'electron-updater';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A separate Electron test process exercises the real NSIS downloader. It never
// loads the product workspace, grants a license, or calls quitAndInstall.
const desktopPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
let stage = 'electron-ready';
const timeout = setTimeout(() => { console.error(`Updater verification timed out at ${stage}`); app.exit(1); }, 10 * 60 * 1000);
const directory = await mkdtemp(join(tmpdir(), 'tblink-updater-check-'));
app.setPath('userData', directory);

async function client(version, url, name) {
  app.getVersion = () => version;
  const updater = new electronUpdater.NsisUpdater({ provider: 'generic', url });
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  updater.logger = null;
  updater.on('error', error => console.log(`updater event: ${error.message}`));
  const config = join(directory, `${name}.yml`);
  await writeFile(config, `provider: generic\nurl: ${url}\nupdaterCacheDirName: tblink-acceptance-${name}-${Date.now()}\n`);
  updater.updateConfigPath = config;
  return updater;
}

let fixture;
async function verify() {
  try {
    stage = 'check-current';
    console.log('Electron ready; checking published feed');
    assert.equal(process.platform, 'win32', 'Run the actual NSIS updater on Windows');
    const feed = desktopPackage.build.publish.url;
    const current = await client(desktopPackage.version, feed, 'current');
    let noUpdate = false;
    current.on('update-not-available', () => { noUpdate = true; });
    const currentResult = await current.checkForUpdates();
    assert.equal(currentResult.updateInfo.version, desktopPackage.version, 'Published feed must match the tested release');
    assert.equal(noUpdate, true);
    console.log('PASS: current release does not offer itself as an update');

    const previous = await client('0.0.1', feed, 'download');
    let downloaded = false;
    let reportedPercent = -25;
    previous.on('download-progress', progress => {
      const percent = Math.floor(progress.percent / 25) * 25;
      if (percent > reportedPercent) { reportedPercent = percent; console.log(`Live download: ${percent}%`); }
    });
    previous.on('update-downloaded', () => { downloaded = true; });
    const available = await previous.checkForUpdates();
    assert.equal(available.updateInfo.version, desktopPackage.version);
    stage = 'live-download';
    console.log('Starting complete HTTPS installer download');
    const paths = await previous.downloadUpdate();
    assert.equal(downloaded, true);
    assert.equal(paths.length, 1);
    const bytes = await readFile(paths[0]);
    const file = available.updateInfo.files.find(entry => entry.url.endsWith('.exe'));
    assert.ok(file);
    assert.equal(bytes.length, file.size);
    assert.equal(createHash('sha512').update(bytes).digest('base64'), file.sha512);
    const manifestPath = process.argv[2];
    assert.ok(manifestPath, 'Pass the verified release manifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const artifact = manifest.artifacts.find(entry => entry.path.endsWith(`/Tuanbo-Link-Console-${desktopPackage.version}-x64.exe`));
    assert.ok(artifact);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    console.log(`PASS: live HTTPS download ${desktopPackage.version}, ${bytes.length} bytes, SHA512 and release SHA256 match`);

    stage = 'corrupt-fixture';
    const expected = Buffer.from('original installer fixture');
    const corrupted = Buffer.from('modified installer fixture');
    const digest = createHash('sha512').update(expected).digest('base64');
    fixture = createServer((request, response) => {
      if (request.url?.startsWith('/latest.yml')) {
        response.end(`version: 99.0.0\nfiles:\n  - url: fixture.exe\n    sha512: ${digest}\n    size: ${expected.length}\npath: fixture.exe\nsha512: ${digest}\n`);
      } else if (request.url === '/fixture.exe') {
        response.end(corrupted);
      } else { response.writeHead(404).end(); }
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const address = fixture.address();
    assert.ok(address && typeof address === 'object');
    // Loopback HTTP exists only in this isolated corruption fixture. Production
    // LinkUpdateManager continues to require the fixed HTTPS feed.
    const bad = await client(desktopPackage.version, `http://127.0.0.1:${address.port}/`, 'corrupt');
    let acceptedCorrupt = false;
    bad.on('update-downloaded', () => { acceptedCorrupt = true; });
    await bad.checkForUpdates();
    await assert.rejects(bad.downloadUpdate(), /sha512 checksum mismatch/i);
    assert.equal(acceptedCorrupt, false);
    console.log('PASS: modified installer rejected by actual downloader; no downloaded event');
    clearTimeout(timeout);
    fixture.close();
    app.exit(0);
  } catch (error) {
    console.error(error);
    fixture?.close();
    clearTimeout(timeout);
    app.exit(1);
  }
}

// Electron waits for ESM entry evaluation before ready. Awaiting whenReady at
// module scope would deadlock the loader; register the work without awaiting it.
app.whenReady().then(verify).catch(error => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
