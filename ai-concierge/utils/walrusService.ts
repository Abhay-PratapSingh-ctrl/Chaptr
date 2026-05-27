// utils/walrusService.ts

const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

const extractBlobId = (result: any): string | null =>
  result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? null;

export const uploadJsonToWalrus = async (payload: unknown, epochs = 10): Promise<string> => {
  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=${epochs}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Walrus upload failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const blobId = extractBlobId(result);

  if (!blobId) throw new Error(`No blobId in Walrus response: ${JSON.stringify(result)}`);
  return blobId;
};

export const fetchJsonFromWalrus = async <T = any>(blobId: string): Promise<T> => {
  const response = await fetch(`${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`);

  if (!response.ok) {
    throw new Error(`Walrus fetch failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
};

const encryptVector = (vector: number[], userAddress: string): string => {
  const key = userAddress.slice(2, 18);
  const json = JSON.stringify(vector);

  return Array.from(json)
    .map((char, i) =>
      (char.charCodeAt(0) ^ key.charCodeAt(i % key.length))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
};

const decryptVector = (encrypted: string, userAddress: string): number[] => {
  const key = userAddress.slice(2, 18);

  const decrypted = encrypted
    .match(/.{2}/g)!
    .map((hex, i) =>
      String.fromCharCode(parseInt(hex, 16) ^ key.charCodeAt(i % key.length)),
    )
    .join('');

  return JSON.parse(decrypted);
};

export const uploadVectorToWalrus = async (
  vector: number[],
  userAddress: string,
): Promise<string> => {
  const encryptedPayload = encryptVector(vector, userAddress);

  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=10`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: encryptedPayload,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walrus upload failed: ${response.status} ${text}`);
  }

  const result = await response.json();

  const blobId =
    result.newlyCreated?.blobObject?.blobId ??
    result.alreadyCertified?.blobId;

  if (!blobId) {
    throw new Error(`No blobId in Walrus response: ${JSON.stringify(result)}`);
  }

  return blobId;
};

export const fetchVector = async (
  blobId: string,
  userAddress: string,
): Promise<number[]> => {
  const response = await fetch(
    `${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walrus fetch failed: ${response.status} ${text}`);
  }

  const encrypted = await response.text();
  return decryptVector(encrypted, userAddress);
};