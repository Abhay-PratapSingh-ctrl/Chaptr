import { Transaction } from '@mysten/sui/transactions';

const PACKAGE_ID = process.env.EXPO_PUBLIC_PACKAGE_ID || '';

type SignAndExecute = (args: { transaction: Transaction }) => Promise<any>;

const clampProposalScore = (score: number) =>
  Math.max(70, Math.min(99, Math.round(Number.isFinite(score) ? score : 86)));

export const buildMintAgentTx = (vectorRef: string) => {
  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::agent::mint_agent`,
    arguments: [tx.pure.string(vectorRef)],
  });

  return tx;
};

export const mintDigitalTwin = async (
  blobId: string,
  signAndExecute: SignAndExecute,
) => {
  return signAndExecute({
    transaction: buildMintAgentTx(blobId),
  });
};

export const buildProposeMatchTx = (
  myTwinId: string,
  targetAddress: string,
  score: number,
  message: string,
) => {
  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::matchmaker::propose_match`,
    arguments: [
      tx.object(myTwinId),
      tx.pure.address(targetAddress),
      tx.pure.u8(clampProposalScore(score)),
      tx.pure.string(message),
    ],
  });

  return tx;
};

export const buildAcceptProposalTx = (proposalId: string, myTwinId: string) => {
  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::matchmaker::accept_proposal`,
    arguments: [tx.object(proposalId), tx.object(myTwinId)],
  });

  return tx;
};

export const buildRejectProposalTx = (proposalId: string) => {
  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::matchmaker::reject_proposal`,
    arguments: [tx.object(proposalId)],
  });

  return tx;
};

export const buildWithdrawProposalTx = (proposalId: string) => {
  const tx = new Transaction();

  tx.moveCall({
    target: `${PACKAGE_ID}::matchmaker::withdraw_proposal`,
    arguments: [tx.object(proposalId)],
  });

  return tx;
};

export const proposeSuiMatch = async (
  myTwinId: string,
  targetAddress: string,
  score: number,
  message: string,
  signAndExecute: SignAndExecute,
) => {
  return signAndExecute({
    transaction: buildProposeMatchTx(myTwinId, targetAddress, score, message),
  });
};