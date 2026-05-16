import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { generateNonce, generateRandomness, jwtToAddress } from '@mysten/sui/zklogin';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Platform } from 'react-native';

// Platform-aware storage: localStorage on web, SecureStore on native
const storage = {
  async setItem(key: string, value: string) {
    if (Platform.OS === 'web') {
      localStorage.setItem(key, value);
    } else {
      const SecureStore = await import('expo-secure-store');
      await SecureStore.setItemAsync(key, value);
    }
  },
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return localStorage.getItem(key);
    } else {
      const SecureStore = await import('expo-secure-store');
      return await SecureStore.getItemAsync(key);
    }
  },
};

const client = new SuiClient({ url: getFullnodeUrl('testnet') });

export const getEpoch = async () => {
  const { epoch } = await client.getLatestSuiSystemState();
  return Number(epoch);
};

export const setupZkLoginParams = async () => {
  const ephemeralKeyPair = new Ed25519Keypair();
  const currentEpoch = await getEpoch();
  const maxEpoch = currentEpoch + 2;
  const randomness = generateRandomness();
  const nonce = generateNonce(
    ephemeralKeyPair.getPublicKey(),
    maxEpoch,
    randomness
  );

  // Persist — needed for ZK proof generation after Google redirect
  await storage.setItem('zk_secret_key', ephemeralKeyPair.getSecretKey());
  await storage.setItem('zk_randomness', randomness.toString());
  await storage.setItem('zk_max_epoch', maxEpoch.toString());

  return { ephemeralKeyPair, maxEpoch, randomness, nonce };
};

export const loadZkLoginParams = async () => {
  const secretKeyStr = await storage.getItem('zk_secret_key');
  const randomness = await storage.getItem('zk_randomness');
  const maxEpoch = await storage.getItem('zk_max_epoch');

  if (!secretKeyStr || !randomness || !maxEpoch) {
    throw new Error('ZK params missing — user must log in again');
  }

  const ephemeralKeyPair = Ed25519Keypair.fromSecretKey(secretKeyStr);

  return {
    ephemeralKeyPair,
    randomness: BigInt(randomness),
    maxEpoch: Number(maxEpoch),
  };
};
export const fetchZkProof = async (
    jwt: string, 
    ephemeralKeyPair: any, 
    maxEpoch: number, 
    randomness: string
) => {
    const userSalt = "1234567891011121314151617181920"; 
    const userAddress = jwtToAddress(jwt, userSalt);

    const proofResponse = await fetch('https://prover-dev.mystenlabs.com/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jwt: jwt,
            extendedEphemeralPublicKey: ephemeralKeyPair.getPublicKey().toSuiPublicKey(),
            maxEpoch: maxEpoch,
            jwtRandomness: randomness,
            salt: userSalt,
            keyClaimName: 'sub'
        }),
    });

    if (!proofResponse.ok) {
        throw new Error(`Prover failed: ${await proofResponse.text()}`);
    }

    const zkProof = await proofResponse.json();
    return { zkProof, userSalt, userAddress };
};