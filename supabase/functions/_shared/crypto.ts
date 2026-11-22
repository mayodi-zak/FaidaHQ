// AES-256-GCM encryption for API keys stored in the database.
//
// The master key comes from ONE Supabase secret, FAIDAHQ_ENCRYPTION_KEY:
// 32 random bytes, base64-encoded. Create it with:
//   openssl rand -base64 32
// It never goes into the database, the repository or the browser.
//
// Stored format: "v1:<base64 iv>:<base64 ciphertext+tag>"
// The provider name is bound as additional authenticated data, so a ciphertext
// copied onto another provider's row will not decrypt.

const enc = new TextEncoder();
const dec = new TextDecoder();

export class CryptoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CryptoConfigError";
  }
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, CryptoKey>();

export async function importMasterKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new CryptoConfigError("FAIDAHQ_ENCRYPTION_KEY is not set");
  const cached = keyCache.get(secret);
  if (cached) return cached;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64decode(secret.trim());
  } catch {
    throw new CryptoConfigError("FAIDAHQ_ENCRYPTION_KEY must be base64 (use: openssl rand -base64 32)");
  }
  if (raw.length !== 32) {
    throw new CryptoConfigError("FAIDAHQ_ENCRYPTION_KEY must be 32 bytes (use: openssl rand -base64 32)");
  }
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  keyCache.set(secret, key);
  return key;
}

export async function encryptSecret(plain: string, key: CryptoKey, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(context) }, key, enc.encode(plain)),
  );
  return `v1:${b64encode(iv)}:${b64encode(ct)}`;
}

export async function decryptSecret(stored: string, key: CryptoKey, context: string): Promise<string> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw new Error("Unknown encrypted key format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(parts[1]), additionalData: enc.encode(context) },
    key,
    b64decode(parts[2]),
  );
  return dec.decode(plain);
}

/** "sk-abc...wxyz" -> "…wxyz": safe to show in the admin panel. */
export function keyHint(plain: string): string {
  const t = plain.trim();
  return t.length <= 8 ? "…" : "…" + t.slice(-4);
}
