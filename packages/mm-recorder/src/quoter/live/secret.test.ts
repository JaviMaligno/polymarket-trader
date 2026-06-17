import { describe, it, expect, vi } from 'vitest';
import { loadPrivateKey } from './secret.js';

describe('loadPrivateKey', () => {
  it('devuelve la key del env si no hay secret name', async () => {
    const k = await loadPrivateKey('', { POLYGON_PRIVATE_KEY: '0xabc' });
    expect(k).toBe('0xabc');
  });

  it('usa Secret Manager cuando hay secret name', async () => {
    const access = vi.fn().mockResolvedValue([{ payload: { data: Buffer.from('0xdef') } }]);
    const k = await loadPrivateKey('projects/x/secrets/k/versions/latest', {}, { accessSecretVersion: access });
    expect(k).toBe('0xdef');
    expect(access).toHaveBeenCalledWith({ name: 'projects/x/secrets/k/versions/latest' });
  });

  it('lanza si no hay ninguna fuente', async () => {
    await expect(loadPrivateKey('', {})).rejects.toThrow('No private key');
  });
});
