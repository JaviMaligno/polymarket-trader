import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the GCP module before importing
vi.mock('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion = vi.fn().mockResolvedValue([
      { payload: { data: Buffer.from('0xdeadbeefprivatekey') } }
    ]);
  },
}));

import { loadPrivateKey } from '../SecretManager.js';

describe('SecretManager', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.POLYGON_PRIVATE_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('loads private key from GCP Secret Manager', async () => {
    const key = await loadPrivateKey('projects/my-project/secrets/polymarket-bot-key/versions/latest');
    expect(key).toBe('0xdeadbeefprivatekey');
  });

  it('falls back to env var if secret name not configured', async () => {
    process.env.POLYGON_PRIVATE_KEY = '0xfallback';
    const key = await loadPrivateKey('');
    expect(key).toBe('0xfallback');
  });

  it('throws if no key available', async () => {
    await expect(loadPrivateKey('')).rejects.toThrow();
  });
});
