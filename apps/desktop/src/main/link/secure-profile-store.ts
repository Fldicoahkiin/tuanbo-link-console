import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseIntegrationProfile, type IntegrationProfile } from '@tb/schema';
import { writeFileAtomically } from './atomic-file';

export type SafeStoragePort = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

type StoredSecrets = {
  schemaVersion: 1;
  credentials: Record<string, string>;
};

export class SecureProfileStore {
  private readonly profilePath: string;
  private readonly secretsPath: string;
  private credentialWrites: Promise<void> = Promise.resolve();

  constructor(
    userDataDirectory: string,
    private readonly safeStorage: SafeStoragePort
  ) {
    const integrationDirectory = join(userDataDirectory, 'link-integrations');
    this.profilePath = join(integrationDirectory, 'profile.json');
    this.secretsPath = join(integrationDirectory, 'secrets.json');
  }

  async loadProfile(): Promise<IntegrationProfile | null> {
    const content = await readOptionalFile(this.profilePath);
    if (content === null) return null;
    return parseIntegrationProfile(parseJson(content, this.profilePath));
  }

  async saveProfile(profile: IntegrationProfile): Promise<void> {
    const parsed = parseIntegrationProfile(profile);
    await writeFileAtomically(this.profilePath, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  async saveCredential(credentialId: string, password: string): Promise<void> {
    assertCredentialId(credentialId);
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储不可用，无法保存密码');
    }
    await this.writeCredentials(async () => {
      const secrets = await this.loadSecrets();
      secrets.credentials[credentialId] = this.safeStorage.encryptString(password).toString('base64');
      await writeFileAtomically(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`);
    });
  }

  async loadCredential(credentialId: string): Promise<string> {
    assertCredentialId(credentialId);
    await this.credentialWrites;
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储不可用，无法读取密码');
    }
    const secrets = await this.loadSecrets();
    const encoded = secrets.credentials[credentialId];
    if (!encoded) throw new Error(`找不到保存的密码：${credentialId}`);
    try {
      return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch (error) {
      throw new Error(`保存的密码无法解密，请重新输入：${credentialId}`, { cause: error });
    }
  }

  async hasCredential(credentialId: string): Promise<boolean> {
    assertCredentialId(credentialId);
    await this.credentialWrites;
    const secrets = await this.loadSecrets();
    return typeof secrets.credentials[credentialId] === 'string';
  }

  /** No saved password means an explicit unauthenticated OBS handshake.
   * A saved but unreadable password must still fail; never discard it or retry empty.
   */
  async loadObsPassword(credentialId: string): Promise<string> {
    if (!await this.hasCredential(credentialId)) return '';
    return this.loadCredential(credentialId);
  }

  async deleteCredential(credentialId: string): Promise<void> {
    assertCredentialId(credentialId);
    await this.writeCredentials(async () => {
      const secrets = await this.loadSecrets();
      if (!(credentialId in secrets.credentials)) return;
      delete secrets.credentials[credentialId];
      await writeFileAtomically(this.secretsPath, `${JSON.stringify(secrets, null, 2)}\n`);
    });
  }

  private writeCredentials(write: () => Promise<void>): Promise<void> {
    const result = this.credentialWrites.then(write);
    // Each caller receives its failure; a failed write must not poison later writes.
    this.credentialWrites = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadSecrets(): Promise<StoredSecrets> {
    const content = await readOptionalFile(this.secretsPath);
    if (content === null) return { schemaVersion: 1, credentials: {} };
    const value = parseJson(content, this.secretsPath);
    if (!isStoredSecrets(value)) throw new Error(`保存密码的文件已损坏：${this.secretsPath}`);
    return value;
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return null;
    throw error;
  }
}

function parseJson(content: string, filePath: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`文件已损坏：${filePath}`, { cause: error });
  }
}

function isStoredSecrets(value: unknown): value is StoredSecrets {
  if (typeof value !== 'object' || value === null) return false;
  if (!('schemaVersion' in value) || value.schemaVersion !== 1) return false;
  if (!('credentials' in value) || typeof value.credentials !== 'object' || value.credentials === null) return false;
  return Object.values(value.credentials).every((credential) => typeof credential === 'string');
}

function assertCredentialId(value: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error('凭证 ID 包含非法字符');
}

function isErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}
