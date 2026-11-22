// Turns the encrypted rows saved from the admin panel into a usable PlatformAi
// object (keys decrypted, in memory only). Runs on the server only.
import { type PlatformAi, PROVIDERS, type ProviderName } from "./ai.ts";
import { decryptSecret, importMasterKey } from "./crypto.ts";

export const MASTER_KEY_ENV = "FAIDAHQ_ENCRYPTION_KEY";

export interface CredentialRow {
  provider: string;
  encrypted_key: string;
  key_hint: string;
  default_model: string | null;
  base_url: string | null;
  updated_at: string | null;
}

export interface PlatformSettingsRow {
  default_provider: string | null;
  fallback_provider: string | null;
}

/**
 * Decrypt every saved key. A key that cannot be decrypted (missing or wrong
 * master key, tampered row) is skipped and logged, so the chat can still fall
 * back to the function secrets instead of failing.
 */
export async function decryptPlatformAi(
  settings: PlatformSettingsRow | null,
  rows: CredentialRow[],
  masterSecret: string | undefined,
  log: (msg: string) => void = console.error,
): Promise<PlatformAi> {
  const platform: PlatformAi = {
    defaultProvider: settings?.default_provider ?? null,
    fallbackProvider: settings?.fallback_provider ?? null,
    credentials: {},
  };
  if (!rows.length) return platform;

  let key: CryptoKey;
  try {
    key = await importMasterKey(masterSecret);
  } catch (err) {
    log(`Saved AI keys ignored: ${(err as Error).message}`);
    return platform;
  }

  for (const row of rows) {
    if (!PROVIDERS.includes(row.provider as ProviderName)) continue;
    try {
      const apiKey = await decryptSecret(row.encrypted_key, key, row.provider);
      platform.credentials[row.provider as ProviderName] = {
        apiKey,
        defaultModel: row.default_model,
        baseUrl: row.base_url,
      };
    } catch {
      log(`Saved AI key for "${row.provider}" could not be decrypted (was ${MASTER_KEY_ENV} changed?)`);
    }
  }
  return platform;
}
