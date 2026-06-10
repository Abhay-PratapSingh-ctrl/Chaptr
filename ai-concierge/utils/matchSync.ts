/**
 * matchSync.ts
 *
 * Discovers active human matches directly from Sui chain events.
 * Works for BOTH sides of a match (proposer and receiver) in ANY browser,
 * even if local storage is empty or stale.
 *
 * Also powers the Agentic Web target autonomy by scanning for pending
 * incoming proposals and auto-accepting them if they meet the user's Mandate.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { buildAcceptProposalTx } from './suiTransactions';
import { getJwtForTransaction, executeZkLoginTransaction } from './zkLoginService';

const PACKAGE_ID = process.env.EXPO_PUBLIC_PACKAGE_ID || '';
const TWIN_POOL_ID = process.env.EXPO_PUBLIC_TWIN_POOL_ID || '';
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

const HUMAN_MATCHES_KEY = 'chaptr:human-matches';

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncedHumanMatch {
  matchId: string;
  proposalId: string;
  participantOwner: string;
  participantTwinId: string | null;
  participantScoutRef: string | null;
  participantName: string;
  score: number;
  acceptedDigest: string;
  createdAt: string;
}

interface PoolEntry {
  twin_id: string;
  owner: string;
  scout_ref: string;
}

interface ScoutProfile {
  displayName?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toPlainString = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value?.id && typeof value.id === 'string') return value.id;
  if (value === null || value === undefined) return '';
  return String(value);
};

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const blobUrl = (blobId: string) =>
  `${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`;

// ─── Pool enrichment ──────────────────────────────────────────────────────────

const fetchPoolEntries = async (): Promise<PoolEntry[]> => {
  if (!TWIN_POOL_ID) return [];

  try {
    const obj = await suiClient.getObject({
      id: TWIN_POOL_ID,
      options: { showContent: true },
    });

    const fields = (obj.data?.content as any)?.fields;
    const raw: any[] = fields?.entries ?? [];

    return raw.map((entry) => {
      const f = entry.fields ?? entry;
      return {
        twin_id: toPlainString(f.twin_id),
        owner: toPlainString(f.owner),
        scout_ref: toPlainString(f.scout_ref),
      };
    });
  } catch {
    return [];
  }
};

const fetchDisplayName = async (scoutRef: string): Promise<string | null> => {
  try {
    const res = await fetch(blobUrl(scoutRef));
    if (!res.ok) return null;
    const profile: ScoutProfile = await res.json();
    return profile.displayName ?? null;
  } catch {
    return null;
  }
};

// ─── Event queries ────────────────────────────────────────────────────────────

/**
 * Returns all MatchFormed events from the matchmaker module.
 */
const queryMatchFormedEvents = async () => {
  if (!PACKAGE_ID) return [];

  try {
    const result = await suiClient.queryEvents({
      query: {
        MoveEventType: `${PACKAGE_ID}::matchmaker::MatchFormed`,
      },
      limit: 100,
      order: 'descending',
    });

    return result.data ?? [];
  } catch (err) {
    console.warn('[matchSync] MatchFormed query failed:', err);
    return [];
  }
};

/**
 * Returns the set of matchIds that have been ended on-chain.
 */
const queryEndedMatchIds = async (): Promise<Set<string>> => {
  if (!PACKAGE_ID) return new Set();

  try {
    const result = await suiClient.queryEvents({
      query: {
        MoveEventType: `${PACKAGE_ID}::matchmaker::MatchEnded`,
      },
      limit: 100,
      order: 'descending',
    });

    const ended = new Set<string>();

    for (const event of result.data ?? []) {
      const parsed = (event.parsedJson as Record<string, any>) ?? {};
      const matchId = toPlainString(parsed.match_id ?? parsed.matchId);
      if (matchId) ended.add(matchId.toLowerCase());
    }

    return ended;
  } catch (err) {
    console.warn('[matchSync] MatchEnded query failed:', err);
    return new Set();
  }
};

/**
 * Returns all PENDING proposals where myOwner is the target.
 *
 * IMPORTANT: The event name here must match what matchmaker.move actually
 * emits. If your contract emits `MatchProposal` or `ProposalCreated` instead
 * of `MatchProposed`, update the MoveEventType string below.
 *
 * To verify: run `sui client events --package <PACKAGE_ID>` on testnet
 * and check the event type names in the output.
 */
const queryPendingIncomingProposals = async (myOwner: string) => {
  if (!PACKAGE_ID) return [];

  try {
    const result = await suiClient.queryEvents({
      query: {
        // ⚠️  Verify this matches your matchmaker.move event name exactly.
        MoveEventType: `${PACKAGE_ID}::matchmaker::ProposalSent`,
      },
      limit: 50,
      order: 'descending',
    });

    const pendingProposals = [];

    for (const event of result.data ?? []) {
      const parsed = (event.parsedJson as any) ?? {};
      const target = toPlainString(parsed.to);

      if (sameAddress(target, myOwner)) {
        const proposalId = toPlainString(parsed.proposal_id);

        if (!proposalId) continue;

        pendingProposals.push({
          id: proposalId,
          proposer: toPlainString(parsed.from),
          target,
          compatibility_score: Number(parsed.score) || 0,
        });
      }
    }

    return pendingProposals;
  } catch (err) {
    console.warn('[matchSync] Pending proposals query failed:', err);
    return [];
  }
};

