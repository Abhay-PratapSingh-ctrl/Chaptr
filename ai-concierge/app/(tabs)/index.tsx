import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
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
import { router, useFocusEffect, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import {
  buildWithdrawProposalTx,
  buildRecordA2AResultTx,
  buildProposeMatchTx,
  buildRecordAndProposePTB,
} from '@/utils/suiTransactions';
import {
  fetchZkProof,
  loadZkLoginParams,
  setupZkLoginParams,
  getJwtForTransaction,
  executeZkLoginTransaction,
} from '@/utils/zkLoginService';
import {
  readBlockedProfileKeys,
  readHiddenProfileIds,
  writeFeedback,
} from '@/utils/safetyService';
import {
  formatScoutCapsuleForPrompt,
  loadLocalScoutCapsule,
  type ScoutCapsule,
} from '@/utils/twinMemory';
import { syncHumanMatchesFromSui, processAutoAccepts, getMatchedOwners } from '@/utils/matchSync';

const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const TWIN_POOL_ID = process.env.EXPO_PUBLIC_TWIN_POOL_ID || '';
const PACKAGE_ID = process.env.EXPO_PUBLIC_PACKAGE_ID || '';
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const REPORT_FEEDBACK_KEY = 'chaptr:report-feedback-ids';

const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space/v1/blobs';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

const PASSED_PROFILES_KEY = 'chaptr:passed-profiles';
const UNLOCKED_PROFILES_KEY = 'chaptr:unlocked-profiles';
const ACTIVE_PROPOSAL_KEY = 'chaptr:active-proposal';
const HUMAN_MATCHES_KEY = 'chaptr:human-matches';

type ReportAccuracySignal = 'accurate' | 'somewhat_accurate' | 'not_accurate';

const REPORT_FEEDBACK_OPTIONS: { label: string; signal: ReportAccuracySignal }[] = [
  { label: 'Accurate', signal: 'accurate' },
  { label: 'Somewhat', signal: 'somewhat_accurate' },
  { label: 'Missed', signal: 'not_accurate' },
];

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const scoutReportKey = (candidateTwinId: string) =>
  `chaptr:scout-report:v2:${candidateTwinId}`;

const SCOUT_REPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'INTEGER' },
    summary: { type: 'STRING' },
    reasons: { type: 'ARRAY', items: { type: 'STRING' } },
    risks: { type: 'ARRAY', items: { type: 'STRING' } },
    suggestedOpener: { type: 'STRING' },
  },
  required: ['score', 'summary', 'reasons', 'risks', 'suggestedOpener'],
  propertyOrdering: ['score', 'summary', 'reasons', 'risks', 'suggestedOpener'],
};

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScoutProfile {
  version: number;
  kind: string;
  displayName: string;
  age: number;
  location: string;
  bio: string;
  gender: string;
  interestedIn: string;
  lookingFor: string;
  communicationStyle: string;
  mustHave: string;
  dealBreaker: string;
  previewPhotoBlobId: string | null;
  createdAt: string;
  scoutCapsule?: ScoutCapsule;
}

interface ScoutReport {
  score: number;
  summary: string;
  reasons: string[];
  risks: string[];
  suggestedOpener: string;
}

interface PoolEntry {
  twin_id: string;
  owner: string;
  scout_ref: string;
  joined_at_epoch: string;
}

interface Profile {
  id: string;
  name: string;
  age: number;
  compatibility: number;
  location: string;
  bio: string;
  photoUrl: string;
  overheard: string[];
  scoutRef: string;
  reportRef?: string;
  report?: ScoutReport;
  lookingFor: string;
  owner: string;
}

interface ActiveProposal {
  status: 'sent';
  proposalId?: string | null;
  candidateTwinId: string;
  candidateOwner: string;
  candidateScoutRef: string | null;
  candidateName: string;
  score: number;
  digest: string;
  createdAt: string;
}

interface HumanMatch {
  matchId?: string | null;
  proposalId: string;
  participantOwner: string;
  participantTwinId: string | null;
  participantScoutRef: string | null;
  participantName: string;
  score: number;
  acceptedDigest: string;
  createdAt: string;
}

// ─── Activity Log Types ───────────────────────────────────────────────────────

type FilterReason = 'self' | 'matched' | 'gender_mismatch' | 'blocked_hidden' | 'fetch_failed';

interface FilteredEntry {
  owner: string;
  reason: FilterReason;
}

interface PassedEntry {
  name: string;
  score: number;
  reportRef?: string | null;
  scoutRef: string;
  a2aTranscriptRef?: string | null;
  a2aScore?: number;
  a2aSummary?: string;
  autoProposed?: boolean;
}

interface PoolScanLog {
  scannedAt: string;
  totalInPool: number;
  filtered: FilteredEntry[];
  passed: PassedEntry[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const blobUrl = (blobId: string) =>
  `${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`;

const toPlainString = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value?.id && typeof value.id === 'string') return value.id;
  if (value === null || value === undefined) return '';
  return String(value);
};

const showNotice = (title: string, message: string) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  Alert.alert(title, message);
};

const confirmAction = (title: string, message: string) =>
  new Promise<boolean>((resolve) => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      resolve(window.confirm(`${title}\n\n${message}`));
      return;
    }
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
    ]);
  });

const clearChaptrLocalStorage = async () => {
  const keys = await AsyncStorage.getAllKeys();
  await AsyncStorage.multiRemove(keys.filter((key) => key.startsWith('chaptr:')));
};

const extractProposalIdFromResult = (result: any): string | null => {
  const createdProposal = result.objectChanges?.find(
    (change: any) =>
      change.type === 'created' &&
      typeof change.objectType === 'string' &&
      change.objectType.endsWith('::matchmaker::MatchProposal'),
  );
  if (createdProposal?.objectId) return createdProposal.objectId;
  for (const event of result.events ?? []) {
    const parsed = event.parsedJson ?? {};
    const candidates = [parsed.proposalId, parsed.proposal_id, parsed.id, parsed.proposal?.id, parsed.proposal?.objectId];
    const found = candidates.map(toPlainString).find(Boolean);
    if (found) return found;
  }
  return null;
};

const fetchProposalIdFromDigest = async (digest: string): Promise<string | null> => {
  if (!digest) return null;
  const result = await suiClient.getTransactionBlock({
    digest,
    options: { showEvents: true, showObjectChanges: true },
  });
  return extractProposalIdFromResult(result);
};

interface AcceptedMatchEvent {
  proposalId: string | null;
  matchId: string | null;
  from: string | null;
  to: string | null;
  score: number;
  txDigest: string;
  timestampMs: string | null;
}

const firstValue = (...values: any[]) =>
  values.map(toPlainString).find((value) => value.length > 0) ?? '';

const queryMatchmakerEvents = async () => {
  if (!PACKAGE_ID) return [];
  const result = await suiClient.queryEvents({
    query: { MoveModule: { package: PACKAGE_ID, module: 'matchmaker' } } as any,
    limit: 100,
    order: 'descending',
  });
  return result.data ?? [];
};

const parseAcceptedEvent = (event: any): AcceptedMatchEvent | null => {
  const type = String(event.type ?? '').toLowerCase();
  const eventName = type.split('::').pop() ?? type;
  const acceptedLike =
    eventName.includes('accepted') ||
    eventName.includes('matchformed') ||
    eventName.includes('matchcreated') ||
    eventName === 'match';
  if (
    !acceptedLike ||
    eventName.includes('sent') ||
    eventName.includes('reject') ||
    eventName.includes('withdraw') ||
    eventName.includes('ended')
  ) return null;
  const parsed = event.parsedJson ?? {};
  return {
    proposalId: firstValue(parsed.proposal_id, parsed.proposalId, parsed.proposal?.id) || null,
    matchId: firstValue(parsed.match_id, parsed.matchId, parsed.match?.id, parsed.id) || null,
    from: firstValue(parsed.from, parsed.proposer, parsed.sender, parsed.participant_a, parsed.owner_a, parsed.agent_a_owner, parsed.user_a) || null,
    to: firstValue(parsed.to, parsed.receiver, parsed.target, parsed.participant_b, parsed.owner_b, parsed.agent_b_owner, parsed.user_b) || null,
    score: Number(parsed.score ?? parsed.similarity_score) || 86,
    txDigest: event.id?.txDigest ?? '',
    timestampMs: event.timestampMs ?? null,
  };
};

const upsertHumanMatch = async (matches: HumanMatch[], record: HumanMatch) => {
  const next = [
    record,
    ...matches.filter(
      (match) =>
        (match.matchId ?? match.proposalId) !== (record.matchId ?? record.proposalId) &&
        match.proposalId !== record.proposalId &&
        !sameAddress(match.participantOwner, record.participantOwner),
    ),
  ];
  await AsyncStorage.setItem(HUMAN_MATCHES_KEY, JSON.stringify(next));
  return next;
};

const syncActiveProposalAcceptance = async (
  proposal: ActiveProposal | null,
  matches: HumanMatch[],
  myOwner: string | null,
) => {
  if (!proposal || !myOwner) return { proposal, matches };
  let syncedProposal = proposal;
  let proposalId = syncedProposal.proposalId ?? null;
  if (!proposalId) {
    proposalId = await fetchProposalIdFromDigest(syncedProposal.digest).catch(() => null);
    if (proposalId) {
      syncedProposal = { ...syncedProposal, proposalId };
      await AsyncStorage.setItem(ACTIVE_PROPOSAL_KEY, JSON.stringify(syncedProposal));
    }
  }
  const accepted = (await queryMatchmakerEvents())
    .map(parseAcceptedEvent)
    .find((event) => {
      if (!event) return false;
      const sameProposal = Boolean(proposalId && event.proposalId === proposalId);
      const samePair =
        (sameAddress(event.from, myOwner) && sameAddress(event.to, syncedProposal.candidateOwner)) ||
        (sameAddress(event.to, myOwner) && sameAddress(event.from, syncedProposal.candidateOwner));
      return sameProposal || samePair;
    });
  if (!accepted) return { proposal: syncedProposal, matches };
  const nextMatches = await upsertHumanMatch(matches, {
    matchId: accepted.matchId ?? accepted.proposalId ?? proposalId ?? syncedProposal.digest,
    proposalId: proposalId ?? accepted.proposalId ?? syncedProposal.digest,
    participantOwner: syncedProposal.candidateOwner,
    participantTwinId: syncedProposal.candidateTwinId,
    participantScoutRef: syncedProposal.candidateScoutRef,
    participantName: syncedProposal.candidateName,
    score: accepted.score || syncedProposal.score,
    acceptedDigest: accepted.txDigest || syncedProposal.digest,
    createdAt: accepted.timestampMs
      ? new Date(Number(accepted.timestampMs)).toISOString()
      : new Date().toISOString(),
  });
  await AsyncStorage.removeItem(ACTIVE_PROPOSAL_KEY);
  return { proposal: null, matches: nextMatches };
};

