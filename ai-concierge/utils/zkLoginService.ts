import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { generateNonce, generateRandomness, getZkLoginSignature, getExtendedEphemeralPublicKey, genAddressSeed } from '@mysten/sui/zklogin';
import { jwtDecode } from 'jwt-decode';
import { toBase64, fromBase64 } from '@mysten/sui/utils';
import { Platform } from 'react-native';
import { Transaction } from '@mysten/sui/transactions';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const ENOKI_BASE_URL = 'https://api.enoki.mystenlabs.com/v1';
const ENOKI_PUBLIC_API_KEY = process.env.EXPO_PUBLIC_ENOKI_API_KEY || '';
const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const SUI_NETWORK = 'testnet';

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

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

export const client = new SuiJsonRpcClient({
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

export const getEnokiEphemeralPublicKey = (keypair: Ed25519Keypair): string => {
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
  const ZK_PROOF_CACHE_KEY = 'chaptr:zk-proof-cache';
  const ephemeralPublicKey = getEnokiEphemeralPublicKey(ephemeralKeyPair);

  const cachedStr = await storage.getItem(ZK_PROOF_CACHE_KEY);
  if (cachedStr) {
    try {
      const cached = JSON.parse(cachedStr);
      if (cached.maxEpoch === maxEpoch && cached.ephemeralPublicKey === ephemeralPublicKey) {
        return cached.payload;
      }
    } catch (e) {
      console.warn('Failed to parse cached ZK proof', e);
    }
  }

  const user = await enokiRequest<{
    salt: string;
    address: string;
    publicKey: string;
  }>('/zklogin', {
    headers: {
      'zklogin-jwt': jwt,
    },
  });

  let zkProof: any;
  let addressSeed: string;

  try {
    zkProof = await enokiRequest<{
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
        ephemeralPublicKey,
        maxEpoch,
        randomness: randomness.toString(),
      },
    });
    addressSeed = zkProof.addressSeed;
  } catch (e: any) {
    if (e.message?.includes('429')) {
      console.warn('Enoki rate limit hit. Falling back to public Mysten prover...');
      
      const publicProverRes = await fetch('https://prover-dev.mystenlabs.com/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jwt,
          extendedEphemeralPublicKey: getExtendedEphemeralPublicKey(ephemeralKeyPair.getPublicKey()),
          maxEpoch: maxEpoch.toString(),
          jwtRandomness: randomness.toString(),
          salt: user.salt,
          keyClaimName: 'sub'
        })
      });

      if (!publicProverRes.ok) {
        throw new Error('Public prover fallback failed: ' + await publicProverRes.text());
      }

      zkProof = await publicProverRes.json();
      
      const decoded = jwtDecode<any>(jwt);
      const aud = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
      addressSeed = genAddressSeed(BigInt(user.salt), 'sub', decoded.sub, aud).toString();
    } else {
      throw e;
    }
  }

  const payload = {
    zkProof,
    addressSeed,
    userSalt: user.salt,
    userAddress: user.address,
  };

  await storage.setItem(ZK_PROOF_CACHE_KEY, JSON.stringify({
    maxEpoch,
    ephemeralPublicKey,
    payload
  }));

  return payload;
};

// ─── Exported transaction helpers ─────────────────────────────────────────────
//
// These were previously inlined in morning-briefing.tsx.
// They live here now so any service (matchSync, etc.) can import them
// without pulling in the entire screen component.

/**
 * Prompts the user with a Google OAuth popup and returns an id_token JWT.
 * Used as the first step before any zkLogin-signed transaction.
 */
