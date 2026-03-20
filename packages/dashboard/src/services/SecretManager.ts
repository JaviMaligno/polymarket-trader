import pino from 'pino';

const logger = pino({ name: 'SecretManager' });

export async function loadPrivateKey(secretName: string): Promise<string> {
  // Try GCP Secret Manager first
  if (secretName) {
    try {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const [version] = await client.accessSecretVersion({ name: secretName });
      const key = version.payload?.data?.toString();
      if (key) {
        logger.info('Private key loaded from GCP Secret Manager');
        return key;
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load from GCP Secret Manager, trying env var');
    }
  }

  // Fallback to env var (for local development / testing)
  const envKey = process.env.POLYGON_PRIVATE_KEY;
  if (envKey) {
    logger.info('Private key loaded from POLYGON_PRIVATE_KEY env var');
    return envKey;
  }

  throw new Error('No private key available. Configure GCP Secret Manager or POLYGON_PRIVATE_KEY env var.');
}
