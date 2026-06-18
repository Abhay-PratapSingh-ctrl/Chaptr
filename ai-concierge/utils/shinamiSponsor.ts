import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { getZkLoginSignature } from '@mysten/sui/zklogin';

import { Platform } from 'react-native';

export const executeSponsoredZkLogin = async (
  tx: any,
  userAddress: string,
  ephemeralKeyPair: any,
  zkProof: any,
  addressSeed: string,
  maxEpoch: number,
  client: any
) => {
  const shinamiKey = process.env.EXPO_PUBLIC_SHINAMI_GAS_KEY;
  if (!shinamiKey) {
    throw new Error('Missing EXPO_PUBLIC_SHINAMI_GAS_KEY');
  }

  tx.setSender(userAddress);
  const txBytesUint8 = await tx.build({ client, onlyTransactionKind: true });
  const txBytesBase64 = toBase64(txBytesUint8);

  // Fix CORS on Vercel Web by proxying through vercel.json rewrite.
  // Mobile devices don't have CORS, so they hit Shinami directly.
  const isWeb = Platform.OS === 'web';
  const isProduction = process.env.NODE_ENV === 'production';
  const sponsorUrl = (isWeb && isProduction)
    ? `/api/shinami-sponsor?auth=${shinamiKey}`
    : `https://api.shinami.com/gas/v1/sui_testnet?auth=${shinamiKey}`;

  const sponsorRes = await fetch(sponsorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'gas_sponsorTransactionBlock',
      params: [txBytesBase64, userAddress, 10000000]
    })
  });

  const sponsorData = await sponsorRes.json();
  if (sponsorData.error) {
    throw new Error('Shinami Sponsor Error: ' + sponsorData.error.message);
  }

  const sponsoredTxBytesBase64 = sponsorData.result.txBytes;
  const sponsorSignature = sponsorData.result.signature;

  const sponsoredTxBytesUint8 = fromBase64(sponsoredTxBytesBase64);
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
