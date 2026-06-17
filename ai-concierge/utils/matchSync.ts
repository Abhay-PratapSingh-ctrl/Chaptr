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
import { emitEvent } from './telemetry';

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
 * getMatchedOwners
 *
 * Returns the set of ALL owner addresses that are currently in an active match,
 * regardless of which side they're on. This is a global view — not scoped to a
 * single user — so the Morning Briefing can filter out candidates who are
 * matched with *anyone*, not just the current user.
 *
 * Used to prevent:
 * - Proposing to someone already matched (candidate filter)
 * - Running A2A when the current user is already matched (self-check)
 */
export const getMatchedOwners = async (): Promise<Set<string>> => {
  const [matchFormedEvents, endedIds] = await Promise.all([
    queryMatchFormedEvents(),
    queryEndedMatchIds(),
  ]);

  const matched = new Set<string>();

  for (const event of matchFormedEvents) {
    const parsed = (event.parsedJson as Record<string, any>) ?? {};
    const matchId = toPlainString(parsed.match_id ?? parsed.matchId);

    // Skip ended matches — those owners are available again
    if (matchId && endedIds.has(matchId.toLowerCase())) continue;

    const a = toPlainString(parsed.participant_a ?? parsed.owner_a ?? parsed.from);
    const b = toPlainString(parsed.participant_b ?? parsed.owner_b ?? parsed.to);
    if (a) matched.add(a.toLowerCase());
    if (b) matched.add(b.toLowerCase());
  }

  return matched;
};

/**
 * Returns all PENDING proposals where myOwner is the target.
 */
