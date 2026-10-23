import { describe, expect, it, vi } from 'vitest';
import { AssetRelinkRequests } from './asset-relink-requests';

const open = '/shows/moved/show.tblink';
const file = { relativePath: 'assets/reference-audio/song.wav', sha256: 'a'.repeat(64) };

function requests(openProjectPath: string | null = open) {
  const projects = {
    findMissingAssetFiles: vi.fn(() => Promise.resolve([file.relativePath])),
    relinkAssetFiles: vi.fn(() => Promise.resolve([{ relativePath: file.relativePath, status: 'restored' as const }]))
  };
  // Stands in for ProjectAccess.assetFiles: only the shown project is accepted.
  const access = { assetFiles: vi.fn((projectPath: string) => projectPath === openProjectPath ? Promise.resolve([]) : Promise.reject(new Error(`只能访问当前打开的工程：${projectPath}`))) };
  return { projects, access, requests: new AssetRelinkRequests({ projects, access }) };
}

describe('AssetRelinkRequests', () => {
  it('只检查当前打开工程的缺失素材', async () => {
    const { projects, requests: subject } = requests();
    await expect(subject.findMissing({ projectPath: '/elsewhere/other.tblink', files: [file] })).rejects.toThrow('当前打开的工程');
    await expect(requests(null).requests.findMissing({ projectPath: open, files: [file] })).rejects.toThrow('当前打开的工程');
    expect(projects.findMissingAssetFiles).not.toHaveBeenCalled();
    await expect(subject.findMissing({ projectPath: open, files: [file] })).resolves.toEqual([file.relativePath]);
    expect(projects.findMissingAssetFiles).toHaveBeenCalledWith(open, [file]);
  });

  it('只从操作员在本进程文件夹对话框里最后选中的文件夹找回', async () => {
    const { projects, requests: subject } = requests();
    const relink = (sourceDirectory: string, projectPath = open) => subject.relink({ projectPath, sourceDirectory, files: [file] });
    await expect(relink('/shows/original')).rejects.toThrow('选择原工程文件夹');
    subject.pickedSourceDirectory('/shows/unrelated');
    subject.pickedSourceDirectory('/shows/original');
    await expect(relink('/shows/unrelated')).rejects.toThrow('选择原工程文件夹');
    await expect(relink('/shows/original', '/elsewhere/other.tblink')).rejects.toThrow('当前打开的工程');
    expect(projects.relinkAssetFiles).not.toHaveBeenCalled();
    // The dialog restores in several batches from one pick.
    await relink('/shows/original'); await relink('/shows/original');
    expect(projects.relinkAssetFiles).toHaveBeenCalledTimes(2);
    expect(projects.relinkAssetFiles).toHaveBeenCalledWith(open, '/shows/original', [file]);
    subject.pickedSourceDirectory(null);
    await expect(relink('/shows/original')).rejects.toThrow('选择原工程文件夹');
  });
});
