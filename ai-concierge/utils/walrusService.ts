// utils/walrusService.ts

const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

// Encrypt vector client-side before it ever leaves the device
const encryptVector = (vector: number[], userAddress: string): string => {
  // XOR-based deterministic encryption keyed to wallet address
  // Replace with Seal (Mysten's threshold encryption) for production
  const key = userAddress.slice(2, 18); // 16-char key from address
  const json = JSON.stringify(vector);
  const encrypted = Array.from(json).map((char, i) =>
    (char.charCodeAt(0) ^ key.charCodeAt(i % key.length)).toString(16).padStart(2, '0')
  ).join('');
  return encrypted;
};

export const uploadVectorToWalrus = async (
  vector: number[],
  userAddress: string
): Promise<string> => {
  // Encrypt BEFORE upload — vector never leaves device in plaintext
  const encryptedPayload = encryptVector(vector, userAddress);

  const response = await fetch(`${PUBLISHER}/v1/store?epochs=10`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedPayload,
  });

  if (!response.ok) throw new Error(`Walrus upload failed: ${response.status}`);

  const result = await response.json();

  const blobId = result.newlyCreated?.blobObject?.blobId
    ?? result.alreadyCertified?.blobId;

  if (!blobId) throw new Error('No blobId in Walrus response');

  return blobId;
};

// Fetch and decrypt vector (for matching flow)
export const fetchVector = async (
  blobId: string,
  userAddress: string
): Promise<number[]> => {
  const response = await fetch(`${AGGREGATOR}/v1/${blobId}`);
  if (!response.ok) throw new Error('Walrus fetch failed');

  const encrypted = await response.text();
  const key = userAddress.slice(2, 18);

  // Decrypt
  const decrypted = encrypted.match(/.{2}/g)!
    .map((hex, i) =>
      String.fromCharCode(parseInt(hex, 16) ^ key.charCodeAt(i % key.length))
    ).join('');

  return JSON.parse(decrypted);
};