const queryPendingIncomingProposals = async (myOwner: string) => {
  if (!PACKAGE_ID) return [];

  try {
    const result = await suiClient.queryEvents({
      query: {
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

        const otherOwner = sameAddress(participantA, myOwner)
          ? participantB
          : participantA;

        const score = Number(parsed.score ?? parsed.similarity_score) || 0;
        const txDigest = event.id?.txDigest ?? '';
        const timestampMs = event.timestampMs ?? null;

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

    const localMatches = await readLocalMatches();
    const merged = mergeMatches(localMatches, chainMatches);

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
 * 1. Checks if the user is already in an active match (Twin locked → bail)
 * 2. Queries ProposalSent events targeting myOwner
 * 3. Filters out proposals from already-matched owners (stale proposals)
 * 4. Deduplicates by proposer (handles double-propose edge case)
 * 5. Verifies proposal object still EXISTS on-chain (skips deleted ones)
 * 6. Fetches the user's on-chain Mandate to read may_propose + min_score_to_propose
 * 7. Accepts the FIRST qualifying proposal, then stops (Twin is consumed)
 *
 * JWT sharing: accepts an optional existingJwt param. When Morning Briefing's
 * Phase 4 already obtained a JWT (for auto-propose), it passes it here so
 * processAutoAccepts reuses it — no second Google popup, no browser block.
 * Falls back to getJwtForTransaction() only if no JWT was provided (e.g. when
 * there were no outbound proposals in Phase 4).
 *
 * Call site: fire-and-forget from loadSavedState() in morning-briefing.
 */
export const processAutoAccepts = async (
  myOwner: string,
  existingJwt?: string,
): Promise<{ accepted: boolean; matchOwner?: string }> => {
  // ── Step 1: Global match check ─────────────────────────────────────────────
  // getMatchedOwners() returns ALL owners currently in ANY active match.
  // If I'm in the set, my Twin is locked inside a Match object and
  // accept_proposal (which takes Twin by value) will always fail.
  const matchedOwners = await getMatchedOwners().catch((err) => {
    console.warn('[Auto-Accept] getMatchedOwners failed:', err);
    return new Set<string>();
  });

  if (matchedOwners.has(myOwner.toLowerCase())) {
    console.log('[Auto-Accept] Skipping — I am already in an active match (Twin locked)');

    // ── TELEMETRY: mandate blocked (in active match) ──────────────────
    emitEvent('mandate_check', {
      context: 'auto_accept',
      allowed: false,
      reason: 'already_in_active_match',
    }, myOwner, `mandate:auto_accept:${myOwner.slice(0, 8)}`);

    return { accepted: false };
  }

  // ── Step 2: Query incoming proposals ───────────────────────────────────────
  const incomingProposals = await queryPendingIncomingProposals(myOwner);
  if (incomingProposals.length === 0) {
    console.log('[Auto-Accept] No incoming proposals found');
    return { accepted: false };
  }

  console.log(`[Auto-Accept] Found ${incomingProposals.length} ProposalSent event(s) targeting me`);

  // ── Step 3: Read mandate from chain ────────────────────────────────────────
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
      return { accepted: false };
    }
  }

  // Opt-in gate
  if (mandateFields?.may_propose !== true) {
    console.log('[Auto-Accept] Mandate may_propose is not true — skipping');

    // ── TELEMETRY: mandate blocked (not allowed) ─────────────────────
    emitEvent('mandate_check', {
      context: 'auto_accept',
      allowed: false,
      reason: 'may_propose_not_true',
    }, myOwner, `mandate:auto_accept:${myOwner.slice(0, 8)}`);

    return { accepted: false };
  }

  // ── TELEMETRY: mandate allowed ────────────────────────────────────
  emitEvent('mandate_check', {
    context: 'auto_accept',
    allowed: true,
    minScoreToAccept: Number(mandateFields?.min_score_to_propose ?? 80),
    incomingProposals: incomingProposals.length,
  }, myOwner, `mandate:auto_accept:${myOwner.slice(0, 8)}`);

  const minScoreToAccept = Number(mandateFields?.min_score_to_propose ?? 80);

  const myTwinId = await AsyncStorage.getItem('chaptr:my-twin-id');
  if (!myTwinId) {
    console.warn('[Auto-Accept] No local twin ID — cannot build accept tx');
    return { accepted: false };
  }

  // Verify my Twin is still available (not wrapped inside a Match or Proposal)
  try {
    const twinObj = await suiClient.getObject({ id: myTwinId, options: { showType: true } });
    if (twinObj.error || !twinObj.data) {
      console.warn(`[Auto-Accept] My Twin ${myTwinId.slice(0, 12)}… is unavailable (consumed/wrapped). Cannot accept.`);
      return { accepted: false };
    }
  } catch {
    console.warn('[Auto-Accept] Failed to verify Twin status — skipping');
    return { accepted: false };
  }

  // ── Step 4: Filter proposals ───────────────────────────────────────────────
  // 4a. Score threshold
  // 4b. Guard key (already processed in a prior session)
  // 4c. Proposer not already matched (their proposal is stale/un-acceptable)
  // 4d. Deduplicate by proposer (keep only one per proposer)
  // 4e. Verify proposal object still exists on-chain (skip deleted ones)
  const scorePassed = incomingProposals.filter((p) => {
    if (p.compatibility_score < minScoreToAccept) {
      console.log(`[Auto-Accept] Skipping ${p.id.slice(0, 12)}… — score ${p.compatibility_score} < ${minScoreToAccept}`);
      return false;
    }
    return true;
  });

  const matchFiltered = scorePassed.filter((p) => {
    if (matchedOwners.has(p.proposer.toLowerCase())) {
      console.log(`[Auto-Accept] Skipping ${p.id.slice(0, 12)}… — proposer ${p.proposer.slice(0, 10)} already in a match`);
      return false;
    }
    return true;
  });

  const guardFiltered = await Promise.all(
    matchFiltered.map(async (p) => {
      const guardKey = `chaptr:auto-accepted:${p.id.toLowerCase()}`;
      const alreadyDone = await AsyncStorage.getItem(guardKey);
      if (alreadyDone) {
        console.log(`[Auto-Accept] Skipping ${p.id.slice(0, 12)}… — guard key exists (${alreadyDone})`);
        return null;
      }
      return p;
    }),
  );

  const afterGuard = guardFiltered.filter(Boolean) as typeof incomingProposals;

  // Deduplicate by proposer — if Abhay proposed twice, only accept one
  const uniqueByProposer = new Map<string, typeof afterGuard[0]>();
  for (const p of afterGuard) {
    const key = p.proposer.toLowerCase();
    if (!uniqueByProposer.has(key)) {
      uniqueByProposer.set(key, p);
    } else {
      console.log(`[Auto-Accept] Dedup — skipping duplicate proposal ${p.id.slice(0, 12)}… from ${p.proposer.slice(0, 10)}`);
    }
  }

  const candidates = Array.from(uniqueByProposer.values());

  // Verify each proposal object still exists on-chain (skip deleted/consumed ones)
  const liveProposals = await Promise.all(
    candidates.map(async (p) => {
      try {
        const obj = await suiClient.getObject({ id: p.id, options: { showType: true } });
        if (obj.error || !obj.data) {
          console.log(`[Auto-Accept] Skipping ${p.id.slice(0, 12)}… — object no longer exists on-chain (deleted/consumed)`);
          // Set guard key so we don't re-query this dead proposal every load
          await AsyncStorage.setItem(
            `chaptr:auto-accepted:${p.id.toLowerCase()}`,
            `deleted:${new Date().toISOString()}`,
          );
          return null;
        }
        return p;
      } catch {
        console.log(`[Auto-Accept] Skipping ${p.id.slice(0, 12)}… — failed to verify on-chain status`);
        return null;
      }
    }),
  );

  const toProcess = liveProposals.filter(Boolean) as typeof incomingProposals;

  if (toProcess.length === 0) {
    console.log('[Auto-Accept] No actionable proposals after filtering');
    return { accepted: false };
  }

  console.log(`[Auto-Accept] ${toProcess.length} live proposal(s) to process`);

  // ── Step 5: JWT acquisition ────────────────────────────────────────────────
  // Reuse the JWT from Phase 4 if available — avoids a second Google popup.
  // Falls back to getJwtForTransaction() if no JWT was passed in.
  let jwt: string;
  try {
    jwt = existingJwt ?? await getJwtForTransaction();
  } catch (jwtErr) {
    console.warn('[Auto-Accept] JWT auth failed (non-blocking):', jwtErr);
    return { accepted: false };
  }

  // ── Step 6: Accept ONE proposal, then stop ─────────────────────────────────
  // accept_proposal takes DigitalTwin by value — after accepting one proposal,
  // the Twin is locked inside the new Match object. Attempting a second accept
  // would fail with "object not found" because the Twin is no longer in the wallet.
  for (const proposal of toProcess) {
    const guardKey = `chaptr:auto-accepted:${proposal.id.toLowerCase()}`;

    try {
      // ── TELEMETRY: accept fired ─────────────────────────────────────
      emitEvent('accept_fired', {
        proposalId: proposal.id.slice(0, 12),
        proposer: proposal.proposer.slice(0, 10),
        score: proposal.compatibility_score,
        myTwinId: myTwinId.slice(0, 12),
      }, myOwner, `accept_fired:${proposal.id.slice(0, 16)}`);

      const acceptTx = buildAcceptProposalTx(proposal.id, myTwinId);
      await executeZkLoginTransaction(acceptTx, myOwner, jwt);

      // Guard key set AFTER success — allows retry on transient failures
      await AsyncStorage.setItem(guardKey, `accepted:${new Date().toISOString()}`);
      console.log(`[Auto-Accept] ✅ Accepted proposal from ${proposal.proposer.slice(0, 8)} — match formed!`);

      // ── TELEMETRY: accept succeeded ───────────────────────────────────
      emitEvent('accept_result', {
        proposalId: proposal.id.slice(0, 12),
        proposer: proposal.proposer.slice(0, 10),
        score: proposal.compatibility_score,
        result: 'success',
      }, myOwner, `accept_result:${proposal.id.slice(0, 16)}`);

      // ── TELEMETRY: match formed (optimistic) ────────────────────────
      emitEvent('match_formed', {
        proposalId: proposal.id.slice(0, 12),
        proposer: proposal.proposer.slice(0, 10),
        accepter: myOwner.slice(0, 10),
        score: proposal.compatibility_score,
      }, myOwner, `match_formed:${proposal.id.slice(0, 16)}`);

      // Stop here and notify caller — Twin is now locked
      return { accepted: true, matchOwner: proposal.proposer };
    } catch (txErr: any) {
      const errMsg = txErr?.message ?? String(txErr);
      console.warn(`[Auto-Accept] ❌ Failed to accept proposal ${proposal.id.slice(0, 18)}:`, errMsg);

      // Mark as failed to prevent infinite retries on permanently broken proposals
      // (e.g., proposal already rejected/withdrawn on-chain but events still exist)
      await AsyncStorage.setItem(guardKey, `failed:${new Date().toISOString()}`);

      // ── TELEMETRY: accept failed ────────────────────────────────────
      emitEvent('accept_result', {
        proposalId: proposal.id.slice(0, 12),
        proposer: proposal.proposer.slice(0, 10),
        score: proposal.compatibility_score,
        result: 'failed',
        error: errMsg.slice(0, 100),
      }, myOwner, `accept_result:${proposal.id.slice(0, 16)}`);
    }
  }

  return { accepted: false };
};

// ─── Merge logic ──────────────────────────────────────────────────────────────

const mergeMatches = (
  local: SyncedHumanMatch[],
  chain: SyncedHumanMatch[],
): SyncedHumanMatch[] => {
  const result = new Map<string, SyncedHumanMatch>();

  for (const m of chain) {
    result.set(m.matchId.toLowerCase(), m);
  }

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