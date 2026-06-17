import { pino } from 'pino';

const logger = pino({ name: 'mm-live-secret' });

interface SecretClient {
  accessSecretVersion(req: { name: string }): Promise<[{ payload?: { data?: Uint8Array | Buffer } }]>;
}

/** GCP Secret Manager → fallback POLYGON_PRIVATE_KEY env. El cliente se inyecta
 *  para tests; en producción se construye perezosamente. */
export async function loadPrivateKey(
  secretName: string,
  env: Record<string, string | undefined>,
  client?: SecretClient,
): Promise<string> {
  if (secretName) {
    const c = client ?? (await buildClient());
    const [res] = await c.accessSecretVersion({ name: secretName });
    const data = res.payload?.data;
    if (data) {
      logger.info('Private key cargada desde GCP Secret Manager');
      return Buffer.from(data).toString('utf8').trim();
    }
  }
  const envKey = env.POLYGON_PRIVATE_KEY;
  if (envKey) {
    logger.info('Private key cargada desde POLYGON_PRIVATE_KEY');
    return envKey;
  }
  throw new Error('No private key disponible. Configura GCP Secret Manager o POLYGON_PRIVATE_KEY.');
}

async function buildClient(): Promise<SecretClient> {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — optional peer dep; only reached in production
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  return new SecretManagerServiceClient() as unknown as SecretClient;
}