// ─── Main sync functions ──────────────────────────────────────────────────────

/**
 * syncHumanMatchesFromSui
 *
 * Call this on every app focus. It:
 * - Reads MatchFormed + MatchEnded events from Sui
 * - Filters to only matches involving myOwner
 * - Enriches with Twin Pool data (name, scoutRef, twinId)
 * - Merges into local chaptr:human-matches
 * - Returns the final merged match list
 *
 * Safe to call multiple times — it merges, never wipes existing data.
 */
export const syncHumanMatchesFromSui = async (
  myOwner: string,
): Promise<SyncedHumanMatch[]> => {
  if (!myOwner || !PACKAGE_ID) {
    return readLocalMatches();
  }

  try {
    const [matchFormedEvents, endedIds, poolEntries] = await Promise.all([
      queryMatchFormedEvents(),
      queryEndedMatchIds(),
      fetchPoolEntries(),
    ]);

    // Filter to matches involving me, exclude ended ones
    const myEvents = matchFormedEvents.filter((event: any) => {
      const parsed = event.parsedJson ?? {};
      const matchId = toPlainString(parsed.match_id ?? parsed.matchId);
      if (!matchId) return false;
      if (endedIds.has(matchId.toLowerCase())) return false;

      const a = toPlainString(
        parsed.participant_a ?? parsed.owner_a ?? parsed.from,
      );
      const b = toPlainString(
        parsed.participant_b ?? parsed.owner_b ?? parsed.to,
      );

      return sameAddress(a, myOwner) || sameAddress(b, myOwner);
    });

    // Build match records from events
    const chainMatches: SyncedHumanMatch[] = await Promise.all(
      myEvents.map(async (event: any) => {
        const parsed = event.parsedJson ?? {};

        const matchId = toPlainString(
          parsed.match_id ?? parsed.matchId ?? parsed.id,
        );
        const participantA = toPlainString(
          parsed.participant_a ?? parsed.owner_a ?? parsed.from,
        );
        const participantB = toPlainString(
          parsed.participant_b ?? parsed.owner_b ?? parsed.to,
        );

        // The "other" person is whoever is not me
        const otherOwner = sameAddress(participantA, myOwner)
          ? participantB
          : participantA;

        const score = Number(parsed.score ?? parsed.similarity_score) || 0;
        const txDigest = event.id?.txDigest ?? '';
        const timestampMs = event.timestampMs ?? null;

        // Enrich from pool
        const poolEntry = poolEntries.find((e) =>
          sameAddress(e.owner, otherOwner),
        );
        let participantName = `${otherOwner.slice(0, 6)}...${otherOwner.slice(-4)}`;

        if (poolEntry?.scout_ref) {
          const displayName = await fetchDisplayName(
            poolEntry.scout_ref,
          ).catch(() => null);
          if (displayName) participantName = displayName;
        }

        return {
          matchId,
          proposalId: matchId,
          participantOwner: otherOwner,
          participantTwinId: poolEntry?.twin_id ?? null,
          participantScoutRef: poolEntry?.scout_ref ?? null,
          participantName,
          score,
          acceptedDigest: txDigest,
          createdAt: timestampMs
            ? new Date(Number(timestampMs)).toISOString()
            : new Date().toISOString(),
        };
      }),
    );

    // Merge with existing local matches
    const localMatches = await readLocalMatches();
    const merged = mergeMatches(localMatches, chainMatches);

    // Remove any locally stored matches that are now ended on-chain
    const live = merged.filter(
      (m) => !endedIds.has((m.matchId ?? '').toLowerCase()),
    );

    await AsyncStorage.setItem(HUMAN_MATCHES_KEY, JSON.stringify(live));

    return live;
  } catch (err) {
    console.warn(
      '[matchSync] syncHumanMatchesFromSui failed, returning local:',
      err,
    );
    return readLocalMatches();
  }
};

/**
 * processAutoAccepts
 *
 * Agentic Web target autonomy — closes the loop on the receiving side.
 *
 * How it works:
 * 1. Queries MatchProposed events targeting myOwner
 * 2. Fetches the user's on-chain Mandate to read may_propose + min_score_to_propose
 * 3. For each proposal whose score meets the threshold, fires accept_proposal
 *    using a single Google popup (one JWT covers all proposals in the loop)
 * 4. Saves a guard key so each proposal is only accepted once, even if the
 *    screen re-mounts before the chain confirms
 *
 * Gate: reuses may_propose === true as the opt-in signal for both directions.
 * If you add a dedicated may_accept field to mandate.move, swap it in here.
 *
 * Call site: fire-and-forget from loadSavedState() in morning-briefing.tsx.
 * It's non-blocking — failures are warned but never surface to the user.
 */