// getJwtForTransaction — imported from zkLoginService

// executeZkLoginTransaction — imported from zkLoginService

const cleanPhrase = (value?: string | null) =>
  (value ?? '').trim().replace(/[.!?]+$/g, '').toLowerCase();

const readStringArray = async (key: string): Promise<string[]> => {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch { return []; }
};

const readActiveProposal = async (): Promise<ActiveProposal | null> => {
  const raw = await AsyncStorage.getItem(ACTIVE_PROPOSAL_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};

const readHumanMatches = async (): Promise<HumanMatch[]> => {
  const raw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const findHumanMatchForProfile = (matches: HumanMatch[], profile: Pick<Profile, 'id' | 'owner'>) =>
  matches.find(
    (match) =>
      match?.participantTwinId === profile.id ||
      sameAddress(match?.participantOwner, profile.owner),
  );

const normalizeGender = (value?: string | null) => {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'woman' || v === 'women') return 'women';
  if (v === 'man' || v === 'men') return 'men';
  if (v === 'non-binary' || v === 'nonbinary' || v === 'non binary') return 'non-binary';
  if (v === 'everyone') return 'everyone';
  return v;
};

const matchesInterest = (interest?: string | null, gender?: string | null) => {
  const want = normalizeGender(interest);
  const target = normalizeGender(gender);
  if (!want || !target) return true;
  if (want === 'everyone') return true;
  return want === target;
};

const deriveCompatibility = (owner: string): number => {
  let hash = 0;
  for (let i = 0; i < owner.length; i++) {
    hash = (hash << 5) - hash + owner.charCodeAt(i);
    hash |= 0;
  }
  return 82 + (Math.abs(hash) % 16);
};

const buildOverheard = (scout: ScoutProfile): string[] => {
  const name = scout.displayName || 'Their Twin';
  if (scout.mustHave) {
    return [
      `Your Agent: ${name} is looking for ${cleanPhrase(scout.lookingFor) || 'connection'}.`,
      `${name}'s Agent: They value ${cleanPhrase(scout.mustHave)}.`,
      'Your Agent: Worth a closer read.',
    ];
  }
  return [
    `${name}'s Agent: They want a genuine connection, not just chat.`,
    'Your Agent: Your Twin reads enough signal to start a conversation.',
  ];
};

const fetchPoolEntries = async (): Promise<PoolEntry[]> => {
  if (!TWIN_POOL_ID) throw new Error('EXPO_PUBLIC_TWIN_POOL_ID is not set');
  const obj = await suiClient.getObject({ id: TWIN_POOL_ID, options: { showContent: true } });
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

const fetchScoutProfile = async (blobId: string): Promise<ScoutProfile> => {
  const res = await fetch(blobUrl(blobId));
  if (!res.ok) throw new Error(`Walrus fetch failed for ${blobId}: ${res.status}`);
  return res.json();
};

const extractBlobId = (result: any): string | null =>
  result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? null;

const uploadJsonToWalrus = async (payload: unknown): Promise<string> => {
  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=50`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Walrus report upload failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  const blobId = extractBlobId(result);
  if (!blobId) throw new Error(`No report blobId in Walrus response: ${JSON.stringify(result)}`);
  return blobId;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 4);
};

const fallbackScoutReport = (myScout: ScoutProfile, candidateScout: ScoutProfile): ScoutReport => {
  const score = cleanPhrase(candidateScout.lookingFor) === cleanPhrase(myScout.lookingFor) ? 86 : 78;
  const name = candidateScout.displayName || 'this person';
  const lookingFor = cleanPhrase(candidateScout.lookingFor);
  const mustHave = cleanPhrase(candidateScout.mustHave);
  const dealBreaker = cleanPhrase(candidateScout.dealBreaker);
  return {
    score,
    summary: `Your Twin found a promising early signal with ${name}.`,
    reasons: [
      lookingFor ? `They are looking for ${lookingFor}, which gives your Twin a clear intent signal.` : 'Their dating intent is open enough to explore.',
      mustHave ? `They value ${mustHave}, which is useful for compatibility screening.` : 'Their profile has enough emotional context to start a conversation.',
    ],
    risks: [dealBreaker ? `Their hard no is ${dealBreaker}, so your Twin should check for that early.` : 'The report is based on profile data only, not a full conversation yet.'],
    suggestedOpener: mustHave ? `What does ${mustHave} look like to you in dating?` : 'What are you hoping dating feels like at its best?',
  };
};

const normalizeScoutReport = (raw: any, myScout?: ScoutProfile, candidateScout?: ScoutProfile): ScoutReport => {
  const fallback = myScout && candidateScout ? fallbackScoutReport(myScout, candidateScout) : {
    score: 78,
    summary: 'Your Twin found enough alignment to start a conversation.',
    reasons: ['Their profile shows enough overlap with your dating preferences.'],
    risks: ['Not enough conversation data yet. Treat this as an early signal.'],
    suggestedOpener: 'What are you hoping dating feels like at its best?',
  };
  const score = Math.max(50, Math.min(99, Math.round(Number(raw?.score) || fallback.score)));
  const reasons = asStringArray(raw?.reasons);
  const risks = asStringArray(raw?.risks);
  return {
    score,
    summary: typeof raw?.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : fallback.summary,
    reasons: reasons.length > 0 ? reasons : fallback.reasons,
    risks: risks.length > 0 ? risks : fallback.risks,
    suggestedOpener: typeof raw?.suggestedOpener === 'string' && raw.suggestedOpener.trim() ? raw.suggestedOpener.trim() : fallback.suggestedOpener,
  };
};

const parseGeminiJson = (text: string): any | null => {
  const cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const sliced = cleaned.slice(firstBrace, lastBrace + 1);
      try { return JSON.parse(sliced); } catch { console.warn('Gemini returned invalid JSON, using fallback report:', cleaned); }
    }
    return null;
  }
};

const generateScoutReport = async (myScout: ScoutProfile, candidateScout: ScoutProfile): Promise<ScoutReport> => {
  if (!GEMINI_API_KEY) return fallbackScoutReport(myScout, candidateScout);
  const prompt = `You are Chaptr's scout report generator.\n\nCompare the current user with the candidate Twin and return ONLY valid JSON.\nDo not use markdown.\nDo not wrap the JSON in backticks.\nDo not include comments.\nUse simple plain text. Avoid quotation marks inside string values.\n\nCurrent user public-safe Scout Capsule:\n${formatScoutCapsuleForPrompt(myScout.scoutCapsule)}\n\nCandidate public-safe Scout Capsule:\n${formatScoutCapsuleForPrompt(candidateScout.scoutCapsule)}\n\nJSON shape:\n{\n  "score": 86,\n  "summary": "One short sentence.",\n  "reasons": ["Reason one.", "Reason two."],\n  "risks": ["Risk one."],\n  "suggestedOpener": "One natural dating app opener."\n}\n\nCurrent user scout profile:\n${JSON.stringify(myScout, null, 2)}\n\nCandidate scout profile:\n${JSON.stringify(candidateScout, null, 2)}`.trim();
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 600, responseMimeType: 'application/json', responseSchema: SCOUT_REPORT_SCHEMA },
        }),
      },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? `Gemini report failed: ${response.status}`);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = text ? parseGeminiJson(text) : null;
    return normalizeScoutReport(parsed ?? {}, myScout, candidateScout);
  } catch (error) {
    console.warn('Gemini scout report failed, using fallback report:', error);
    return fallbackScoutReport(myScout, candidateScout);
  }
};

const loadOrCreateScoutReport = async (
  candidateTwinId: string,
  candidateScoutRef: string,
  myScout: ScoutProfile,
  candidateScout: ScoutProfile,
): Promise<{ report: ScoutReport; reportRef: string | null }> => {
  const cacheKey = scoutReportKey(candidateTwinId);
  const cached = await AsyncStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      return { report: normalizeScoutReport(parsed.report, myScout, candidateScout), reportRef: parsed.reportRef ?? null };
    } catch { await AsyncStorage.removeItem(cacheKey); }
  }
  const report = await generateScoutReport(myScout, candidateScout);
  const reportPayload = { version: 1, kind: 'chaptr-scout-report', candidateTwinId, candidateScoutRef, report, createdAt: new Date().toISOString() };
  let reportRef: string | null = null;
  try { reportRef = await uploadJsonToWalrus(reportPayload); } catch (error) { console.warn('Scout report Walrus upload failed:', error); }
  await AsyncStorage.setItem(cacheKey, JSON.stringify({ report, reportRef, createdAt: reportPayload.createdAt }));
  return { report, reportRef };
};

const entryToProfile = (entry: PoolEntry, scout: ScoutProfile): Profile => {
  const photoUrl = scout.previewPhotoBlobId
    ? blobUrl(scout.previewPhotoBlobId)
    : `https://api.dicebear.com/7.x/personas/png?seed=${encodeURIComponent(entry.owner)}`;
  return {
    id: entry.twin_id,
    name: scout.displayName || 'Unknown',
    age: scout.age || 0,
    compatibility: deriveCompatibility(entry.owner),
    location: scout.location || '',
    bio: scout.bio || '',
    photoUrl,
    overheard: buildOverheard(scout),
    scoutRef: entry.scout_ref,
    lookingFor: scout.lookingFor || '',
    owner: entry.owner,
  };
};

