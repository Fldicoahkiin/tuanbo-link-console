import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileMaterialOwnLooks, ownLookOf } from './obs-material-own-looks';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function lookFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-own-looks-'));
  const file = join(directory, 'link-integrations', 'obs-material-own-looks.json');
  cleanup.push(() => rmdir(directory), () => rmdir(join(directory, 'link-integrations')).catch(() => undefined), () => unlink(file).catch(() => undefined));
  return file;
}

it('素材原来的样子记在本机文件里：记下时已经写进文件，重开软件还在；记过的不会被换掉，素材场景新建时作废（0.5.9 E16）', async () => {
  const file = await lookFile(), decoder = '团播联动台·素材·视频·0000000·来源';
  const looks = new FileMaterialOwnLooks(file);
  await expect(looks.read(decoder)).resolves.toBeNull();
  await looks.keep(decoder, { positionX: 540, boundsType: 'OBS_BOUNDS_SCALE_INNER' });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, looks: { [decoder]: { positionX: 540, boundsType: 'OBS_BOUNDS_SCALE_INNER' } } });
  await looks.keep(decoder, { positionX: 1 });
  const restarted = new FileMaterialOwnLooks(file);
  await expect(restarted.read(decoder)).resolves.toEqual({ positionX: 540, boundsType: 'OBS_BOUNDS_SCALE_INNER' });
  await restarted.drop(decoder);
  await expect(new FileMaterialOwnLooks(file).read(decoder)).resolves.toBeNull();
});

it('文件坏了就说出来，不当作没记过；记下的只是能写回 OBS 的那部分', async () => {
  const file = await lookFile();
  await new FileMaterialOwnLooks(file).keep('a', { positionX: 1 });
  await writeFile(file, '{"version":1,');
  await expect(new FileMaterialOwnLooks(file).read('a')).rejects.toThrow('本机记下的素材原来的样子损坏了');
  expect(ownLookOf({ positionX: 1, sourceWidth: 1920, sourceHeight: 1080, width: 960, height: 540, boundsType: 'OBS_BOUNDS_NONE', cropToBounds: false }))
    .toEqual({ positionX: 1, boundsType: 'OBS_BOUNDS_NONE', cropToBounds: false });
});

it('原来的样子带着裁剪；联动台在哪个解码器上做过画面调节滤镜也记在同一个文件里，没做过时文件和以前一样（0.5.9 E17）', async () => {
  const file = await lookFile(), decoder = '团播联动台·素材·视频·0000000·来源', standby = `${decoder}·预备`;
  expect(ownLookOf({ positionX: 1, cropLeft: 30, cropTop: 12, cropRight: 0, cropBottom: 0, sourceWidth: 1920 })).toEqual({ positionX: 1, cropLeft: 30, cropTop: 12, cropRight: 0, cropBottom: 0 });
  const looks = new FileMaterialOwnLooks(file);
  await looks.keep(decoder, { positionX: 540 });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, looks: { [decoder]: { positionX: 540 } } });
  await expect(looks.filterMade(standby)).resolves.toBe(false);
  await looks.keepFilterMade(standby);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, looks: { [decoder]: { positionX: 540 } }, filters: [standby] });
  const restarted = new FileMaterialOwnLooks(file);
  await expect(restarted.filterMade(standby)).resolves.toBe(true);
  await expect(restarted.filterMade(decoder)).resolves.toBe(false);
  await restarted.forgetFilterMade(standby);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, looks: { [decoder]: { positionX: 540 } } });
  await expect(new FileMaterialOwnLooks(file).filterMade(standby)).resolves.toBe(false);
});
