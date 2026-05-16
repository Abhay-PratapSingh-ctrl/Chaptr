// utils/suiTransactions.ts
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';

const client = new SuiClient({ url: getFullnodeUrl('testnet') });

const PACKAGE_ID = 'YOUR_DEPLOYED_PACKAGE_ID'; // after sui client publish

export const mintDigitalTwin = async (
  blobId: string,
  signAndExecute: Function  // from @mysten/dapp-kit or your wallet adapter
) => {
  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::agent::mint_agent`,
    arguments: [tx.pure.string(blobId)],
  });

  return await signAndExecute({ transaction: tx });
};

export const proposeSuiMatch = async (
  targetAddress: string,
  blobId: string,
  score: number,
  message: string,
  signAndExecute: Function
) => {
  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::matchmaker::propose_match`,
    arguments: [
      tx.pure.address(targetAddress),
      tx.pure.string(blobId),
      tx.pure.u8(score),
      tx.pure.string(message),
    ],
  });

  return await signAndExecute({ transaction: tx });
};