const getInitial = (name: string) => (name ?? '?').charAt(0).toUpperCase();

const openLink = (url: string) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank');
  } else {
    Linking.openURL(url);
  }
};

// ─── Activity Log Modal ───────────────────────────────────────────────────────

function ActivityLogModal({
  visible,
  onClose,
  poolScanLog,
}: {
  visible: boolean;
  onClose: () => void;
  poolScanLog: PoolScanLog | null;
}) {
  const reasonLabel: Record<FilterReason, string> = {
    self: 'This is you',
    matched: 'Currently in a match',
    gender_mismatch: 'Gender / interest mismatch',
    blocked_hidden: 'Blocked or hidden',
    fetch_failed: 'Scout profile unavailable',
  };

  const reasonIcon: Record<FilterReason, string> = {
    self: '👤',
    matched: '💞',
    gender_mismatch: '🔀',
    blocked_hidden: '🚫',
    fetch_failed: '❌',
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={modalStyles.overlay}>
        <TouchableOpacity style={modalStyles.backdrop} onPress={onClose} activeOpacity={1} />
        <View style={modalStyles.sheet}>
          <View style={modalStyles.handle} />

          <View style={modalStyles.header}>
            <View>
              <Text style={modalStyles.title}>Twin Activity Log</Text>
              <Text style={modalStyles.subtitle}>What your agent did autonomously</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={modalStyles.closeBtn}>
              <Text style={modalStyles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={modalStyles.scroll}>
            {!poolScanLog ? (
              <View style={modalStyles.emptyState}>
                <Text style={modalStyles.emptyIcon}>🤖</Text>
                <Text style={modalStyles.emptyTitle}>No activity yet</Text>
                <Text style={modalStyles.emptyBody}>
                  Your Twin hasn't scouted the pool yet. Pull up the Morning Briefing to trigger a scan.
                </Text>
              </View>
            ) : (
              <>
                {/* Pool Scan Header */}
                <View style={modalStyles.sectionHeader}>
                  <View style={modalStyles.sectionIconWrap}>
                    <Text style={modalStyles.sectionIcon}>🔍</Text>
                  </View>
                  <View>
                    <Text style={modalStyles.sectionTitle}>Pool Scan</Text>
                    <Text style={modalStyles.sectionTime}>
                      {new Date(poolScanLog.scannedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                  </View>
                </View>

                {/* Total count */}
                <View style={modalStyles.statRow}>
                  <Text style={modalStyles.statIcon}>📊</Text>
                  <Text style={modalStyles.statLabel}>
                    <Text style={modalStyles.statNumber}>{poolScanLog.totalInPool}</Text>
                    {' '}profile{poolScanLog.totalInPool !== 1 ? 's' : ''} found in pool
                  </Text>
                </View>

                {/* Filtered entries */}
                {poolScanLog.filtered.length > 0 && (
                  <>
                    <Text style={modalStyles.groupLabel}>SKIPPED</Text>
                    {poolScanLog.filtered.map((f, i) => (
                      <View key={i} style={modalStyles.filteredRow}>
                        <Text style={modalStyles.filteredIcon}>{reasonIcon[f.reason]}</Text>
                        <View style={modalStyles.filteredContent}>
                          <Text style={modalStyles.filteredReason}>{reasonLabel[f.reason]}</Text>
                          <Text style={modalStyles.filteredOwner}>
                            {f.owner.slice(0, 8)}...{f.owner.slice(-6)}
                          </Text>
                        </View>
                        <View style={[modalStyles.reasonBadge, modalStyles[`badge_${f.reason}` as keyof typeof modalStyles] as any]}>
                          <Text style={modalStyles.reasonBadgeText}>skip</Text>
                        </View>
                      </View>
                    ))}
                  </>
                )}

                {/* Passed entries */}
                {poolScanLog.passed.length > 0 && (
                  <>
                    <Text style={modalStyles.groupLabel}>SELECTED FOR BRIEFING</Text>
                    {poolScanLog.passed.map((p, i) => (
                      <View key={i} style={modalStyles.passedRow}>
                        <View style={modalStyles.passedLeft}>
                          <Text style={modalStyles.passedIcon}>✦</Text>
                          <View style={{ flex: 1 }}>
                            <Text style={modalStyles.passedName}>{p.name}</Text>
                            <View style={modalStyles.passedLinks}>
                              <TouchableOpacity
                                onPress={() => openLink(`${WALRUS_AGGREGATOR}/${p.scoutRef}`)}
                                style={modalStyles.linkBtn}
                              >
                                <Text style={modalStyles.linkBtnText}>Scout profile ↗</Text>
                              </TouchableOpacity>
                              {p.reportRef && (
                                <TouchableOpacity
                                  onPress={() => openLink(`${WALRUS_AGGREGATOR}/${p.reportRef}`)}
                                  style={modalStyles.linkBtn}
                                >
                                  <Text style={modalStyles.linkBtnText}>Scout report ↗</Text>
                                </TouchableOpacity>
                              )}
                              {p.a2aTranscriptRef && (
                                <TouchableOpacity
                                  onPress={() => openLink(`${WALRUS_AGGREGATOR}/${p.a2aTranscriptRef}`)}
                                  style={modalStyles.linkBtn}
                                >
                                  <Text style={[modalStyles.linkBtnText, { color: '#a78bfa' }]}>A2A transcript ↗</Text>
                                </TouchableOpacity>
                              )}
                              {p.autoProposed && (
                                <View style={[modalStyles.linkBtn, { borderColor: 'rgba(167,139,250,0.35)', backgroundColor: 'rgba(167,139,250,0.1)' }]}>
                                  <Text style={[modalStyles.linkBtnText, { color: '#a78bfa' }]}>⚡ Auto-proposed</Text>
                                </View>
                              )}
                            </View>
                            {p.a2aSummary ? (
                              <Text style={modalStyles.a2aSummaryText}>{p.a2aSummary}</Text>
                            ) : null}
                          </View>
                        </View>
                        <View style={modalStyles.scorePill}>
                          <Text style={modalStyles.scoreText}>{p.score}%</Text>
                        </View>
                      </View>
                    ))}
                  </>
                )}

                {/* Summary footer */}
                <View style={modalStyles.summaryBox}>
                  <Text style={modalStyles.summaryText}>
                    🤖 Your Twin scanned{' '}
                    <Text style={modalStyles.summaryBold}>{poolScanLog.totalInPool} profiles</Text>
                    , skipped{' '}
                    <Text style={modalStyles.summaryBold}>{poolScanLog.filtered.length}</Text>
                    , and surfaced{' '}
                    <Text style={[modalStyles.summaryBold, { color: '#4ade80' }]}>
                      {poolScanLog.passed.length}
                    </Text>{' '}
                    to your briefing.
                  </Text>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function MorningBriefingScreen() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [passedProfileIds, setPassedProfileIds] = useState<string[]>([]);
  const [unlockedProfileIds, setUnlockedProfileIds] = useState<string[]>([]);
  const [humanMatches, setHumanMatches] = useState<HumanMatch[]>([]);
  const [activeProposal, setActiveProposal] = useState<ActiveProposal | null>(null);
  const [hasLocalTwin, setHasLocalTwin] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [reportFeedbackIds, setReportFeedbackIds] = useState<string[]>([]);
  const [isWritingReportFeedback, setIsWritingReportFeedback] = useState<string | null>(null);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [poolScanLog, setPoolScanLog] = useState<PoolScanLog | null>(null);

  const isEndingMatch = false;

  const loadPoolProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [
        entries,
        myOwner,
        myGender,
        myInterestedIn,
        storedMyScoutRef,
        localScoutCapsule,
        blockedKeys,
        hiddenProfileIds,
      ] = await Promise.all([
        fetchPoolEntries(),
        AsyncStorage.getItem('chaptr:my-owner'),
        AsyncStorage.getItem('chaptr:my-gender'),
        AsyncStorage.getItem('chaptr:my-interested-in'),
        AsyncStorage.getItem('chaptr:my-scout-ref'),
        loadLocalScoutCapsule(),
        readBlockedProfileKeys(),
        readHiddenProfileIds(),
      ]);

      const blockedKeySet = new Set(blockedKeys.map((key) => key.toLowerCase()));
      const hiddenProfileIdSet = new Set(hiddenProfileIds.map((id) => id.toLowerCase()));

      // Build active match owners set from GLOBAL on-chain events.
      // getMatchedOwners() returns ALL owners currently in ANY active match,
      // not just the current user's partners. This prevents proposing to
      // candidates who are matched with someone else (e.g. Ethan ↔ Mahek).
      const activeMatchedOwners = await getMatchedOwners().catch((err) => {
        console.warn('[pool] getMatchedOwners failed, falling back to local:', err);
        // Fallback: use local matches (only covers current user's partners)
        const localFallback = async () => {
          const chainMatches = myOwner
            ? await syncHumanMatchesFromSui(myOwner).catch(() => [])
            : [];
          const localMatchesRaw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
          const localMatches: HumanMatch[] = (() => {
            try {
              const parsed = JSON.parse(localMatchesRaw ?? '[]');
              return Array.isArray(parsed) ? parsed : [];
            } catch { return []; }
          })();
          const allKnownMatches = chainMatches.length > 0 ? chainMatches : localMatches;
          const owners = new Set<string>();
          for (const m of allKnownMatches) {
            if (m.participantOwner) owners.add(m.participantOwner.toLowerCase());
          }
          // Also add myOwner if I have matches (so self-check works)
          if (myOwner && allKnownMatches.length > 0) owners.add(myOwner.toLowerCase());
          return owners;
        };
        return localFallback();
      });

      if (entries.length === 0) {
        setProfiles([]);
        setPoolScanLog({
          scannedAt: new Date().toISOString(),
          totalInPool: 0,
          filtered: [],
          passed: [],
        });
        return;
      }

      const myPoolEntry = myOwner
        ? entries.find((entry) => sameAddress(entry.owner, myOwner))
        : null;
      const myScoutRef = storedMyScoutRef || myPoolEntry?.scout_ref || null;
      const fetchedMyScout = myScoutRef ? await fetchScoutProfile(myScoutRef).catch(() => null) : null;
      const myScout = fetchedMyScout
        ? {
          ...fetchedMyScout,
          scoutCapsule: {
            ...(fetchedMyScout.scoutCapsule ?? localScoutCapsule ?? undefined),
            feedbackHistory: localScoutCapsule?.feedbackHistory ?? fetchedMyScout.scoutCapsule?.feedbackHistory,
          } as ScoutCapsule,
        }
        : null;

      // ── Instrumented pool scan ────────────────────────────────────────────
      const filteredLog: FilteredEntry[] = [];
      const passedLog: PassedEntry[] = [];

      // Read mandate once outside the loop for efficiency
      const mandateIdStored = await AsyncStorage.getItem('chaptr:mandate-id');
      // Self-check: am I already in an active match? If so, skip A2A + propose.
      // getMatchedOwners() includes BOTH sides of each match, so myOwner will
      // be in the set if I'm currently matched with anyone.
      const isInActiveMatch = Boolean(
        myOwner && activeMatchedOwners.has(myOwner.toLowerCase()),
      );

      let mandateFields: any = null;
      if (mandateIdStored && !isInActiveMatch) {
        try {
          const mandateObj = await suiClient.getObject({
            id: mandateIdStored,
            options: { showContent: true },
          });
          mandateFields = (mandateObj.data?.content as any)?.fields ?? null;
        } catch (err) {
          console.warn('[A2A] Mandate fetch failed (non-blocking):', err);
        }
      }

      // ── Phase 1: parallel scout scan (no A2A, no Groq) ───────────────────
      // Each entry fetches its scout profile and generates/loads a scout report.
      // A2A is intentionally excluded here — it runs sequentially in Phase 2.

      interface ScoutedEntry {
        entry: PoolEntry;
        scout: ScoutProfile;
        baseProfile: Profile;
        report: ScoutReport;
        reportRef: string | null;
      }

      const scoutedEntries: ScoutedEntry[] = [];

      const scoutSettled = await Promise.allSettled(
        entries.map(async (entry) => {
          // Skip self
          if (myOwner && sameAddress(entry.owner, myOwner)) {
            filteredLog.push({ owner: entry.owner, reason: 'self' });
            return null;
          }

          const entryKeys = [entry.owner, entry.twin_id].map((v) => v.toLowerCase());
          if (
            entryKeys.some((key) => blockedKeySet.has(key)) ||
            hiddenProfileIdSet.has(entry.twin_id.toLowerCase())
          ) {
            filteredLog.push({ owner: entry.owner, reason: 'blocked_hidden' });
            return null;
          }

          if (activeMatchedOwners.has(entry.owner.toLowerCase())) {
            filteredLog.push({ owner: entry.owner, reason: 'matched' });
            return null;
          }

          let scout: ScoutProfile;
          try {
            scout = await fetchScoutProfile(entry.scout_ref);
          } catch {
            console.warn(`[pool] Scout fetch failed for ${entry.owner.slice(0, 10)}`);
            filteredLog.push({ owner: entry.owner, reason: 'fetch_failed' });
            return null;
          }

          const theyWantMe = matchesInterest(scout.interestedIn, myGender);
          const iWantThem = matchesInterest(myInterestedIn, scout.gender);
          if (!theyWantMe || !iWantThem) {
            filteredLog.push({ owner: entry.owner, reason: 'gender_mismatch' });
            return null;
          }

          const baseProfile = entryToProfile(entry, scout);

          if (!myScout) {
            passedLog.push({ name: baseProfile.name, score: baseProfile.compatibility, scoutRef: entry.scout_ref });
            return { entry, scout, baseProfile, report: null as any, reportRef: null };
          }

          const { report, reportRef } = await loadOrCreateScoutReport(
            entry.twin_id,
            entry.scout_ref,
            myScout,
            scout,
          );

          return { entry, scout, baseProfile, report, reportRef } as ScoutedEntry;
        }),
      );

      for (const result of scoutSettled) {
        if (result.status === 'fulfilled' && result.value) {
          scoutedEntries.push(result.value);
        }
      }

      // ── Phase 2: sequential A2A (one at a time, cache-first) ─────────────
      // Runs only if Mandate allows. Each candidate is processed serially so
      // Groq rate limits are never hit. Cache is checked first — if a result
      // exists from a prior session it is returned instantly with no API call.

      // FIX: split propose actions from record actions so Phase 4 can skip
      // record_a2a_result entirely, cutting Enoki proof generation in half.
      // record_a2a_result is informational; propose_match is what matters for the demo.
      interface ProposeAction {
        kind: 'propose';
        mandateIdStored: string;
        entryOwner: string;
        transcriptRef: string;
        reportRef: string;
        score: number;
        twinId: string;
      }

      interface RecordAction {
        kind: 'record';
        mandateIdStored: string;
        entryOwner: string;
        transcriptRef: string;
        reportRef: string;
        score: number;
      }

      type PendingAction = ProposeAction | RecordAction;

      const a2aPendingActions: PendingAction[] = [];

      // Map from candidateOwner → a2aResult for merging into profiles below
      const a2aResultMap = new Map<string, any>();

      if (mandateFields?.may_run_a2a === true && myScout && myOwner) {
        const { runA2AConversation, getCachedA2AResult } = await import('@/utils/aiEngine');
        const myTwinId = await AsyncStorage.getItem('chaptr:my-twin-id');
        const minScoreToPropose = Number(mandateFields?.min_score_to_propose ?? 80);

        for (const scouted of scoutedEntries) {
          const { entry, scout } = scouted;
          try {
            const cached = await getCachedA2AResult(myOwner, entry.owner);
            if (cached) {
              console.log('[A2A] Using cached result for', entry.owner.slice(0, 10));
            } else {
              console.log('[A2A] Running conversation with', entry.owner.slice(0, 10));
            }

            const a2aResult = await runA2AConversation(
              { ...myScout, owner: myOwner },
              { ...scout, owner: entry.owner },
            );

            a2aResultMap.set(entry.owner.toLowerCase(), a2aResult);

            // Queue record_a2a_result only for fresh (non-cached) results.
            // These are intentionally NOT fired in Phase 4 to avoid hitting
            // Enoki's per-user ZK proof limit. They are kept in the actions
            // list for future use when batching is available, but Phase 4
            // skips them. Remove this block entirely if recording is not needed.
            if (a2aResult.transcriptRef && a2aResult.reportRef && mandateIdStored && !cached) {
              a2aPendingActions.push({
                kind: 'record',
                mandateIdStored,
                entryOwner: entry.owner,
                transcriptRef: a2aResult.transcriptRef,
                reportRef: a2aResult.reportRef,
                score: a2aResult.score,
              });
            }

            // Queue propose independently of cache status — always check
            // if we should propose based on score, guarded by the
            // chaptr:auto-proposed key so we never double-propose.
            const shouldPropose =
              mandateFields.may_propose === true &&
              a2aResult.score >= minScoreToPropose;

            if (shouldPropose && myTwinId && mandateIdStored) {
              const proposedKey = `chaptr:auto-proposed:${entry.owner.toLowerCase()}`;
              const alreadyProposed = await AsyncStorage.getItem(proposedKey);
              if (!alreadyProposed) {
                a2aPendingActions.push({
                  kind: 'propose',
                  mandateIdStored,
                  entryOwner: entry.owner,
                  transcriptRef: a2aResult.transcriptRef ?? '',
                  reportRef: a2aResult.reportRef ?? '',
                  score: a2aResult.score,
                  twinId: myTwinId,
                });
              }
            }
          } catch (a2aErr) {
            console.warn('[A2A] Conversation failed for', entry.owner.slice(0, 10), a2aErr);
          }
        }
      }

      // ── Phase 3: merge scout + A2A results into final profiles ───────────

      for (const scouted of scoutedEntries) {
        const { entry, baseProfile, report, reportRef } = scouted;
        const a2aResult = a2aResultMap.get(entry.owner.toLowerCase()) ?? null;
        const minScoreToPropose = Number(mandateFields?.min_score_to_propose ?? 80);

        passedLog.push({
          name: baseProfile.name,
          score: a2aResult?.score ?? report?.score ?? baseProfile.compatibility,
          reportRef: a2aResult?.reportRef ?? reportRef,
          scoutRef: entry.scout_ref,
          ...(a2aResult ? {
            a2aTranscriptRef: a2aResult.transcriptRef,
            a2aScore: a2aResult.score,
            a2aSummary: a2aResult.summary,
            autoProposed: Boolean(
              mandateFields?.may_propose === true &&
              a2aResult.score >= minScoreToPropose,
            ),
          } : {}),
        });
      }

      // Save pool scan log for activity modal
      setPoolScanLog({
        scannedAt: new Date().toISOString(),
        totalInPool: entries.length,
        filtered: filteredLog,
        passed: passedLog,
      });

      const resolvedProfiles: Profile[] = scoutedEntries
        .map(({ entry, baseProfile, report, reportRef }) => {
          const a2aResult = a2aResultMap.get(entry.owner.toLowerCase()) ?? null;
          return {
            ...baseProfile,
            compatibility: a2aResult?.score ?? report?.score ?? baseProfile.compatibility,
            report: report ?? undefined,
            reportRef: (a2aResult?.reportRef ?? reportRef ?? undefined) as string | undefined,
          };
        })
        .sort((a, b) => b.compatibility - a.compatibility);

      setProfiles(resolvedProfiles);
      // Save for Judge Dashboard
      const topEntry = scoutedEntries[0];
      if (topEntry) {
        const a2aResult = a2aResultMap.get(topEntry.entry.owner.toLowerCase());
        await AsyncStorage.setItem('chaptr:judge-data', JSON.stringify({
          scoutRefA: myScoutRef ?? null,
          scoutRefB: topEntry.entry.scout_ref,
          transcriptRef: a2aResult?.transcriptRef ?? null,
          reportRef: a2aResult?.reportRef ?? null,
          score: a2aResult?.score ?? topEntry.report?.score ?? null,
          summary: a2aResult?.summary ?? null,
          chemistry: a2aResult?.chemistry ?? null,
          redFlags: a2aResult?.redFlags ?? null,
          recommendation: a2aResult?.recommendation ?? null,
          txDigest: null,
          mandateId: mandateIdStored ?? null,
        }));
      }

      // ── Phase 4: fire on-chain propose actions only (ONE Google popup) ────
      //
      // CRITICAL FIX for Enoki 429 / popup-on-every-navigation bug:
      //
      // We intentionally skip 'record' actions here. Each executeZkLoginTransaction
      // call costs one Enoki ZK proof generation. The free tier limit is tight —
      // with 2 candidates, firing both record + propose = 4 proofs per scan.
      // Skipping record cuts that to 1 proof per candidate (only the propose).
      //
      // The popup re-fires on every navigation because if a 429 kills the tx
      // before AsyncStorage.setItem('chaptr:auto-proposed:...') runs, the guard
      // key never gets saved and the propose is retried every useFocusEffect.
      // Reducing to 1 proof per propose makes it far less likely to 429, so
      // the guard key gets saved and the loop stops.
      //
      // If you need record_a2a_result back: batch it into the same tx as
      // propose_match using a PTB (Programmable Transaction Block) so both
      // actions consume only 1 proof instead of 2.

      const proposeActions = a2aPendingActions.filter(
        (action): action is ProposeAction => action.kind === 'propose',
      );

      let phaseJwt: string | undefined;

      // ── Pre-Phase-4: Auto-accept incoming proposals ──────────────────────
      // MUST run BEFORE outbound proposals because both operations consume the
      // DigitalTwin by value (Move's ownership model):
      //   - accept_proposal(proposal, agent_b: DigitalTwin) → Twin locked in Match
      //   - propose_match(agent_a: DigitalTwin, ...) → Twin locked in MatchProposal
      //
      // If Phase 4 proposes first, Twin is in escrow → auto-accept can't use it.
      // By accepting first, we prioritize completing existing connections.
      let twinConsumedByAccept = false;
      const myTwinIdForAccept = await AsyncStorage.getItem('chaptr:my-twin-id');

      if (myOwner && mandateFields?.may_propose === true) {
        try {
          phaseJwt = await getJwtForTransaction();
          console.log('[Pre-Phase4] JWT obtained — running auto-accept before outbound proposals');

          // Run auto-accept synchronously (not fire-and-forget) so we know
          // whether the Twin was consumed before we try Phase 4.
          await processAutoAccepts(myOwner, phaseJwt);

          // Check if Twin is still available after auto-accept
          if (myTwinIdForAccept) {
            try {
              const twinCheck = await suiClient.getObject({
                id: myTwinIdForAccept,
                options: { showType: true },
              });
              if (twinCheck.error || !twinCheck.data) {
                twinConsumedByAccept = true;
                console.log('[Pre-Phase4] Twin consumed by auto-accept — skipping outbound proposals');
              }
            } catch {
              twinConsumedByAccept = true;
            }
          }
        } catch (jwtErr) {
          console.warn('[Pre-Phase4] JWT/auto-accept failed (non-blocking):', jwtErr);
        }
      }

      // ── Phase 4: Outbound proposals (only if Twin still available) ─────────
      if (!twinConsumedByAccept && proposeActions.length > 0 && myOwner) {
        try {
          if (!phaseJwt) phaseJwt = await getJwtForTransaction();
          for (const action of proposeActions) {
            // ── Active-match guard ─────────────────────────────────────────
            // Skip if the target is already in a match — prevents proposing
            // to users like Mahek who are matched with someone else.
            if (activeMatchedOwners.has(action.entryOwner.toLowerCase())) {
              console.log('[PTB] Skipping — target already in match:', action.entryOwner.slice(0, 10));
              continue;
            }

            try {
              // PTB: record_a2a_result + propose_match in one tx = 1 Enoki proof
              const ptb = buildRecordAndProposePTB(
                action.mandateIdStored,
                action.entryOwner,
                action.transcriptRef,
                action.reportRef,
                action.score,
                action.twinId,
                action.entryOwner,
                `Your Twin scored ${action.score}% in an A2A conversation. No human was involved.`,
              );
              await executeZkLoginTransaction(ptb, myOwner, phaseJwt);
              await AsyncStorage.setItem(
                `chaptr:auto-proposed:${action.entryOwner.toLowerCase()}`,
                new Date().toISOString(),
              );
              console.log('[PTB] Recorded + proposed to', action.entryOwner.slice(0, 10), 'score:', action.score);
            } catch (actionErr) {
              console.warn('[PTB] Batch failed, falling back to record-only:', actionErr);
              // Fallback: if PTB fails (e.g. Twin already in escrow),
              // fire record_a2a_result alone so A2A is still anchored on-chain.
              try {
                const recordTx = buildRecordA2AResultTx(
                  action.mandateIdStored,
                  action.entryOwner,
                  action.transcriptRef,
                  action.reportRef,
                  action.score,
                );
                await executeZkLoginTransaction(recordTx, myOwner, phaseJwt);
                console.log('[PTB] Fallback record-only succeeded for', action.entryOwner.slice(0, 10));
              } catch (recordErr) {
                console.warn('[PTB] Fallback record also failed (non-blocking):', recordErr);
              }
            }
          }
        } catch (jwtErr) {
          console.warn('[A2A] Post-scan JWT failed (non-blocking):', jwtErr);
        }
      }

      return phaseJwt;
    } catch (err: any) {
      console.error('Failed to load pool profiles:', err);
      setError('Could not load your briefing. Check your connection.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadSavedState = useCallback(async (existingJwt?: string) => {
    const [passed, unlocked, proposal, myOwner, reportFeedback] = await Promise.all([
      readStringArray(PASSED_PROFILES_KEY),
      readStringArray(UNLOCKED_PROFILES_KEY),
      readActiveProposal(),
      AsyncStorage.getItem('chaptr:my-owner'),
      readStringArray(REPORT_FEEDBACK_KEY),
    ]);
    setReportFeedbackIds(reportFeedback);
    const chainMatches = myOwner
      ? await syncHumanMatchesFromSui(myOwner).catch((err) => {
        console.warn('[loadSavedState] chain sync failed, reading local:', err);
        return readHumanMatches();
      })
      : await readHumanMatches();
    const synced = await syncActiveProposalAcceptance(proposal, chainMatches, myOwner).catch((syncError) => {
      console.warn('Accepted match sync failed:', syncError);
      return { proposal, matches: chainMatches };
    });
    setPassedProfileIds(passed);
    setUnlockedProfileIds(unlocked);
    setActiveProposal(synced.proposal);
    setHumanMatches(synced.matches);

    // NOTE: processAutoAccepts now runs in loadPoolProfiles BEFORE Phase 4.
    // It no longer runs here — this prevents double-execution and ensures
    // incoming accepts are prioritized over outbound proposals.
  }, []);

  useFocusEffect(
    useCallback(() => {
      const loadScreen = async () => {
        const [myOwner, myTwinId, myScoutRef] = await Promise.all([
          AsyncStorage.getItem('chaptr:my-owner'),
          AsyncStorage.getItem('chaptr:my-twin-id'),
          AsyncStorage.getItem('chaptr:my-scout-ref'),
        ]);
        console.log('LOCAL TWIN CHECK:', { myOwner, myTwinId, myScoutRef });
        const hasTwin = Boolean(myOwner && myTwinId && myScoutRef);
        setHasLocalTwin(hasTwin);
        if (!hasTwin) {
          setProfiles([]);
          setIsLoading(false);
          await loadSavedState();
          return;
        }
        const phaseJwt = await loadPoolProfiles();
        await loadSavedState(phaseJwt);
      };
      setIsLoading(true);
      loadScreen().catch((loadError) => {
        console.warn(loadError);
        setHasLocalTwin(false);
        setIsLoading(false);
      });
    }, [loadPoolProfiles, loadSavedState]),
  );

  const topConnections = useMemo(
    () => profiles.filter((profile) => !passedProfileIds.includes(profile.id)),
    [profiles, passedProfileIds],
  );

  const activeHumanMatch = useMemo(() => humanMatches[0] ?? null, [humanMatches]);

  const handlePass = (profileId: string) => {
    setPassedProfileIds((prev) => {
      const next = Array.from(new Set([...prev, profileId]));
      AsyncStorage.setItem(PASSED_PROFILES_KEY, JSON.stringify(next)).catch(console.warn);
      return next;
    });
  };

  const handleChatWithAgent = (profile: Profile) => {
    const humanMatch = findHumanMatchForProfile(humanMatches, profile);
    if (humanMatch) {
      router.push({ pathname: '/human-chat/[id]', params: { id: humanMatch.matchId ?? humanMatch.proposalId, name: humanMatch.participantName } } as Href);
      return;
    }
    router.push({ pathname: '/chat/[id]', params: { id: profile.id, scoutRef: profile.scoutRef, name: profile.name, owner: profile.owner, score: String(profile.compatibility) } } as Href);
  };

  const openProposals = () => router.push('/proposals' as Href);
  const openTraining = () => router.push('/twin-training' as Href);

  const openActiveProposal = () => {
    if (!activeProposal) return;
    const humanMatch = findHumanMatchForProfile(humanMatches, { id: activeProposal.candidateTwinId, owner: activeProposal.candidateOwner });
    if (humanMatch) {
      router.push({ pathname: '/human-chat/[id]', params: { id: humanMatch.matchId ?? humanMatch.proposalId, name: humanMatch.participantName } } as Href);
      return;
    }
    router.push({ pathname: '/chat/[id]', params: { id: activeProposal.candidateTwinId, scoutRef: activeProposal.candidateScoutRef ?? '', name: activeProposal.candidateName, owner: activeProposal.candidateOwner, score: String(activeProposal.score) } } as Href);
  };

  const resolveActiveProposalId = useCallback(async (proposal: ActiveProposal) => {
    if (proposal.proposalId) return proposal.proposalId;
    const proposalId = await fetchProposalIdFromDigest(proposal.digest).catch(() => null);
    if (proposalId) {
      const updated = { ...proposal, proposalId };
      await AsyncStorage.setItem(ACTIVE_PROPOSAL_KEY, JSON.stringify(updated));
      setActiveProposal(updated);
    }
    return proposalId;
  }, []);

  const handleWithdrawActiveProposal = useCallback(async () => {
    if (!activeProposal) return;
    const confirmed = await confirmAction('Withdraw proposal?', `This releases your Twin from Focus Mode with ${activeProposal.candidateName}.`);
    if (!confirmed) return;
    setIsWithdrawing(true);
    try {
      const myOwner = await AsyncStorage.getItem('chaptr:my-owner');
      if (!myOwner) throw new Error('Missing local owner address.');
      const proposalId = await resolveActiveProposalId(activeProposal);
      if (!proposalId) throw new Error('Could not find the proposal object ID.');
      const jwt = await getJwtForTransaction();
      const tx = buildWithdrawProposalTx(proposalId);
      await executeZkLoginTransaction(tx, myOwner, jwt);
      await AsyncStorage.removeItem(ACTIVE_PROPOSAL_KEY);
      setActiveProposal(null);
      showNotice('Proposal withdrawn', 'Your Twin is free to focus on someone new.');
    } catch (withdrawError: any) {
      showNotice('Withdraw failed', withdrawError?.message ?? 'Could not withdraw proposal.');
    } finally {
      setIsWithdrawing(false);
    }
  }, [activeProposal, resolveActiveProposalId]);

  const handleLogout = useCallback(async () => {
    const confirmed = await confirmAction(
      'Log out of Chaptr?',
      activeProposal
        ? 'This clears local browser identity. Your active on-chain proposal will still exist unless you withdraw it first.'
        : 'This clears the local Chaptr identity from this browser.',
    );
    if (!confirmed) return;
    setIsLoggingOut(true);
    try {
      await clearChaptrLocalStorage();
      setProfiles([]);
      setPassedProfileIds([]);
      setUnlockedProfileIds([]);
      setHumanMatches([]);
      setActiveProposal(null);
      setHasLocalTwin(false);
      router.replace('/' as Href);
    } finally {
      setIsLoggingOut(false);
    }
  }, [activeProposal]);

  const openCurrentHumanMatch = useCallback(() => {
    if (!activeHumanMatch) return;
    router.push({ pathname: '/human-chat/[id]', params: { id: activeHumanMatch.matchId ?? activeHumanMatch.proposalId, name: activeHumanMatch.participantName } } as Href);
  }, [activeHumanMatch]);

  const handleEndActiveMatch = useCallback(async () => {
    if (!activeHumanMatch) return;
    const matchId = activeHumanMatch.matchId;
    if (!matchId) {
      showNotice('Cannot end match yet', 'This local match record is missing the on-chain Match ID. Accept a fresh proposal or resync this match first.');
      return;
    }
    const confirmed = await confirmAction('End current match?', `This opens a short reflection, then releases both Twins from your match with ${activeHumanMatch.participantName}.`);
    if (!confirmed) return;
    router.push({
      pathname: '/reflection' as any,
      params: {
        source: 'morning-briefing',
        matchId,
        proposalId: activeHumanMatch.proposalId,
        targetOwner: activeHumanMatch.participantOwner,
        targetTwinId: activeHumanMatch.participantTwinId ?? '',
        targetName: activeHumanMatch.participantName,
        score: String(activeHumanMatch.score ?? ''),
      },
    });
  }, [activeHumanMatch]);

  const handleReportAccuracyFeedback = async (profile: Profile, signal: ReportAccuracySignal) => {
    try {
      setIsWritingReportFeedback(profile.id);
      await writeFeedback({ type: 'report_accuracy', signal, targetTwinId: profile.id, targetOwner: profile.owner, targetName: profile.name, score: profile.compatibility, note: profile.report?.summary });
      setReportFeedbackIds((prev) => {
        const next = Array.from(new Set([...prev, profile.id]));
        AsyncStorage.setItem(REPORT_FEEDBACK_KEY, JSON.stringify(next)).catch(console.warn);
        return next;
      });
    } catch (feedbackError) {
      console.warn('Report feedback failed:', feedbackError);
      showNotice('Feedback failed', 'Could not save this scout report signal.');
    } finally {
      setIsWritingReportFeedback(null);
    }
  };

  const renderProfileCard = ({ item, index }: { item: Profile; index: number }) => {
    const isTopCard = index === 0;
    const isUnlocked = unlockedProfileIds.includes(item.id);
    const isFocusedProfile = activeProposal?.candidateTwinId === item.id;
    const humanMatch = findHumanMatchForProfile(humanMatches, item);
    const hasReportFeedback = reportFeedbackIds.includes(item.id);
    const isSavingReportFeedback = isWritingReportFeedback === item.id;
    const scoreColor = item.compatibility >= 85 ? '#4ade80' : item.compatibility >= 70 ? '#D94A8C' : '#A299A8';

    return (
      <View style={[styles.card, isTopCard && styles.focusCard]}>
        <LinearGradient
          colors={isTopCard ? ['rgba(217,74,140,0.18)', 'rgba(122,62,184,0.10)', 'rgba(13,11,16,0.98)'] : ['rgba(30,24,38,0.95)', 'rgba(13,11,16,0.98)']}
          start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
          style={styles.cardGradient}
        >
          <View style={styles.cardHeader}>
            <View style={styles.avatar}>
              <Image source={{ uri: item.photoUrl }} style={styles.avatarImage} blurRadius={isUnlocked ? 0 : 18} />
              {!isUnlocked && (
                <View style={styles.lockOverlay}>
                  <Text style={styles.lockIcon}>🔒</Text>
                </View>
              )}
            </View>
            <View style={styles.profileInfo}>
              <View style={styles.nameRow}>
                <Text style={styles.profileName}>{item.name}{item.age > 0 ? `, ${item.age}` : ''}</Text>
                <View style={styles.zkBadge}><Text style={styles.zkBadgeText}>ZK</Text></View>
              </View>
              {item.location ? <Text style={styles.location}>📍 {item.location}</Text> : null}
              <Text style={styles.bio} numberOfLines={2}>{item.bio}</Text>
              <Text style={[styles.statusHint, humanMatch || isFocusedProfile || isUnlocked ? styles.hintGreen : styles.hintMuted]}>
                {humanMatch ? '✦ Human match — open chat' : isFocusedProfile ? '✦ Your Twin is focused here' : isUnlocked ? '✦ Human profile unlocked' : '· Chat to unlock profile'}
              </Text>
            </View>
            <View style={[styles.scorePill, { borderColor: scoreColor + '55' }]}>
              <Text style={[styles.scoreValue, { color: scoreColor }]}>{item.compatibility}%</Text>
              <Text style={styles.scoreLabel}>match</Text>
            </View>
          </View>

          {isTopCard && (
            <>
              <View style={styles.divider} />
              <View style={styles.reportBox}>
                {item.report ? (
                  <>
                    <Text style={styles.reportTitle}>Your Twin's Scout Report · {item.report.score}% match</Text>
                    <View style={styles.reportLine}><Text style={styles.reportLineText}>{item.report.summary}</Text></View>
                    {item.report.reasons.map((reason, i) => (
                      <View key={`r-${i}`} style={styles.reportLine}>
                        <Text style={styles.reportLineMuted}>Why: </Text>
                        <Text style={styles.reportLineText}>{reason}</Text>
                      </View>
                    ))}
                    {item.report.risks.slice(0, 1).map((risk, i) => (
                      <View key={`risk-${i}`} style={[styles.reportLine, styles.reportLineRisk]}>
                        <Text style={styles.reportLineMuted}>Watch-out: </Text>
                        <Text style={styles.reportLineText}>{risk}</Text>
                      </View>
                    ))}
                    <View style={[styles.reportLine, styles.reportLineOpener]}>
                      <Text style={styles.reportLineMuted}>Opener: </Text>
                      <Text style={styles.reportLineText}>{item.report.suggestedOpener}</Text>
                    </View>
                    <View style={styles.reportFeedbackBox}>
                      {hasReportFeedback ? (
                        <Text style={styles.reportFeedbackDone}>Your Twin learned from this report.</Text>
                      ) : (
                        <>
                          <Text style={styles.reportFeedbackTitle}>Was this scout report accurate?</Text>
                          <View style={styles.reportFeedbackActions}>
                            {REPORT_FEEDBACK_OPTIONS.map((option) => (
                              <TouchableOpacity
                                key={option.signal}
                                style={[styles.reportFeedbackButton, isSavingReportFeedback && styles.reportFeedbackButtonDisabled]}
                                onPress={() => handleReportAccuracyFeedback(item, option.signal)}
                                disabled={isSavingReportFeedback}
                                activeOpacity={0.8}
                              >
                                <Text style={styles.reportFeedbackButtonText}>{isSavingReportFeedback ? 'Saving...' : option.label}</Text>
                              </TouchableOpacity>
                            ))}
                          </View>
                        </>
                      )}
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.reportTitle}>Overheard: Your Agent &amp; {item.name}'s Agent</Text>
                    {item.overheard.map((line, i) => (
                      <View key={i} style={styles.reportLine}><Text style={styles.reportLineText}>{line}</Text></View>
                    ))}
                  </>
                )}
              </View>
              <Text style={styles.refText}>
                Scout ref: {item.scoutRef.slice(0, 14)}…{item.reportRef ? ` · Report: ${item.reportRef.slice(0, 14)}…` : ''}
              </Text>
              <View style={styles.actionRow}>
                <TouchableOpacity style={styles.passButton} onPress={() => handlePass(item.id)} activeOpacity={0.8}>
                  <Text style={styles.passButtonText}>Pass</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.chatButtonWrap} onPress={() => handleChatWithAgent(item)} activeOpacity={0.88}>
                  <LinearGradient
                    colors={isFocusedProfile || humanMatch ? ['#2ecc71', '#1a9950'] : ['#D94A8C', '#7A3EB8']}
                    start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                    style={styles.chatButtonGradient}
                  >
                    <Text style={styles.chatButtonText}>
                      {humanMatch ? 'Open Human Chat' : isFocusedProfile ? 'Open Focus Chat' : isUnlocked ? 'Continue Chat' : 'Chat with Agent'}
                    </Text>
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </>
          )}
        </LinearGradient>
      </View>
    );
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#D94A8C" size="large" />
          <Text style={styles.loadingText}>Scouting the Twin Pool…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (hasLocalTwin === false) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.noSessionContainer}>
          <Text style={styles.logoText}>Chaptr.</Text>
          <Text style={styles.noSessionTitle}>Create your Twin first</Text>
          <Text style={styles.noSessionBody}>
            This browser doesn't have a local Chaptr identity yet. Create your Twin to scout, chat, and receive proposals.
          </Text>
          <TouchableOpacity style={styles.primaryButtonWrap} onPress={() => router.replace('/' as Href)} activeOpacity={0.9}>
            <LinearGradient colors={['#D94A8C', '#7A3EB8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.primaryButtonGradient}>
              <Text style={styles.primaryButtonText}>Connect with Google</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.headerRow}>
          <Text style={styles.logoText}>Chaptr.</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={[styles.pillButton, styles.pillButtonActivity]}
              onPress={() => setShowActivityLog(true)}
              activeOpacity={0.85}
            >
              <Text style={[styles.pillButtonText, styles.pillButtonActivityText]}>🤖 Activity</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.pillButton, { borderColor: 'rgba(122,62,184,0.4)', backgroundColor: 'rgba(122,62,184,0.08)' }]} onPress={() => router.push('/judge' as Href)} activeOpacity={0.85}>
              <Text style={[styles.pillButtonText, { color: '#a78bfa' }]}>🏛 Judge</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.pillButton} onPress={openTraining} activeOpacity={0.85}>
              <Text style={styles.pillButtonText}>Training</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.pillButton} onPress={openProposals} activeOpacity={0.85}>
              <Text style={styles.pillButtonText}>Proposals</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.pillButton, styles.pillButtonDanger]} onPress={handleLogout} disabled={isLoggingOut} activeOpacity={0.85}>
              <Text style={[styles.pillButtonText, styles.pillButtonDangerText]}>{isLoggingOut ? 'Leaving…' : 'Log Out'}</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Active Human Match Banner */}
        {activeHumanMatch ? (
          <View style={styles.matchBannerOuter}>
            <LinearGradient
              colors={['rgba(74,222,128,0.14)', 'rgba(217,74,140,0.10)', 'rgba(18,15,24,0.97)']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.matchBannerGradient}
            >
              <View style={styles.matchBannerTopRow}>
                <Text style={styles.matchBannerKicker}>CURRENT MATCH</Text>
                <View style={styles.livePill}>
                  <View style={styles.liveDot} />
                  <Text style={styles.livePillText}>LIVE</Text>
                </View>
              </View>
              <View style={styles.matchIdentityRow}>
                <View style={styles.matchAvatar}>
                  <Text style={styles.matchAvatarInitial}>{getInitial(activeHumanMatch.participantName)}</Text>
                </View>
                <View style={styles.matchIdentityText}>
                  <Text style={styles.matchBannerName}>{activeHumanMatch.participantName} is your current chapter.</Text>
                  <View style={styles.matchMetaRow}>
                    <View style={styles.metaPill}><Text style={styles.metaPillText}>1 active match</Text></View>
                    <View style={styles.metaPill}><Text style={styles.metaPillText}>Sui locked</Text></View>
                  </View>
                </View>
              </View>
              <View style={styles.matchBannerActions}>
                <TouchableOpacity style={styles.matchChatButtonWrap} onPress={openCurrentHumanMatch} activeOpacity={0.88}>
                  <LinearGradient colors={['#D94A8C', '#7A3EB8']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.matchChatGradient}>
                    <Text style={styles.matchChatText}>Open Human Chat</Text>
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity style={styles.endMatchButton} onPress={handleEndActiveMatch} disabled={isEndingMatch} activeOpacity={0.8}>
                  <Text style={styles.endMatchText}>{isEndingMatch ? 'Ending…' : 'End Match'}</Text>
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </View>
        ) : activeProposal ? (
          <View style={styles.focusBannerOuter}>
            <LinearGradient colors={['rgba(74,222,128,0.10)', 'rgba(13,11,16,0.97)']} style={styles.focusBannerGradient}>
              <View style={styles.focusTopRow}>
                <Text style={styles.focusKicker}>FOCUS MODE</Text>
                <View style={styles.focusBadge}><Text style={styles.focusBadgeText}>Pending</Text></View>
              </View>
              <Text style={styles.focusTitle}>Your Twin is focused on {activeProposal.candidateName}.</Text>
              <Text style={styles.focusBody}>You can browse and chat, but cannot propose again until this resolves.</Text>
              <View style={styles.focusActions}>
                <TouchableOpacity style={styles.focusActionPrimary} onPress={openActiveProposal} activeOpacity={0.85}>
                  <Text style={styles.focusActionPrimaryText}>Open Focus Chat</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.focusActionSecondary} onPress={handleWithdrawActiveProposal} disabled={isWithdrawing} activeOpacity={0.8}>
                  <Text style={styles.focusActionSecondaryText}>{isWithdrawing ? 'Withdrawing…' : 'Withdraw'}</Text>
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </View>
        ) : null}

        {/* Morning Briefing Header */}
        <View style={styles.briefingHeaderRow}>
          <View>
            <Text style={styles.briefingTitle}>Your Morning Briefing</Text>
            <Text style={styles.briefingSubtitle}>
              {topConnections.length > 0
                ? `Your Twin scouted ${topConnections.length} compatible profile${topConnections.length === 1 ? '' : 's'} from the pool.`
                : 'Your Agent is waiting for compatible Twins to join the pool.'}
            </Text>
          </View>
          <Text style={styles.briefingClock}>
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <FlatList
          data={topConnections}
          keyExtractor={(item) => item.id}
          renderItem={renderProfileCard}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          extraData={`${passedProfileIds.join(',')}-${unlockedProfileIds.join(',')}-${humanMatches.map((m) => m.matchId ?? m.proposalId).join(',')}-${activeProposal?.candidateTwinId ?? ''}-${reportFeedbackIds.join(',')}-${isWritingReportFeedback ?? ''}`}
          ListEmptyComponent={
            !error ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No compatible Twins yet</Text>
                <Text style={styles.emptyBody}>The pool may be empty, filtered by preferences, or only contain your own Twin.</Text>
              </View>
            ) : null
          }
        />
      </View>

      {/* Activity Log Modal */}
      <ActivityLogModal
        visible={showActivityLog}
        onClose={() => setShowActivityLog(false)}
        poolScanLog={poolScanLog}
      />
    </SafeAreaView>
  );
}

