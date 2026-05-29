import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { readBlockedProfileKeys, writeBlockEntry } from '@/utils/safetyService';
import {
  buildAcceptProposalTx,
  buildRejectProposalTx,
} from '@/utils/suiTransactions';
import {
  fetchZkProof,
  loadZkLoginParams,
  setupZkLoginParams,
} from '@/utils/zkLoginService';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const PACKAGE_ID = process.env.EXPO_PUBLIC_PACKAGE_ID || '';
const TWIN_POOL_ID = process.env.EXPO_PUBLIC_TWIN_POOL_ID || '';
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

const HIDDEN_PROPOSALS_KEY = 'chaptr:hidden-proposals';
const HUMAN_MATCHES_KEY = 'chaptr:human-matches';
const UNLOCKED_PROFILES_KEY = 'chaptr:unlocked-profiles';

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

interface PoolEntry {
  twin_id: string;
  owner: string;
  scout_ref: string;
  joined_at_epoch: string;
}

interface ScoutProfile {
  displayName?: string;
  age?: number;
  location?: string;
  bio?: string;
  previewPhotoBlobId?: string | null;
}

interface IncomingProposal {
  proposalId: string;
  from: string;
  to: string;
  score: number;
  txDigest: string;
  eventSeq: string;
  proposerTwinId: string | null;
  proposerScoutRef: string | null;
  proposerName: string;
  proposerBio: string;
  proposerAge: number;
  proposerLocation: string;
  proposerPhotoUrl: string;
}

const blobUrl = (blobId: string) =>
  `${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`;

const fallbackPhotoUrl = (seed: string) =>
  `https://api.dicebear.com/7.x/personas/png?seed=${encodeURIComponent(seed)}`;

const toPlainString = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value?.id && typeof value.id === 'string') return value.id;
  if (value === null || value === undefined) return '';
  return String(value);
};

const extractMatchIdFromResult = (result: any): string | null => {
  const createdMatch = result.objectChanges?.find(
    (change: any) =>
      change.type === 'created' &&
      typeof change.objectType === 'string' &&
      change.objectType.endsWith('::matchmaker::Match'),
  );

  if (createdMatch?.objectId) return createdMatch.objectId;

  for (const event of result.events ?? []) {
    const parsed = event.parsedJson ?? {};
    const found = [parsed.match_id, parsed.matchId, parsed.id].map(toPlainString).find(Boolean);
    if (found) return found;
  }

  return null;
};

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const confirmBlock = (title: string, message: string) =>
  new Promise<boolean>((resolve) => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      resolve(window.confirm(`${title}\n\n${message}`));
      return;
    }

    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Block', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });

const readStringArray = async (key: string): Promise<string[]> => {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];

  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const writeUniqueString = async (key: string, value: string) => {
  const current = await readStringArray(key);
  const next = Array.from(new Set([...current, value]));
  await AsyncStorage.setItem(key, JSON.stringify(next));
};

const fetchPoolEntries = async (): Promise<PoolEntry[]> => {
  if (!TWIN_POOL_ID) throw new Error('EXPO_PUBLIC_TWIN_POOL_ID is not set');

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
      joined_at_epoch: toPlainString(f.joined_at_epoch),
    };
  });
};

