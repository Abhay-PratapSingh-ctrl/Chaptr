import { Transaction } from '@mysten/sui/transactions';

// This is the Package ID of your freshly published chaptr smart contract!
const PACKAGE_ID = '0x39d941cfafec6d528c50300fc71d60af3bc9c0d890596bbe998644382357c8c9';

/**
 * Creates the transaction block to mint a new Digital Twin agent.
 * @param vectorRef The personality vector (JSON string or IPFS hash)
 * @returns The un-signed Transaction object
 */
export const buildMintAgentTx = (vectorRef: string) => {
    // Note: The new @mysten/sui SDK uses `Transaction` instead of `TransactionBlock`
    const tx = new Transaction();
    
    // Call the `mint_agent` entry function in the `agent` module
    tx.moveCall({
        target: `${PACKAGE_ID}::agent::mint_agent`,
        arguments: [
            tx.pure.string(vectorRef)
        ],
    });

    // In a full zkLogin implementation, this `tx` object would be signed 
    // by the user's Ephemeral Key and sent to the Sui Network.
    return tx;
};
