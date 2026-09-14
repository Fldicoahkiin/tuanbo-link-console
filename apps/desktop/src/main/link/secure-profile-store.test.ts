import { mkdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IntegrationProfile } from '@tb/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { SecureProfileStore, type SafeStoragePort } from './secure-profile-store';

const cleanupFiles: string[] = [];
const cleanupDirectories: string[] = [];

afterEach(async () => {
  for (const filePath of cleanupFiles.splice(0).reverse()) await unlink(filePath).catch(ignoreMissing);
  for (const directory of cleanupDirectories.splice(0).reverse()) await rmdir(directory).catch(ignoreMissing);
});

describe('SecureProfileStore', () => {
  it('档案与密文分开保存，磁盘不出现 OBS 明文密码', async () => {
    const directory = await createTestDirectory();
    const store = new SecureProfileStore(directory, reversibleStorage(true));
    const profile = integrationProfile();
    await store.saveProfile(profile);
    await store.saveCredential(profile.obs.credentialId, 'sensitive-password');

    const integrationDirectory = join(directory, 'link-integrations');
    const profilePath = join(integrationDirectory, 'profile.json');
    const secretsPath = join(integrationDirectory, 'secrets.json');
    cleanupFiles.push(profilePath, secretsPath);
    cleanupDirectories.push(integrationDirectory);

    expect(await store.loadProfile()).toEqual(profile);
    await expect(store.loadCredential('obs-main')).resolves.toBe('sensitive-password');
    expect(await readFile(profilePath, 'utf8')).not.toContain('sensitive-password');
    expect(await readFile(secretsPath, 'utf8')).not.toContain('sensitive-password');
  });

  it('安全存储不可用时阻止保存和连接', async () => {
    const directory = await createTestDirectory();
    const store = new SecureProfileStore(directory, reversibleStorage(false));
    await expect(store.saveCredential('obs-main', 'password')).rejects.toThrow('安全存储不可用');
    await expect(store.loadCredential('obs-main')).rejects.toThrow('安全存储不可用');
  });

  it('可以检查并删除独立凭证且不影响其他凭证', async () => {
    const directory = await createTestDirectory();
    const store = new SecureProfileStore(directory, reversibleStorage(true));
    await store.saveCredential('obs-main', 'obs-password');
    await store.saveCredential('github.update.token', 'github-token');

    const integrationDirectory = join(directory, 'link-integrations');
    cleanupFiles.push(join(integrationDirectory, 'secrets.json'));
    cleanupDirectories.push(integrationDirectory);

    await expect(store.hasCredential('github.update.token')).resolves.toBe(true);
    await store.deleteCredential('github.update.token');
    await expect(store.hasCredential('github.update.token')).resolves.toBe(false);
    await expect(store.loadCredential('obs-main')).resolves.toBe('obs-password');
    await expect(store.loadCredential('github.update.token')).rejects.toThrow('未找到凭证');
  });
});

function integrationProfile(): IntegrationProfile {
  return {
    schemaVersion: 1,
    profileId: 'default',
    name: '现场机器',
    updatedAt: '2026-08-26T00:00:00.000Z',
    obs: {
      ...executable('C:\\OBS\\obs64.exe'),
      credentialId: 'obs-main',
      webSocketUrl: 'ws://127.0.0.1:4455'
    },
    p1: {
      ...executable('C:\\P1\\P1.exe'),
      mtcInputPortProfileId: 'p1-mtc',
      controlOutputPortProfileId: 'p1-control',
      expectedFrameRate: '30'
    },
    midiPortProfiles: [
      { id: 'p1-mtc', direction: 'input', portName: 'P1 MTC' },
      { id: 'p1-control', direction: 'output', portName: 'P1 Control' }
    ],
    acceptedVersions: { obs: '32.2.2', p1: 'pending' }
  };
}

function executable(executablePath: string) {
  return {
    executablePath,
    arguments: [],
    workingDirectory: executablePath.slice(0, executablePath.lastIndexOf('\\')),
    startupTimeoutMs: 10_000,
    shutdownTimeoutMs: 10_000
  };
}

function reversibleStorage(available: boolean): SafeStoragePort {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from([...value].reverse().join(''), 'utf8'),
    decryptString: (value) => [...value.toString('utf8')].reverse().join('')
  };
}

async function createTestDirectory(): Promise<string> {
  const directory = join(tmpdir(), `secure-profile-${crypto.randomUUID()}`);
  await mkdir(directory);
  cleanupDirectories.push(directory);
  return directory;
}

function ignoreMissing(error: unknown): void {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
  throw error;
}