const fetchScoutProfile = async (blobId: string): Promise<ScoutProfile | null> => {
  try {
    const response = await fetch(blobUrl(blobId));
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
};

const queryProposalEvents = async () => {
  if (!PACKAGE_ID) throw new Error('EXPO_PUBLIC_PACKAGE_ID is not set');

  return suiClient.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::matchmaker::ProposalSent` },
    limit: 50,
    order: 'descending',
  });
};

const getJwtForProposalAction = async () => {
  const { nonce } = await setupZkLoginParams();
  const redirectUri = AuthSession.makeRedirectUri();

  const request = new AuthSession.AuthRequest({
    clientId: GOOGLE_CLIENT_ID,
    responseType: AuthSession.ResponseType.IdToken,
    scopes: ['openid', 'email', 'profile'],
    redirectUri,
    extraParams: { nonce, prompt: 'select_account' },
    usePKCE: false,
  });

  const result = await request.promptAsync(discovery);
  if (result.type !== 'success') throw new Error('Google sign-in was cancelled');

  const idToken = result.params.id_token;
  if (!idToken) throw new Error('No id_token returned');

  return idToken;
};

const executeWithZkLogin = async (tx: any) => {
  const jwt = await getJwtForProposalAction();
  const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
  const { zkProof, addressSeed, userAddress } = await fetchZkProof(
    jwt,
    ephemeralKeyPair,
    maxEpoch,
    randomness,
  );

  const expectedOwner = await AsyncStorage.getItem('chaptr:my-owner');

  if (expectedOwner && userAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error("Selected Google account does not match this browser's Chaptr identity.");
  }

  tx.setSender(userAddress);

  const { bytes, signature: userSignature } = await tx.sign({
    client: suiClient,
    signer: ephemeralKeyPair,
  });

  const zkSignature = getZkLoginSignature({
    inputs: { ...(zkProof as any), addressSeed },
    maxEpoch,
    userSignature,
  });

  return suiClient.executeTransactionBlock({
    transactionBlock: bytes,
    signature: zkSignature,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
};

const getInitial = (name: string) => (name ?? '?').charAt(0).toUpperCase();

const scoreColor = (score: number) =>
  score >= 85 ? '#4ade80' : score >= 70 ? '#D94A8C' : '#A299A8';

export default function ProposalsScreen() {
  const [proposals, setProposals] = useState<IncomingProposal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadProposals = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const myOwner = await AsyncStorage.getItem('chaptr:my-owner');

      if (!myOwner) {
        setProposals([]);
        setError('Create your Twin first to receive proposals.');
        return;
      }

      const [eventsResult, poolEntries, hiddenProposalIds, blockedProfileKeys] =
        await Promise.all([
          queryProposalEvents(),
          fetchPoolEntries(),
          readStringArray(HIDDEN_PROPOSALS_KEY),
          readBlockedProfileKeys(),
        ]);

      const blockedKeySet = new Set(blockedProfileKeys.map((key) => key.toLowerCase()));

      const eventRows = eventsResult.data ?? [];
      const incomingEvents = eventRows
        .map((event: any) => {
          const parsed = event.parsedJson ?? {};

          return {
            proposalId: toPlainString(parsed.proposal_id),
            from: toPlainString(parsed.from),
            to: toPlainString(parsed.to),
            score: Number(parsed.score) || 0,
            txDigest: event.id?.txDigest ?? '',
            eventSeq: event.id?.eventSeq ?? '',
          };
        })
        .filter((event) => event.proposalId)
        .filter((event) => sameAddress(event.to, myOwner))
        .filter((event) => !hiddenProposalIds.includes(event.proposalId))
        .filter((event) => !blockedKeySet.has(event.from.toLowerCase()));

      const uniqueByProposal = new Map<string, typeof incomingEvents[number]>();
      incomingEvents.forEach((event) => uniqueByProposal.set(event.proposalId, event));

      const resolved = await Promise.all(
        Array.from(uniqueByProposal.values()).map(async (event) => {
          const proposerEntry = poolEntries.find((entry) => sameAddress(entry.owner, event.from));
          const scout = proposerEntry?.scout_ref
            ? await fetchScoutProfile(proposerEntry.scout_ref)
            : null;

          const proposerName =
            scout?.displayName || `${event.from.slice(0, 6)}...${event.from.slice(-4)}`;

          const proposerPhotoUrl = scout?.previewPhotoBlobId
            ? blobUrl(scout.previewPhotoBlobId)
            : fallbackPhotoUrl(event.from);

          return {
            ...event,
            proposerTwinId: proposerEntry?.twin_id ?? null,
            proposerScoutRef: proposerEntry?.scout_ref ?? null,
            proposerName,
            proposerBio:
              scout?.bio ||
              'They sent a focused proposal. Talk to their Twin before deciding.',
            proposerAge: Number(scout?.age) || 0,
            proposerLocation: scout?.location || '',
            proposerPhotoUrl,
          };
        }),
      );

      setProposals(
        resolved.filter((proposal) => {
          const ownerKey = proposal.from.toLowerCase();
          const twinKey = proposal.proposerTwinId?.toLowerCase() ?? '';

          return !blockedKeySet.has(ownerKey) && (!twinKey || !blockedKeySet.has(twinKey));
        }),
      );
    } catch (err: any) {
      console.error('Failed to load proposals:', err);
      setError(err.message ?? 'Could not load proposals.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadProposals().catch(console.warn);
    }, [loadProposals]),
  );

  const handleTalkToTwin = (proposal: IncomingProposal) => {
    if (!proposal.proposerTwinId || !proposal.proposerScoutRef) {
      Alert.alert('Twin unavailable', 'Could not find this proposer in the Twin Pool.');
      return;
    }

    router.push({
      pathname: '/chat/[id]',
      params: {
        id: proposal.proposerTwinId,
        scoutRef: proposal.proposerScoutRef,
        name: proposal.proposerName,
        owner: proposal.from,
        score: String(proposal.score || 86),
        mode: 'proposal-review',
        proposalId: proposal.proposalId,
      },
    });
  };

  const handleBlock = async (proposal: IncomingProposal) => {
    const confirmed = await confirmBlock(
      'Block this person?',
      'This hides their proposal and trains your Twin to avoid this profile.',
    );

    if (!confirmed) return;

    try {
      setActionId(proposal.proposalId);

      await writeBlockEntry({
        twinId: proposal.proposerTwinId,
        ownerAddress: proposal.from,
        name: proposal.proposerName,
        reason: 'blocked_from_proposal',
        note: `Blocked proposal ${proposal.proposalId}`,
        matchId: null,
      });

      try {
        const tx = buildRejectProposalTx(proposal.proposalId);
        await executeWithZkLogin(tx);
      } catch (error) {
        console.warn('Block saved, but reject transaction failed:', error);
      }

      await writeUniqueString(HIDDEN_PROPOSALS_KEY, proposal.proposalId);

      setProposals((current) =>
        current.filter((item) => item.proposalId !== proposal.proposalId),
      );

      Alert.alert('Blocked', 'You will not see this proposal again.');
    } catch (err: any) {
      console.error('Block failed:', err);
      Alert.alert('Block failed', err.message ?? 'Could not block this proposal.');
    } finally {
      setActionId(null);
    }
  };

  const handleReject = async (proposal: IncomingProposal) => {
    try {
      setActionId(proposal.proposalId);

      const tx = buildRejectProposalTx(proposal.proposalId);
      const result = await executeWithZkLogin(tx);

      await writeUniqueString(HIDDEN_PROPOSALS_KEY, proposal.proposalId);

      Alert.alert(
        'Proposal rejected',
        `Their Twin has been released.\n\nTx: ${result.digest.slice(0, 18)}...`,
      );

      loadProposals().catch(console.warn);
    } catch (err: any) {
      console.error('Reject failed:', err);
      Alert.alert('Reject failed', err.message ?? 'Could not reject proposal.');
    } finally {
      setActionId(null);
    }
  };

  const handleAccept = async (proposal: IncomingProposal) => {
    try {
      setActionId(proposal.proposalId);

      const myTwinId = await AsyncStorage.getItem('chaptr:my-twin-id');
      if (!myTwinId) throw new Error('No local Twin ID found. Create your agent again.');

      const tx = buildAcceptProposalTx(proposal.proposalId, myTwinId);
      const result = await executeWithZkLogin(tx);
      const matchId = extractMatchIdFromResult(result) ?? proposal.proposalId;

      const matchRecord = {
        matchId,
        proposalId: proposal.proposalId,
        participantOwner: proposal.from,
        participantTwinId: proposal.proposerTwinId,
        participantScoutRef: proposal.proposerScoutRef,
        participantName: proposal.proposerName,
        score: proposal.score,
        acceptedDigest: result.digest,
        createdAt: new Date().toISOString(),
      };

      const existingRaw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
      const existing = existingRaw ? JSON.parse(existingRaw) : [];
      const safeExisting = Array.isArray(existing) ? existing : [];

      await Promise.all([
        AsyncStorage.setItem(HUMAN_MATCHES_KEY, JSON.stringify([matchRecord, ...safeExisting])),
        writeUniqueString(HIDDEN_PROPOSALS_KEY, proposal.proposalId),
        proposal.proposerTwinId
          ? writeUniqueString(UNLOCKED_PROFILES_KEY, proposal.proposerTwinId)
          : Promise.resolve(),
      ]);

      setProposals((current) =>
        current.filter((item) => item.proposalId !== proposal.proposalId),
      );

      router.replace({
        pathname: '/human-chat/[id]' as any,
        params: { id: matchId, name: proposal.proposerName },
      });
    } catch (err: any) {
      console.error('Accept failed:', err);
      Alert.alert('Accept failed', err.message ?? 'Could not accept proposal.');
    } finally {
      setActionId(null);
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#D94A8C" size="large" />
          <Text style={styles.loadingText}>Checking proposals...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backText}>{'< Back'}</Text>
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Proposals</Text>

        <TouchableOpacity onPress={loadProposals} style={styles.refreshButton}>
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.pageTitle}>Incoming Proposals</Text>
        <Text style={styles.pageSubtitle}>
          Talk to their Twin before accepting. Human chat opens only after you accept.
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {proposals.length === 0 && !error ? (
          <View style={styles.emptyState}>
            <View style={styles.emptyIcon}>
              <Text style={styles.emptyIconText}>*</Text>
            </View>
            <Text style={styles.emptyTitle}>No proposals yet</Text>
            <Text style={styles.emptyBody}>
              When someone chooses to focus on you, their proposal will appear here.
            </Text>
          </View>
        ) : null}

        {proposals.map((proposal) => {
          const isWorking = actionId === proposal.proposalId;
          const color = scoreColor(proposal.score || 86);

          return (
            <View key={proposal.proposalId} style={styles.card}>
              <LinearGradient
                colors={[
                  'rgba(217,74,140,0.16)',
                  'rgba(122,62,184,0.10)',
                  'rgba(13,11,16,0.98)',
                ]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.cardGradient}
              >
                <View style={styles.cardTop}>
                  <View style={styles.avatarWrap}>
                    <Image source={{ uri: proposal.proposerPhotoUrl }} style={styles.avatarImage} />
                    <View style={styles.avatarInitialRing}>
                      <Text style={styles.avatarInitialText}>
                        {getInitial(proposal.proposerName)}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.profileInfo}>
                    <Text style={styles.proposerName}>
                      {proposal.proposerName}
                      {proposal.proposerAge > 0 ? `, ${proposal.proposerAge}` : ''}
                    </Text>

                    {proposal.proposerLocation ? (
                      <Text style={styles.proposerLocation}>{proposal.proposerLocation}</Text>
                    ) : null}

                    <Text style={styles.proposerBio} numberOfLines={3}>
                      {proposal.proposerBio}
                    </Text>
                  </View>

                  <View style={[styles.scorePill, { borderColor: color + '55' }]}>
                    <Text style={[styles.scoreValue, { color }]}>
                      {proposal.score || 86}%
                    </Text>
                    <Text style={styles.scoreLabel}>signal</Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <View style={styles.intentBox}>
                  <View style={styles.intentTopRow}>
                    <Text style={styles.intentKicker}>FOCUS PROPOSAL</Text>
                    <View style={styles.intentBadge}>
                      <View style={styles.intentDot} />
                      <Text style={styles.intentBadgeText}>Awaiting response</Text>
                    </View>
                  </View>
                  <Text style={styles.intentText}>
                    Their Twin is committed to this proposal. Interview the Twin first, then decide.
                  </Text>
                </View>

                <Text style={styles.refText}>
                  Proposal: {proposal.proposalId.slice(0, 18)}...
                </Text>

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.rejectButton}
                    onPress={() => handleReject(proposal)}
                    disabled={isWorking}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.rejectText}>{isWorking ? '...' : 'Reject'}</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.blockButton}
                    onPress={() => handleBlock(proposal)}
                    disabled={isWorking}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.blockText}>{isWorking ? '...' : 'Block'}</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.talkButton}
                    onPress={() => handleTalkToTwin(proposal)}
                    disabled={isWorking}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.talkText}>Talk to Twin</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.acceptButtonWrap}
                    onPress={() => handleAccept(proposal)}
                    disabled={isWorking}
                    activeOpacity={0.88}
                  >
                    <LinearGradient
                      colors={isWorking ? ['#2A2432', '#2A2432'] : ['#D94A8C', '#7A3EB8']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0 }}
                      style={styles.acceptGradient}
                    >
                      <Text style={styles.acceptText}>{isWorking ? 'Signing...' : 'Accept'}</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              </LinearGradient>
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14 },
  loadingText: { color: '#A299A8', fontSize: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1826',
  },
  backButton: { width: 72 },
  backText: { color: '#D94A8C', fontSize: 15, fontWeight: '700' },
  headerTitle: {
    flex: 1,
    color: '#FDFBF7',
    fontSize: 19,
    fontWeight: '900',
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  refreshButton: { width: 72, alignItems: 'flex-end' },
  refreshText: { color: '#A299A8', fontSize: 13, fontWeight: '700' },
  content: {
    maxWidth: 620,
    alignSelf: 'center',
    width: '100%',
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 48,
  },
  pageTitle: { color: '#FDFBF7', fontSize: 26, fontWeight: '900' },
  pageSubtitle: {
    color: '#A299A8',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
    marginBottom: 22,
  },
  errorText: { color: '#D94A8C', fontSize: 13, marginBottom: 12 },
  emptyState: { alignItems: 'center', marginTop: 80, paddingHorizontal: 24 },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.35)',
    backgroundColor: 'rgba(217,74,140,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  emptyIconText: { color: '#D94A8C', fontSize: 22 },
  emptyTitle: { color: '#FDFBF7', fontSize: 20, fontWeight: '900', textAlign: 'center' },
  emptyBody: {
    color: '#A299A8',
    fontSize: 14,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
  card: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.38)',
    overflow: 'hidden',
    marginBottom: 16,
    shadowColor: '#D94A8C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.14,
    shadowRadius: 14,
    elevation: 6,
  },
  cardGradient: { padding: 16 },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  avatarWrap: {
    width: 68,
    height: 82,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#2A2432',
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.35)',
    position: 'relative',
  },
  avatarImage: { width: '100%', height: '100%', position: 'absolute' },
  avatarInitialRing: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(217,74,140,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitialText: { color: '#FDFBF7', fontSize: 26, fontWeight: '900', opacity: 0.6 },
  profileInfo: { flex: 1, minWidth: 0 },
  proposerName: { color: '#FDFBF7', fontSize: 19, fontWeight: '900' },
  proposerLocation: { color: '#7A7085', fontSize: 12, marginTop: 4 },
  proposerBio: { color: '#C8C0CE', fontSize: 13, lineHeight: 18, marginTop: 6 },
  scorePill: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  scoreValue: { fontSize: 15, fontWeight: '900' },
  scoreLabel: { color: '#A299A8', fontSize: 10, marginTop: 1 },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.05)',
    marginVertical: 14,
  },
  intentBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.28)',
    backgroundColor: 'rgba(217,74,140,0.06)',
    padding: 13,
    marginBottom: 10,
  },
  intentTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  intentKicker: { color: '#D94A8C', fontSize: 10, fontWeight: '900', letterSpacing: 2 },
  intentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.35)',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: 'rgba(217,74,140,0.08)',
  },
  intentDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#D94A8C' },
  intentBadgeText: { color: '#f9a8d4', fontSize: 10, fontWeight: '700' },
  intentText: { color: '#C8C0CE', fontSize: 13, lineHeight: 18 },
  refText: {
    color: '#4A4356',
    fontSize: 11,
    marginBottom: 14,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  actions: { gap: 9 },
  rejectButton: {
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.4)',
    backgroundColor: 'rgba(248,113,113,0.06)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  rejectText: { color: '#fca5a5', fontSize: 14, fontWeight: '800' },
  blockButton: {
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.58)',
    backgroundColor: 'rgba(127,29,29,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  blockText: { color: '#fecaca', fontSize: 14, fontWeight: '900' },
  talkButton: {
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#302840',
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  talkText: { color: '#D8D0DD', fontSize: 14, fontWeight: '800' },
  acceptButtonWrap: {
    height: 50,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#D94A8C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 5,
  },
  acceptGradient: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  acceptText: { color: '#FFF', fontSize: 15, fontWeight: '900' },
});