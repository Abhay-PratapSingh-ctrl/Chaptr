import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { generateNonce, generateRandomness } from '@mysten/sui/zklogin';
import { toBase64 } from '@mysten/sui/utils';
import { Platform } from 'react-native';


const ENOKI_BASE_URL = 'https://api.enoki.mystenlabs.com/v1';
const ENOKI_PUBLIC_API_KEY = process.env.EXPO_PUBLIC_ENOKI_API_KEY || '';
const SUI_NETWORK = 'testnet';

const storage = {
  async setItem(key: string, value: string) {
    if (Platform.OS === 'web') {
      localStorage.setItem(key, value);
      return;
    }

    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(key, value);
  },

  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return localStorage.getItem(key);
    }

    const SecureStore = await import('expo-secure-store');
    return SecureStore.getItemAsync(key);
  },

  async removeItem(key: string) {
    if (Platform.OS === 'web') {
      localStorage.removeItem(key);
      return;
    }

    const SecureStore = await import('expo-secure-store');
    await SecureStore.deleteItemAsync(key);
  },
};

const client = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl(SUI_NETWORK),
  network: SUI_NETWORK,
});

const enokiRequest = async <T>(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): Promise<T> => {
  const response = await fetch(`${ENOKI_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${ENOKI_PUBLIC_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Enoki request failed: ${response.status} ${text}`);
  }

  return JSON.parse(text).data;
};

const getEnokiEphemeralPublicKey = (keypair: Ed25519Keypair): string => {
  const bytes = keypair.getPublicKey().toSuiBytes();
  const encoded = toBase64(bytes);

  console.log('Enoki ephemeral public key byte length:', bytes.length);
  console.log('Enoki ephemeral public key:', encoded);

  return encoded;
};

export const getEpoch = async (): Promise<number> => {
  const { epoch } = await client.getLatestSuiSystemState();
  return Number(epoch);
};

export const clearZkLoginParams = async () => {
  await storage.removeItem('zk_secret_key');
  await storage.removeItem('zk_randomness');
  await storage.removeItem('zk_max_epoch');
};

export const setupZkLoginParams = async () => {
  await clearZkLoginParams();

  const ephemeralKeyPair = new Ed25519Keypair();
  const currentEpoch = await getEpoch();
  const maxEpoch = currentEpoch + 2;
  const randomness = generateRandomness();
  const nonce = generateNonce(
    ephemeralKeyPair.getPublicKey(),
    maxEpoch,
    randomness,
  );

  await storage.setItem('zk_secret_key', ephemeralKeyPair.getSecretKey());
  await storage.setItem('zk_randomness', randomness.toString());
  await storage.setItem('zk_max_epoch', maxEpoch.toString());

  return {
    ephemeralKeyPair,
    maxEpoch,
    randomness: randomness.toString(),
    nonce,
  };
};

export const loadZkLoginParams = async () => {
  const secretKeyStr = await storage.getItem('zk_secret_key');
  const randomness = await storage.getItem('zk_randomness');
  const maxEpochStr = await storage.getItem('zk_max_epoch');

  if (!secretKeyStr || !randomness || !maxEpochStr) {
    throw new Error('ZK params missing - please login again');
  }

  return {
    ephemeralKeyPair: Ed25519Keypair.fromSecretKey(secretKeyStr),
    randomness,
    maxEpoch: Number(maxEpochStr),
  };
};

export const fetchZkProof = async (
  jwt: string,
  ephemeralKeyPair: Ed25519Keypair,
  maxEpoch: number,
  randomness: string | bigint,
) => {
  const user = await enokiRequest<{
    salt: string;
    address: string;
    publicKey: string;
  }>('/zklogin', {
    headers: {
      'zklogin-jwt': jwt,
    },
  });

  const zkProof = await enokiRequest<{
    proofPoints: unknown;
    issBase64Details: unknown;
    headerBase64: string;
    addressSeed: string;
  }>('/zklogin/zkp', {
    method: 'POST',
    headers: {
      'zklogin-jwt': jwt,
    },
    body: {
      network: SUI_NETWORK,
      ephemeralPublicKey: getEnokiEphemeralPublicKey(ephemeralKeyPair),
      maxEpoch,
      randomness: randomness.toString(),
    },
  });

  return {
    zkProof,
    addressSeed: zkProof.addressSeed,
    userSalt: user.salt,
    userAddress: user.address,
  };
};