/**
 * Persönliches Token, verschlüsselt über Electrons `safeStorage` (Windows: DPAPI, Plan 5.6).
 * Liegt als `token.bin` in userData, atomar geschrieben. Ohne Verschlüsselung wird das Token
 * nur im Speicher gehalten (nie im Klartext auf die Platte).
 */
import { join } from 'node:path';
import { writeFileAtomic } from '../files';
import type { FileSystem, Logger, SecretCipher } from '../ports';

export class TokenStore {
  private readonly path: string;
  private memory: string | null = null;

  constructor(
    private readonly fs: FileSystem,
    private readonly cipher: SecretCipher,
    userDataDir: string,
    private readonly logger?: Logger,
  ) {
    this.path = join(userDataDir, 'token.bin');
  }

  async load(): Promise<string | null> {
    if (this.memory !== null) return this.memory;
    if (!(await this.cipher.isAvailable())) return null;
    const stat = await this.fs.stat(this.path);
    if (stat === null) return null;
    try {
      const token = await this.cipher.decrypt(await this.fs.readFile(this.path));
      this.memory = token === '' ? null : token;
      return this.memory;
    } catch (error) {
      this.logger?.warn('Token nicht lesbar – neu anmelden nötig.', error);
      return null;
    }
  }

  async save(token: string): Promise<void> {
    this.memory = token;
    if (!(await this.cipher.isAvailable())) {
      this.logger?.warn('safeStorage nicht verfügbar – Token wird nicht gespeichert.');
      return;
    }
    await writeFileAtomic(this.fs, this.path, await this.cipher.encrypt(token));
  }

  /** Token ungültig (401): vergessen. Die Datei wird überschrieben, nicht gelöscht. */
  async clear(): Promise<void> {
    this.memory = null;
    if (!(await this.cipher.isAvailable())) return;
    if ((await this.fs.stat(this.path)) === null) return;
    await writeFileAtomic(this.fs, this.path, await this.cipher.encrypt(''));
  }
}