export const processAutoAccepts = async (myOwner: string): Promise<void> => {
  const incomingProposals = await queryPendingIncomingProposals(myOwner);
  if (incomingProposals.length === 0) return;

  // Read mandate
  const mandateIdStored = await AsyncStorage.getItem('chaptr:mandate-id');
  let mandateFields: any = null;

  if (mandateIdStored) {
    try {
      const mandateObj = await suiClient.getObject({
        id: mandateIdStored,
        options: { showContent: true },
      });
      mandateFields = (mandateObj.data?.content as any)?.fields ?? null;
    } catch (err) {
      console.warn('[Auto-Accept] Failed to fetch mandate:', err);
      return;
    }
  }

  // Opt-in gate: user must have enabled autonomous behaviour on their Mandate.
  // We reuse may_propose as the "I want my Twin to act autonomously" flag for
  // both outbound and inbound until a dedicated may_accept field is added.
  if (mandateFields?.may_propose !== true) return;

  const minScoreToAccept = Number(
    mandateFields?.min_score_to_propose ?? 80,
  );

  // Read myTwinId — needed by accept_proposal (matchmaker.move requires it)
  const myTwinId = await AsyncStorage.getItem('chaptr:my-twin-id');
  if (!myTwinId) {
    console.warn('[Auto-Accept] No local twin ID — cannot build accept tx');
    return;
  }

  // Filter to proposals that clear the score bar AND haven't been accepted yet
  const actionable = await Promise.all(
    incomingProposals
      .filter((p) => p.compatibility_score >= minScoreToAccept)
      .map(async (p) => {
        const guardKey = `chaptr:auto-accepted:${p.id.toLowerCase()}`;
        const alreadyDone = await AsyncStorage.getItem(guardKey);
        return alreadyDone ? null : p;
      }),
  );

  const toProcess = actionable.filter(Boolean) as typeof incomingProposals;
  if (toProcess.length === 0) return;

  // One Google popup covers all proposals — reuse the JWT across the loop
  let jwt: string;
  try {
    jwt = await getJwtForTransaction();
  } catch (jwtErr) {
    console.warn('[Auto-Accept] JWT auth failed (non-blocking):', jwtErr);
    return;
  }

  for (const proposal of toProcess) {
    console.log(
      `[Auto-Accept] Twin evaluating proposal ${proposal.id.slice(0, 8)}… ` +
      `Score ${proposal.compatibility_score}% ≥ threshold ${minScoreToAccept}%`,
    );

    try {
      // buildAcceptProposalTx requires both the proposalId and myTwinId
      const acceptTx = buildAcceptProposalTx(proposal.id, myTwinId);
      await executeZkLoginTransaction(acceptTx, myOwner, jwt);

      // Save guard key immediately after success so we never double-accept
      await AsyncStorage.setItem(
        `chaptr:auto-accepted:${proposal.id.toLowerCase()}`,
        new Date().toISOString(),
      );

      console.log(
        `[Auto-Accept] Autonomously accepted proposal from ${proposal.proposer.slice(0, 8)}!`,
      );
    } catch (txErr) {
      // Non-blocking — log and continue to next proposal
      console.warn(
        `[Auto-Accept] Failed to accept proposal ${proposal.id}:`,
        txErr,
      );
    }
  }
};

// ─── Merge logic ──────────────────────────────────────────────────────────────

/**
 * Merges local matches with chain-discovered matches.
 *
 * Rules:
 * - Chain match wins on matchId (authoritative)
 * - Local match wins on proposalId if it has a real proposalId
 * - Local match wins on participantName if it was enriched at accept time
 * - Deduplication by matchId, then by participantOwner
 */
const mergeMatches = (
  local: SyncedHumanMatch[],
  chain: SyncedHumanMatch[],
): SyncedHumanMatch[] => {
  const result = new Map<string, SyncedHumanMatch>();

  // Start with chain matches (authoritative matchId)
  for (const m of chain) {
    result.set(m.matchId.toLowerCase(), m);
  }

  // Overlay local data where it's richer
  for (const localMatch of local) {
    const key = (localMatch.matchId ?? localMatch.proposalId ?? '').toLowerCase();
    const existing = result.get(key);

    if (existing) {
      const betterProposalId =
        localMatch.proposalId && localMatch.proposalId !== localMatch.matchId
          ? localMatch.proposalId
          : existing.proposalId;

      const betterName =
        localMatch.participantName &&
          !localMatch.participantName.includes('...')
          ? localMatch.participantName
          : existing.participantName;

      result.set(key, {
        ...existing,
        proposalId: betterProposalId,
        participantName: betterName,
        participantTwinId:
          localMatch.participantTwinId ?? existing.participantTwinId,
        participantScoutRef:
          localMatch.participantScoutRef ?? existing.participantScoutRef,
      });
    } else {
      // Local match not found on chain yet (indexing delay) — keep it
      result.set(key, localMatch);
    }
  }

  return Array.from(result.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
};

// ─── Local read helper ────────────────────────────────────────────────────────

const readLocalMatches = async (): Promise<SyncedHumanMatch[]> => {
  try {
    const raw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