export const getJwtForTransaction = async (forcePrompt: boolean = false): Promise<string> => {
  if (!GOOGLE_CLIENT_ID) throw new Error('Missing EXPO_PUBLIC_GOOGLE_CLIENT_ID');

  const now = Date.now();
  const cachedJwt = await storage.getItem('chaptr_cached_jwt');
  const cachedExpiry = await storage.getItem('chaptr_cached_jwt_expires_at');
  
  if (!forcePrompt && cachedJwt && cachedExpiry && now < Number(cachedExpiry)) {
    return cachedJwt;
  }

  let nonce: string;
  try {
    const params = await loadZkLoginParams();
    nonce = generateNonce(
      params.ephemeralKeyPair.getPublicKey(),
      params.maxEpoch,
      params.randomness,
    );
  } catch {
    const params = await setupZkLoginParams();
    nonce = params.nonce;
  }

  const redirectUri = AuthSession.makeRedirectUri();

  const extraParams: any = { nonce };
  if (forcePrompt) {
    extraParams.prompt = 'select_account';
  }

  const request = new AuthSession.AuthRequest({
    clientId: GOOGLE_CLIENT_ID,
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ['openid', 'email', 'profile'],
    redirectUri,
    extraParams,
    usePKCE: false,
  });

  const result = await request.promptAsync(discovery);

  if (result.type !== 'success') throw new Error('Google sign-in was cancelled');
  if (!result.params.id_token) throw new Error('No id_token in Google response');

  await storage.setItem('chaptr_cached_jwt', result.params.id_token);
  // Cache for 50 minutes (JWTs expire in 60 mins)
  await storage.setItem('chaptr_cached_jwt_expires_at', (now + 50 * 60 * 1000).toString());

  return result.params.id_token;
};

/**
 * Signs and executes a Transaction using the current zkLogin session.
 *
 * @param tx           - The pre-built Transaction object
 * @param expectedOwner - The Sui address this session must match
 * @param jwt           - The id_token from getJwtForTransaction()
 *
 * Throws if the Google account selected doesn't match expectedOwner.
 * Throws if ZK params are missing (session expired).
 */
export const executeZkLoginTransaction = async (
  tx: Transaction,
  expectedOwner: string,
  jwt: string,
) => {
  const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
  const { zkProof, addressSeed, userAddress } = await fetchZkProof(
    jwt,
    ephemeralKeyPair,
    maxEpoch,
    randomness,
  );

  if (userAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error('Selected Google account does not match this browser identity.');
  }

  tx.setSender(userAddress);
  const txBytesUint8 = await tx.build({ client });
  const { signature: userSignature } = await ephemeralKeyPair.signTransaction(txBytesUint8);

  const zkSignature = getZkLoginSignature({
    inputs: { ...zkProof, addressSeed },
    maxEpoch,
    userSignature,
  });

  return client.executeTransactionBlock({
    transactionBlock: txBytesUint8,
    signature: zkSignature,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
};

/**
 * Executes a Transaction by sending it to our Vercel API for Shinami Gas Sponsorship.
 * Eliminates the need for the user to hold SUI for gas.
 */
export const executeSponsoredZkLoginTransaction = async (
  tx: Transaction,
  expectedOwner: string,
  jwt: string,
) => {
  const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
  const { zkProof, addressSeed, userAddress } = await fetchZkProof(
    jwt,
    ephemeralKeyPair,
    maxEpoch,
    randomness,
  );

  if (userAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error('Selected Google account does not match this browser identity.');
  }

  tx.setSender(userAddress);
  const txBytesUint8 = await tx.build({ client, onlyTransactionKind: true });

  const sponsorRes = await fetch('/api/sponsor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      txBytes: toBase64(txBytesUint8),
      sender: userAddress,
    })
  });

  if (!sponsorRes.ok) {
    const text = await sponsorRes.text();
    throw new Error(`Sponsor API failed: ${text}`);
  }

  const { txBytes, signature: sponsorSignature } = await sponsorRes.json();
  const sponsoredTxBytesUint8 = fromBase64(txBytes);

  const { signature: userSignature } = await ephemeralKeyPair.signTransaction(sponsoredTxBytesUint8);

  const zkSignature = getZkLoginSignature({
    inputs: { ...zkProof, addressSeed },
    maxEpoch,
    userSignature,
  });

  return client.executeTransactionBlock({
    transactionBlock: sponsoredTxBytesUint8,
    signature: [zkSignature, sponsorSignature],
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
};