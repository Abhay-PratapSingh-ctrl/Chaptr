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

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

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
    query: {
      MoveEventType: `${PACKAGE_ID}::matchmaker::ProposalSent`,
    },
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

  if (result.type !== 'success') {
    throw new Error('Google sign-in was cancelled');
  }

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
    throw new Error('Selected Google account does not match this browser’s Chaptr identity.');
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

      const [eventsResult, poolEntries, hiddenProposalIds] = await Promise.all([
        queryProposalEvents(),
        fetchPoolEntries(),
        readStringArray(HIDDEN_PROPOSALS_KEY),
      ]);

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
        .filter((event) => !hiddenProposalIds.includes(event.proposalId));

      const uniqueByProposal = new Map<string, typeof incomingEvents[number]>();
      incomingEvents.forEach((event) => uniqueByProposal.set(event.proposalId, event));

      const resolved = await Promise.all(
        Array.from(uniqueByProposal.values()).map(async (event) => {
          const proposerEntry = poolEntries.find((entry) => sameAddress(entry.owner, event.from));
          const scout = proposerEntry?.scout_ref
            ? await fetchScoutProfile(proposerEntry.scout_ref)
            : null;

          const proposerName = scout?.displayName || `${event.from.slice(0, 6)}...${event.from.slice(-4)}`;
          const proposerPhotoUrl = scout?.previewPhotoBlobId
            ? blobUrl(scout.previewPhotoBlobId)
            : fallbackPhotoUrl(event.from);

          return {
            ...event,
            proposerTwinId: proposerEntry?.twin_id ?? null,
            proposerScoutRef: proposerEntry?.scout_ref ?? null,
            proposerName,
            proposerBio: scout?.bio || 'They sent a focused proposal. Talk to their Twin before deciding.',
            proposerAge: Number(scout?.age) || 0,
            proposerLocation: scout?.location || '',
            proposerPhotoUrl,
          };
        }),
      );

      setProposals(resolved);
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

      const matchRecord = {
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
        params: {
          id: proposal.proposalId,
          name: proposal.proposerName,
        },
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
          <ActivityIndicator color="#D94A8C" />
          <Text style={styles.loadingText}>Checking proposals...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>

        <Text style={styles.logo}>Proposals</Text>

        <TouchableOpacity onPress={loadProposals} style={styles.refreshButton}>
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Incoming Focus Proposals</Text>
        <Text style={styles.subtitle}>
          Talk to their Twin before accepting. Human chat opens only after you accept.
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {proposals.length === 0 && !error ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No proposals yet</Text>
            <Text style={styles.emptyText}>
              When someone chooses to focus on you, their proposal will appear here.
            </Text>
          </View>
        ) : null}

        {proposals.map((proposal) => {
          const isWorking = actionId === proposal.proposalId;

          return (
            <View key={proposal.proposalId} style={styles.card}>
              <LinearGradient
                colors={['rgba(217, 74, 140, 0.2)', 'rgba(18, 15, 24, 0.98)']}
                style={styles.cardGradient}
              >
                <View style={styles.cardTop}>
                  <Image source={{ uri: proposal.proposerPhotoUrl }} style={styles.avatar} />

                  <View style={styles.profileInfo}>
                    <Text style={styles.name}>
                      {proposal.proposerName}
                      {proposal.proposerAge > 0 ? `, ${proposal.proposerAge}` : ''}
                    </Text>

                    {proposal.proposerLocation ? (
                      <Text style={styles.location}>{proposal.proposerLocation}</Text>
                    ) : null}

                    <Text style={styles.bio} numberOfLines={3}>
                      {proposal.proposerBio}
                    </Text>
                  </View>

                  <View style={styles.scorePill}>
                    <Text style={styles.scoreValue}>{proposal.score || 86}%</Text>
                    <Text style={styles.scoreLabel}>signal</Text>
                  </View>
                </View>

                <View style={styles.intentBox}>
                  <Text style={styles.intentTitle}>They chose Focus Mode.</Text>
                  <Text style={styles.intentText}>
                    Their Twin is committed to this proposal. Interview the Twin, then accept or reject.
                  </Text>
                </View>

                <Text style={styles.txText}>
                  Proposal: {proposal.proposalId.slice(0, 14)}...
                </Text>

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => handleReject(proposal)}
                    disabled={isWorking}
                  >
                    <Text style={styles.secondaryText}>
                      {isWorking ? 'Working...' : 'Reject'}
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => handleTalkToTwin(proposal)}
                    disabled={isWorking}
                  >
                    <Text style={styles.secondaryText}>Talk to Twin</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.acceptButton}
                    onPress={() => handleAccept(proposal)}
                    disabled={isWorking}
                  >
                    <LinearGradient
                      colors={isWorking ? ['#2A2432', '#2A2432'] : ['#D94A8C', '#7A3EB8']}
                      style={styles.acceptGradient}
                    >
                      <Text style={styles.acceptText}>
                        {isWorking ? 'Signing...' : 'Accept'}
                      </Text>
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
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { color: '#A299A8', fontSize: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2432',
  },
  backButton: { width: 72 },
  backText: { color: '#D94A8C', fontSize: 15, fontWeight: '700' },
  logo: {
    flex: 1,
    color: '#FDFBF7',
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  refreshButton: { width: 72, alignItems: 'flex-end' },
  refreshText: { color: '#A299A8', fontSize: 13, fontWeight: '700' },
  content: {
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    padding: 18,
    paddingBottom: 40,
  },
  title: { color: '#FDFBF7', fontSize: 26, fontWeight: '900', marginTop: 6 },
  subtitle: { color: '#A299A8', fontSize: 14, lineHeight: 20, marginTop: 8, marginBottom: 18 },
  errorText: { color: '#D94A8C', fontSize: 13, marginBottom: 12 },
  emptyState: { alignItems: 'center', marginTop: 90 },
  emptyTitle: { color: '#FDFBF7', fontSize: 20, fontWeight: '900' },
  emptyText: { color: '#A299A8', fontSize: 14, textAlign: 'center', marginTop: 8, lineHeight: 20 },
  card: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(217, 74, 140, 0.42)',
    overflow: 'hidden',
    marginBottom: 14,
  },
  cardGradient: { padding: 15 },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  avatar: {
    width: 68,
    height: 82,
    borderRadius: 18,
    backgroundColor: '#2A2432',
  },
  profileInfo: { flex: 1, minWidth: 0 },
  name: { color: '#FDFBF7', fontSize: 19, fontWeight: '900' },
  location: { color: '#A299A8', fontSize: 12, marginTop: 4 },
  bio: { color: '#D8D0DD', fontSize: 13, lineHeight: 18, marginTop: 6 },
  scorePill: {
    borderWidth: 1,
    borderColor: '#2A2432',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  scoreValue: { color: '#FDFBF7', fontSize: 15, fontWeight: '900' },
  scoreLabel: { color: '#A299A8', fontSize: 10 },
  intentBox: {
    marginTop: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(217, 74, 140, 0.35)',
    backgroundColor: 'rgba(217, 74, 140, 0.08)',
    padding: 12,
  },
  intentTitle: { color: '#FDFBF7', fontSize: 13, fontWeight: '900', marginBottom: 5 },
  intentText: { color: '#D8D0DD', fontSize: 12, lineHeight: 17 },
  txText: {
    color: '#6D6175',
    fontSize: 11,
    marginTop: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  actions: { marginTop: 14, gap: 9 },
  secondaryButton: {
    height: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#3A3342',
    backgroundColor: 'rgba(255,255,255,0.04)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  secondaryText: { color: '#E0DCE3', fontSize: 14, fontWeight: '800' },
  acceptButton: { height: 46, borderRadius: 15, overflow: 'hidden' },
  acceptGradient: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  acceptText: { color: '#FFF', fontSize: 15, fontWeight: '900' },
});