// ─── Modal Styles ─────────────────────────────────────────────────────────────

const modalStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: '#12101A',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderColor: 'rgba(217,74,140,0.25)',
    maxHeight: '80%',
    paddingBottom: 32,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: '#333', alignSelf: 'center', marginTop: 12, marginBottom: 4 },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  title: { color: '#FDFBF7', fontSize: 18, fontWeight: '800' },
  subtitle: { color: '#6B6478', fontSize: 12, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#1E1B26', alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { color: '#888', fontSize: 13, fontWeight: '700' },
  scroll: { padding: 20, gap: 12 },
  emptyState: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  emptyIcon: { fontSize: 36 },
  emptyTitle: { color: '#FDFBF7', fontSize: 16, fontWeight: '800' },
  emptyBody: { color: '#6B6478', fontSize: 13, textAlign: 'center', lineHeight: 18 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
  sectionIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(217,74,140,0.15)', borderWidth: 1, borderColor: 'rgba(217,74,140,0.3)', alignItems: 'center', justifyContent: 'center' },
  sectionIcon: { fontSize: 18 },
  sectionTitle: { color: '#FDFBF7', fontSize: 15, fontWeight: '800' },
  sectionTime: { color: '#6B6478', fontSize: 12, marginTop: 1 },
  statRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: 12 },
  statIcon: { fontSize: 16 },
  statLabel: { color: '#A299A8', fontSize: 13 },
  statNumber: { color: '#FDFBF7', fontWeight: '800' },
  groupLabel: { color: '#4A4356', fontSize: 10, fontWeight: '900', letterSpacing: 1.5, marginTop: 8, marginBottom: 4 },
  filteredRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', marginBottom: 6 },
  filteredIcon: { fontSize: 16, width: 24, textAlign: 'center' },
  filteredContent: { flex: 1 },
  filteredReason: { color: '#C8C0CE', fontSize: 13, fontWeight: '600' },
  filteredOwner: { color: '#4A4356', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 2 },
  reasonBadge: { borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: 'rgba(255,255,255,0.06)' },
  badge_self: { backgroundColor: 'rgba(168,85,247,0.15)' },
  badge_matched: { backgroundColor: 'rgba(74,222,128,0.12)' },
  badge_gender_mismatch: { backgroundColor: 'rgba(251,191,36,0.12)' },
  badge_blocked_hidden: { backgroundColor: 'rgba(248,113,113,0.12)' },
  badge_fetch_failed: { backgroundColor: 'rgba(248,113,113,0.12)' },
  reasonBadgeText: { color: '#888', fontSize: 10, fontWeight: '700' },
  passedRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', backgroundColor: 'rgba(74,222,128,0.06)', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: 'rgba(74,222,128,0.2)', marginBottom: 6 },
  passedLeft: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, flex: 1 },
  passedIcon: { color: '#4ade80', fontSize: 14, marginTop: 2 },
  passedName: { color: '#FDFBF7', fontSize: 14, fontWeight: '700', marginBottom: 4 },
  passedLinks: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  a2aSummaryText: { color: '#6B6478', fontSize: 11, marginTop: 6, lineHeight: 16 },
  linkBtn: { borderRadius: 6, borderWidth: 1, borderColor: 'rgba(74,222,128,0.35)', paddingHorizontal: 8, paddingVertical: 3, backgroundColor: 'rgba(74,222,128,0.08)' },
  linkBtnText: { color: '#4ade80', fontSize: 10, fontWeight: '700' },
  scorePill: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)', alignItems: 'center' },
  scoreText: { color: '#4ade80', fontSize: 13, fontWeight: '900' },
  summaryBox: { borderRadius: 14, padding: 14, backgroundColor: 'rgba(217,74,140,0.07)', borderWidth: 1, borderColor: 'rgba(217,74,140,0.2)', marginTop: 8 },
  summaryText: { color: '#A299A8', fontSize: 13, lineHeight: 20 },
  summaryBold: { color: '#FDFBF7', fontWeight: '800' },
});

// ─── Main Styles ──────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: '#A299A8', fontSize: 14, letterSpacing: 0.3 },
  noSessionContainer: { flex: 1, maxWidth: 520, alignSelf: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  noSessionTitle: { color: '#FDFBF7', fontSize: 28, fontWeight: '900', textAlign: 'center', marginBottom: 10 },
  noSessionBody: { color: '#A299A8', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 28 },
  primaryButtonWrap: { height: 52, borderRadius: 18, overflow: 'hidden' },
  primaryButtonGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  container: { flex: 1, maxWidth: 620, alignSelf: 'center', width: '100%', paddingHorizontal: 16, paddingTop: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12 },
  logoText: { color: '#FDFBF7', fontSize: 22, fontWeight: '800', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', letterSpacing: 0.4 },
  headerActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' },
  pillButton: { borderWidth: 1, borderColor: '#2A2432', backgroundColor: '#16131A', borderRadius: 999, paddingHorizontal: 13, paddingVertical: 7 },
  pillButtonText: { color: '#A299A8', fontSize: 12, fontWeight: '700' },
  pillButtonActivity: { borderColor: 'rgba(217,74,140,0.45)', backgroundColor: 'rgba(217,74,140,0.08)' },
  pillButtonActivityText: { color: '#E91E8C' },
  pillButtonDanger: { borderColor: 'rgba(248,113,113,0.35)' },
  pillButtonDangerText: { color: '#f87171' },
  matchBannerOuter: { borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(74,222,128,0.38)', marginBottom: 18, shadowColor: '#4ade80', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.18, shadowRadius: 16, elevation: 8 },
  matchBannerGradient: { padding: 18 },
  matchBannerTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 },
  matchBannerKicker: { color: '#4ade80', fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: 'rgba(74,222,128,0.5)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: 'rgba(74,222,128,0.10)' },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ade80' },
  livePillText: { color: '#4ade80', fontSize: 10, fontWeight: '900', letterSpacing: 1.5 },
  matchIdentityRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
  matchAvatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(217,74,140,0.22)', borderWidth: 2, borderColor: 'rgba(217,74,140,0.55)', alignItems: 'center', justifyContent: 'center' },
  matchAvatarInitial: { color: '#FDFBF7', fontSize: 22, fontWeight: '900' },
  matchIdentityText: { flex: 1 },
  matchBannerName: { color: '#FDFBF7', fontSize: 17, fontWeight: '800', lineHeight: 22, marginBottom: 8 },
  matchMetaRow: { flexDirection: 'row', gap: 8 },
  metaPill: { borderRadius: 999, borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)', backgroundColor: 'rgba(74,222,128,0.07)', paddingHorizontal: 9, paddingVertical: 3 },
  metaPillText: { color: '#a7f3d0', fontSize: 11, fontWeight: '700' },
  matchBannerActions: { flexDirection: 'row', gap: 10 },
  matchChatButtonWrap: { flex: 2, height: 48, borderRadius: 16, overflow: 'hidden', shadowColor: '#D94A8C', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.45, shadowRadius: 12, elevation: 6 },
  matchChatGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  matchChatText: { color: '#FFF', fontSize: 14, fontWeight: '900', letterSpacing: 0.3 },
  endMatchButton: { flex: 1, height: 48, borderRadius: 16, borderWidth: 1, borderColor: 'rgba(248,113,113,0.55)', backgroundColor: 'rgba(248,113,113,0.08)', alignItems: 'center', justifyContent: 'center' },
  endMatchText: { color: '#fca5a5', fontSize: 13, fontWeight: '900' },
  focusBannerOuter: { borderRadius: 20, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(74,222,128,0.32)', marginBottom: 18 },
  focusBannerGradient: { padding: 16 },
  focusTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  focusKicker: { color: '#4ade80', fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  focusBadge: { borderRadius: 999, borderWidth: 1, borderColor: 'rgba(74,222,128,0.35)', paddingHorizontal: 9, paddingVertical: 3, backgroundColor: 'rgba(74,222,128,0.08)' },
  focusBadgeText: { color: '#a7f3d0', fontSize: 11, fontWeight: '700' },
  focusTitle: { color: '#FDFBF7', fontSize: 16, fontWeight: '800', marginBottom: 4 },
  focusBody: { color: '#8DA89A', fontSize: 12, lineHeight: 17, marginBottom: 12 },
  focusActions: { flexDirection: 'row', gap: 10 },
  focusActionPrimary: { flex: 1, height: 42, borderRadius: 13, borderWidth: 1, borderColor: 'rgba(74,222,128,0.42)', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(74,222,128,0.08)' },
  focusActionPrimaryText: { color: '#d1fae5', fontSize: 13, fontWeight: '800' },
  focusActionSecondary: { flex: 1, height: 42, borderRadius: 13, borderWidth: 1, borderColor: 'rgba(248,113,113,0.45)', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(248,113,113,0.08)' },
  focusActionSecondaryText: { color: '#fecaca', fontSize: 13, fontWeight: '800' },
  briefingHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14, gap: 10 },
  briefingTitle: { color: '#FDFBF7', fontSize: 24, fontWeight: '800' },
  briefingSubtitle: { color: '#A299A8', fontSize: 13, lineHeight: 19, marginTop: 4, maxWidth: 300 },
  briefingClock: { color: '#D94A8C', fontSize: 13, fontWeight: '700', letterSpacing: 0.8, marginTop: 4 },
  errorText: { color: '#D94A8C', fontSize: 13, textAlign: 'center', marginBottom: 10 },
  listContent: { paddingBottom: 32, gap: 14 },
  card: { borderRadius: 22, overflow: 'hidden', borderWidth: 1, borderColor: '#231E2C' },
  focusCard: { borderColor: 'rgba(217,74,140,0.48)', shadowColor: '#D94A8C', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.22, shadowRadius: 18, elevation: 8 },
  cardGradient: { padding: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  avatar: { width: 68, height: 80, borderRadius: 18, overflow: 'hidden', backgroundColor: '#2A2432', borderWidth: 1, borderColor: 'rgba(217,74,140,0.32)' },
  avatarImage: { width: '100%', height: '100%' },
  lockOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(13,11,16,0.45)', alignItems: 'center', justifyContent: 'center' },
  lockIcon: { fontSize: 20 },
  profileInfo: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  profileName: { color: '#FDFBF7', fontSize: 18, fontWeight: '800' },
  zkBadge: { borderWidth: 1, borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.10)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  zkBadgeText: { color: '#4ade80', fontSize: 10, fontWeight: '800' },
  location: { color: '#7A7085', fontSize: 12, marginTop: 4 },
  bio: { color: '#C8C0CE', fontSize: 13, lineHeight: 18, marginTop: 5 },
  statusHint: { fontSize: 12, marginTop: 7, fontWeight: '700' },
  hintGreen: { color: '#4ade80' },
  hintMuted: { color: '#55505e' },
  scorePill: { alignItems: 'center', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1 },
  scoreValue: { fontSize: 15, fontWeight: '900' },
  scoreLabel: { color: '#A299A8', fontSize: 10, marginTop: 1 },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 14 },
  reportBox: { borderRadius: 16, borderWidth: 1, borderColor: 'rgba(217,74,140,0.28)', backgroundColor: 'rgba(217,74,140,0.06)', padding: 14, gap: 8 },
  reportTitle: { color: '#FDFBF7', fontSize: 12, fontWeight: '800', marginBottom: 2 },
  reportLine: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: 'rgba(13,11,16,0.55)', flexDirection: 'row', flexWrap: 'wrap' },
  reportLineRisk: { borderWidth: 1, borderColor: 'rgba(248,113,113,0.2)' },
  reportLineOpener: { borderWidth: 1, borderColor: 'rgba(74,222,128,0.2)' },
  reportLineMuted: { color: '#7A7085', fontSize: 12, fontWeight: '700' },
  reportLineText: { color: '#DDD6E0', fontSize: 12, lineHeight: 17, flex: 1 },
  reportFeedbackBox: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', marginTop: 10, paddingTop: 10 },
  reportFeedbackTitle: { color: '#A299A8', fontSize: 12, fontWeight: '800', marginBottom: 8 },
  reportFeedbackActions: { flexDirection: 'row', gap: 8 },
  reportFeedbackButton: { flex: 1, minHeight: 36, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(217,74,140,0.34)', backgroundColor: 'rgba(217,74,140,0.08)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  reportFeedbackButtonDisabled: { opacity: 0.55 },
  reportFeedbackButtonText: { color: '#f9a8d4', fontSize: 11, fontWeight: '900' },
  reportFeedbackDone: { color: '#4ade80', fontSize: 12, fontWeight: '900' },
  refText: { color: '#4A4356', fontSize: 11, marginTop: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  actionRow: { marginTop: 14, gap: 10 },
  passButton: { height: 46, borderRadius: 15, borderWidth: 1, borderColor: '#302840', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.03)' },
  passButtonText: { color: '#C0B8C8', fontSize: 14, fontWeight: '700' },
  chatButtonWrap: { height: 50, borderRadius: 16, overflow: 'hidden' },
  chatButtonGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chatButtonText: { color: '#FFF', fontSize: 15, fontWeight: '800' },
  emptyState: { marginTop: 60, alignItems: 'center', paddingHorizontal: 24 },
  emptyTitle: { color: '#FDFBF7', fontSize: 20, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: '#A299A8', fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
});