import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { Transaction } from '@mysten/sui/transactions';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { buildEndMatchTx, buildWithdrawProposalTx } from '@/utils/suiTransactions';
import {
  fetchZkProof,
  loadZkLoginParams,
  setupZkLoginParams,
} from '@/utils/zkLoginService';
import {
  formatScoutCapsuleForPrompt,
  loadLocalScoutCapsule,
  type ScoutCapsule,
} from '@/utils/twinMemory';
import { syncHumanMatchesFromSui } from '@/utils/matchSync';

const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';
const TWIN_POOL_ID = process.env.EXPO_PUBLIC_TWIN_POOL_ID || '';
const PACKAGE_ID = process.env.EXPO_PUBLIC_PACKAGE_ID || '';
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash-lite';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

const PASSED_PROFILES_KEY = 'chaptr:passed-profiles';
const UNLOCKED_PROFILES_KEY = 'chaptr:unlocked-profiles';
const ACTIVE_PROPOSAL_KEY = 'chaptr:active-proposal';
const HUMAN_MATCHES_KEY = 'chaptr:human-matches';

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const scoutReportKey = (candidateTwinId: string) =>
  `chaptr:scout-report:v2:${candidateTwinId}`;

const SCOUT_REPORT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    score: { type: 'INTEGER' },
    summary: { type: 'STRING' },
    reasons: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    risks: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    suggestedOpener: { type: 'STRING' },
  },
  required: ['score', 'summary', 'reasons', 'risks', 'suggestedOpener'],
  propertyOrdering: ['score', 'summary', 'reasons', 'risks', 'suggestedOpener'],
};

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

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
    const candidates = [
      parsed.proposalId,
      parsed.proposal_id,
      parsed.id,
      parsed.proposal?.id,
      parsed.proposal?.objectId,
    ];

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
  ) {
    return null;
  }

  const parsed = event.parsedJson ?? {};

  return {
    proposalId:
      firstValue(parsed.proposal_id, parsed.proposalId, parsed.proposal?.id) || null,
    matchId:
      firstValue(
        parsed.match_id,
        parsed.matchId,
        parsed.match?.id,
        parsed.id,
      ) || null,
    from:
      firstValue(
        parsed.from,
        parsed.proposer,
        parsed.sender,
        parsed.participant_a,
        parsed.owner_a,
        parsed.agent_a_owner,
        parsed.user_a,
      ) || null,
    to:
      firstValue(
        parsed.to,
        parsed.receiver,
        parsed.target,
        parsed.participant_b,
        parsed.owner_b,
        parsed.agent_b_owner,
        parsed.user_b,
      ) || null,
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
        (sameAddress(event.from, myOwner) &&
          sameAddress(event.to, syncedProposal.candidateOwner)) ||
        (sameAddress(event.to, myOwner) &&
          sameAddress(event.from, syncedProposal.candidateOwner));

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

const getJwtForTransaction = async (): Promise<string> => {
  if (!GOOGLE_CLIENT_ID) throw new Error('Missing EXPO_PUBLIC_GOOGLE_CLIENT_ID');

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
  if (!result.params.id_token) throw new Error('No id_token in Google response');

  return result.params.id_token;
};

const executeZkLoginTransaction = async (
  tx: Transaction,
  expectedOwner: string,
  jwt: string,
) => {
  const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
  const { zkProof, addressSeed, userAddress } = await fetchZkProof(
    jwt,
    ephemeralKeyPair,
    maxEpoch,
    randomness,
  );

  if (userAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error('Selected Google account does not match this browser identity.');
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

const cleanPhrase = (value?: string | null) =>
  (value ?? '')
    .trim()
    .replace(/[.!?]+$/g, '')
    .toLowerCase();

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

const readActiveProposal = async (): Promise<ActiveProposal | null> => {
  const raw = await AsyncStorage.getItem(ACTIVE_PROPOSAL_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const readHumanMatches = async (): Promise<HumanMatch[]> => {
  const raw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const findHumanMatchForProfile = (
  matches: HumanMatch[],
  profile: Pick<Profile, 'id' | 'owner'>,
) =>
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

const fetchScoutProfile = async (blobId: string): Promise<ScoutProfile> => {
  const res = await fetch(blobUrl(blobId));

  if (!res.ok) {
    throw new Error(`Walrus fetch failed for ${blobId}: ${res.status}`);
  }

  return res.json();
};

const extractBlobId = (result: any): string | null => {
  return result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? null;
};

const uploadJsonToWalrus = async (payload: unknown): Promise<string> => {
  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=10`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Walrus report upload failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const blobId = extractBlobId(result);

  if (!blobId) {
    throw new Error(`No report blobId in Walrus response: ${JSON.stringify(result)}`);
  }

  return blobId;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
};

const fallbackScoutReport = (
  myScout: ScoutProfile,
  candidateScout: ScoutProfile,
): ScoutReport => {
  const score = cleanPhrase(candidateScout.lookingFor) === cleanPhrase(myScout.lookingFor) ? 86 : 78;
  const name = candidateScout.displayName || 'this person';
  const lookingFor = cleanPhrase(candidateScout.lookingFor);
  const mustHave = cleanPhrase(candidateScout.mustHave);
  const dealBreaker = cleanPhrase(candidateScout.dealBreaker);

  return {
    score,
    summary: `Your Twin found a promising early signal with ${name}.`,
    reasons: [
      lookingFor
        ? `They are looking for ${lookingFor}, which gives your Twin a clear intent signal.`
        : 'Their dating intent is open enough to explore.',
      mustHave
        ? `They value ${mustHave}, which is useful for compatibility screening.`
        : 'Their profile has enough emotional context to start a conversation.',
    ],
    risks: [
      dealBreaker
        ? `Their hard no is ${dealBreaker}, so your Twin should check for that early.`
        : 'The report is based on profile data only, not a full conversation yet.',
    ],
    suggestedOpener: mustHave
      ? `What does ${mustHave} look like to you in dating?`
      : 'What are you hoping dating feels like at its best?',
  };
};

const normalizeScoutReport = (
  raw: any,
  myScout?: ScoutProfile,
  candidateScout?: ScoutProfile,
): ScoutReport => {
  const fallback =
    myScout && candidateScout
      ? fallbackScoutReport(myScout, candidateScout)
      : {
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
    summary:
      typeof raw?.summary === 'string' && raw.summary.trim()
        ? raw.summary.trim()
        : fallback.summary,
    reasons: reasons.length > 0 ? reasons : fallback.reasons,
    risks: risks.length > 0 ? risks : fallback.risks,
    suggestedOpener:
      typeof raw?.suggestedOpener === 'string' && raw.suggestedOpener.trim()
        ? raw.suggestedOpener.trim()
        : fallback.suggestedOpener,
  };
};

const parseGeminiJson = (text: string): any | null => {
  const cleaned = text
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const sliced = cleaned.slice(firstBrace, lastBrace + 1);

      try {
        return JSON.parse(sliced);
      } catch {
        console.warn('Gemini returned invalid JSON, using fallback report:', cleaned);
      }
    }

    return null;
  }
};

const generateScoutReport = async (
  myScout: ScoutProfile,
  candidateScout: ScoutProfile,
): Promise<ScoutReport> => {
  if (!GEMINI_API_KEY) {
    return fallbackScoutReport(myScout, candidateScout);
  }

  const prompt = `
You are Chaptr's scout report generator.

Compare the current user with the candidate Twin and return ONLY valid JSON.
Do not use markdown.
Do not wrap the JSON in backticks.
Do not include comments.
Use simple plain text. Avoid quotation marks inside string values.

Current user public-safe Scout Capsule:
${formatScoutCapsuleForPrompt(myScout.scoutCapsule)}

Candidate public-safe Scout Capsule:
${formatScoutCapsuleForPrompt(candidateScout.scoutCapsule)}

JSON shape:
{
  "score": 86,
  "summary": "One short sentence.",
  "reasons": ["Reason one.", "Reason two."],
  "risks": ["Risk one."],
  "suggestedOpener": "One natural dating app opener."
}

Current user scout profile:
${JSON.stringify(myScout, null, 2)}

Candidate scout profile:
${JSON.stringify(candidateScout, null, 2)}
`.trim();

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 600,
            responseMimeType: 'application/json',
            responseSchema: SCOUT_REPORT_SCHEMA,
          },
        }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data?.error?.message ?? `Gemini report failed: ${response.status}`);
    }

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

      return {
        report: normalizeScoutReport(parsed.report, myScout, candidateScout),
        reportRef: parsed.reportRef ?? null,
      };
    } catch {
      await AsyncStorage.removeItem(cacheKey);
    }
  }

  const report = await generateScoutReport(myScout, candidateScout);

  const reportPayload = {
    version: 1,
    kind: 'chaptr-scout-report',
    candidateTwinId,
    candidateScoutRef,
    report,
    createdAt: new Date().toISOString(),
  };

  let reportRef: string | null = null;

  try {
    reportRef = await uploadJsonToWalrus(reportPayload);
  } catch (error) {
    console.warn('Scout report Walrus upload failed:', error);
  }

  await AsyncStorage.setItem(
    cacheKey,
    JSON.stringify({
      report,
      reportRef,
      createdAt: reportPayload.createdAt,
    }),
  );

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

// ─── Avatar initial helper ────────────────────────────────────────────────────
const getInitial = (name: string) => (name ?? '?').charAt(0).toUpperCase();

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
  const [isEndingMatch, setIsEndingMatch] = useState(false);

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
      ] = await Promise.all([
        fetchPoolEntries(),
        AsyncStorage.getItem('chaptr:my-owner'),
        AsyncStorage.getItem('chaptr:my-gender'),
        AsyncStorage.getItem('chaptr:my-interested-in'),
        AsyncStorage.getItem('chaptr:my-scout-ref'),
        loadLocalScoutCapsule(),
      ]);

      if (entries.length === 0) {
        setProfiles([]);
        return;
      }

      const myPoolEntry = myOwner
        ? entries.find((entry) => entry.owner === myOwner)
        : null;

      const myScoutRef = storedMyScoutRef || myPoolEntry?.scout_ref || null;
      const fetchedMyScout = myScoutRef ? await fetchScoutProfile(myScoutRef).catch(() => null) : null;

      const myScout = fetchedMyScout
        ? {
            ...fetchedMyScout,
            scoutCapsule: fetchedMyScout.scoutCapsule ?? localScoutCapsule ?? undefined,
          }
        : null;

      const settled = await Promise.allSettled(
        entries.map(async (entry) => {
          if (myOwner && entry.owner === myOwner) return null;

          const scout = await fetchScoutProfile(entry.scout_ref);

          const theyWantMe = matchesInterest(scout.interestedIn, myGender);
          const iWantThem = matchesInterest(myInterestedIn, scout.gender);

          if (!theyWantMe || !iWantThem) return null;

          const baseProfile = entryToProfile(entry, scout);

          if (!myScout) return baseProfile;

          const { report, reportRef } = await loadOrCreateScoutReport(
            entry.twin_id,
            entry.scout_ref,
            myScout,
            scout,
          );

          return {
            ...baseProfile,
            compatibility: report.score,
            report,
            reportRef: reportRef ?? undefined,
          };
        }),
      );

      const resolved = settled
        .filter((r): r is PromiseFulfilledResult<Profile | null> => r.status === 'fulfilled')
        .map((r) => r.value)
        .filter((p): p is Profile => p !== null)
        .sort((a, b) => b.compatibility - a.compatibility);

      setProfiles(resolved);
    } catch (err: any) {
      console.error('Failed to load pool profiles:', err);
      setError('Could not load your briefing. Check your connection.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadSavedState = useCallback(async () => {
    const [passed, unlocked, proposal, myOwner] = await Promise.all([
      readStringArray(PASSED_PROFILES_KEY),
      readStringArray(UNLOCKED_PROFILES_KEY),
      readActiveProposal(),
      AsyncStorage.getItem('chaptr:my-owner'),
    ]);

    // Chain-first match discovery: works for both proposer and receiver in any browser.
    // Falls back to local storage if chain is unreachable.
    const chainMatches = myOwner
      ? await syncHumanMatchesFromSui(myOwner).catch((err) => {
          console.warn('[loadSavedState] chain sync failed, reading local:', err);
          return readHumanMatches();
        })
      : await readHumanMatches();

    // Still run the existing proposal-acceptance sync on top, passing chain matches in.
    const synced = await syncActiveProposalAcceptance(proposal, chainMatches, myOwner).catch(
      (error) => {
        console.warn('Accepted match sync failed:', error);
        return { proposal, matches: chainMatches };
      },
    );

    setPassedProfileIds(passed);
    setUnlockedProfileIds(unlocked);
    setActiveProposal(synced.proposal);
    setHumanMatches(synced.matches);
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

        await Promise.all([loadPoolProfiles(), loadSavedState()]);
      };

      setIsLoading(true);
      loadScreen().catch((error) => {
        console.warn(error);
        setHasLocalTwin(false);
        setIsLoading(false);
      });
    }, [loadPoolProfiles, loadSavedState]),
  );

  const topConnections = useMemo(
    () => profiles.filter((p) => !passedProfileIds.includes(p.id)),
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
      router.push({
        pathname: '/human-chat/[id]',
        params: {
          id: humanMatch.matchId ?? humanMatch.proposalId,
          name: humanMatch.participantName,
        },
      } as Href);
      return;
    }

    router.push({
      pathname: '/chat/[id]',
      params: {
        id: profile.id,
        scoutRef: profile.scoutRef,
        name: profile.name,
        owner: profile.owner,
        score: String(profile.compatibility),
      },
    } as Href);
  };

  const openProposals = () => {
    router.push('/proposals' as Href);
  };

  const openActiveProposal = () => {
    if (!activeProposal) return;

    const humanMatch = findHumanMatchForProfile(humanMatches, {
      id: activeProposal.candidateTwinId,
      owner: activeProposal.candidateOwner,
    });

    if (humanMatch) {
      router.push({
        pathname: '/human-chat/[id]',
        params: {
          id: humanMatch.matchId ?? humanMatch.proposalId,
          name: humanMatch.participantName,
        },
      } as Href);
      return;
    }

    router.push({
      pathname: '/chat/[id]',
      params: {
        id: activeProposal.candidateTwinId,
        scoutRef: activeProposal.candidateScoutRef ?? '',
        name: activeProposal.candidateName,
        owner: activeProposal.candidateOwner,
        score: String(activeProposal.score),
      },
    } as Href);
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

    const confirmed = await confirmAction(
      'Withdraw proposal?',
      `This releases your Twin from Focus Mode with ${activeProposal.candidateName}.`,
    );

    if (!confirmed) return;

    setIsWithdrawing(true);

    try {
      const myOwner = await AsyncStorage.getItem('chaptr:my-owner');
      if (!myOwner) throw new Error('Missing local owner address.');

      const proposalId = await resolveActiveProposalId(activeProposal);

      if (!proposalId) {
        throw new Error(
          'Could not find the proposal object ID. Send app/chat/[id].tsx so we can store proposalId when proposing.',
        );
      }

      const jwt = await getJwtForTransaction();
      const tx = buildWithdrawProposalTx(proposalId);

      await executeZkLoginTransaction(tx, myOwner, jwt);

      await AsyncStorage.removeItem(ACTIVE_PROPOSAL_KEY);
      setActiveProposal(null);

      showNotice('Proposal withdrawn', 'Your Twin is free to focus on someone new.');
    } catch (error: any) {
      showNotice('Withdraw failed', error?.message ?? 'Could not withdraw proposal.');
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

    router.push({
      pathname: '/human-chat/[id]',
      params: {
        id: activeHumanMatch.matchId ?? activeHumanMatch.proposalId,
        name: activeHumanMatch.participantName,
      },
    } as Href);
  }, [activeHumanMatch]);

  const handleEndActiveMatch = useCallback(async () => {
    if (!activeHumanMatch) return;

    const matchId = activeHumanMatch.matchId;

    if (!matchId) {
      showNotice(
        'Cannot end match yet',
        'This local match record is missing the on-chain Match ID. Accept a fresh proposal or resync this match first.',
      );
      return;
    }

    const confirmed = await confirmAction(
      'End current match?',
      `This ends your match with ${activeHumanMatch.participantName} and releases both Twins.`,
    );

    if (!confirmed) return;

    setIsEndingMatch(true);

    try {
      const myOwner = await AsyncStorage.getItem('chaptr:my-owner');
      if (!myOwner) throw new Error('Missing local owner address.');

      const jwt = await getJwtForTransaction();
      const tx = buildEndMatchTx(matchId);

      await executeZkLoginTransaction(tx, myOwner, jwt);

      const nextMatches = humanMatches.filter(
        (match) =>
          (match.matchId ?? match.proposalId) !==
          (activeHumanMatch.matchId ?? activeHumanMatch.proposalId),
      );

      await AsyncStorage.setItem(HUMAN_MATCHES_KEY, JSON.stringify(nextMatches));
      setHumanMatches(nextMatches);

      showNotice('Match ended', 'Both Twins are free again.');
    } catch (error: any) {
      showNotice('End match failed', error?.message ?? 'Could not end this match.');
    } finally {
      setIsEndingMatch(false);
    }
  }, [activeHumanMatch, humanMatches]);

  // ─── Profile card renderer ──────────────────────────────────────────────────
  const renderProfileCard = ({ item, index }: { item: Profile; index: number }) => {
    const isTopCard = index === 0;
    const isUnlocked = unlockedProfileIds.includes(item.id);
    const isFocusedProfile = activeProposal?.candidateTwinId === item.id;
    const humanMatch = findHumanMatchForProfile(humanMatches, item);

    const scoreColor =
      item.compatibility >= 85 ? '#4ade80' : item.compatibility >= 70 ? '#D94A8C' : '#A299A8';

    return (
      <View style={[styles.card, isTopCard && styles.focusCard]}>
        <LinearGradient
          colors={
            isTopCard
              ? ['rgba(217,74,140,0.18)', 'rgba(122,62,184,0.10)', 'rgba(13,11,16,0.98)']
              : ['rgba(30,24,38,0.95)', 'rgba(13,11,16,0.98)']
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.cardGradient}
        >
          {/* Top section */}
          <View style={styles.cardHeader}>
            {/* Avatar */}
            <View style={styles.avatar}>
              <Image
                source={{ uri: item.photoUrl }}
                style={styles.avatarImage}
                blurRadius={isUnlocked ? 0 : 18}
              />
              {!isUnlocked && (
                <View style={styles.lockOverlay}>
                  <Text style={styles.lockIcon}>🔒</Text>
                </View>
              )}
            </View>

            {/* Info */}
            <View style={styles.profileInfo}>
              <View style={styles.nameRow}>
                <Text style={styles.profileName}>
                  {item.name}{item.age > 0 ? `, ${item.age}` : ''}
                </Text>
                <View style={styles.zkBadge}>
                  <Text style={styles.zkBadgeText}>ZK</Text>
                </View>
              </View>

              {item.location ? (
                <Text style={styles.location}>📍 {item.location}</Text>
              ) : null}

              <Text style={styles.bio} numberOfLines={2}>{item.bio}</Text>

              <Text
                style={[
                  styles.statusHint,
                  humanMatch
                    ? styles.hintGreen
                    : isFocusedProfile
                    ? styles.hintGreen
                    : isUnlocked
                    ? styles.hintGreen
                    : styles.hintMuted,
                ]}
              >
                {humanMatch
                  ? '✦ Human match — open chat'
                  : isFocusedProfile
                  ? '✦ Your Twin is focused here'
                  : isUnlocked
                  ? '✦ Human profile unlocked'
                  : '· Chat to unlock profile'}
              </Text>
            </View>

            {/* Score pill */}
            <View style={[styles.scorePill, { borderColor: scoreColor + '55' }]}>
              <Text style={[styles.scoreValue, { color: scoreColor }]}>
                {item.compatibility}%
              </Text>
              <Text style={styles.scoreLabel}>match</Text>
            </View>
          </View>

          {/* Expanded content for top card */}
          {isTopCard && (
            <>
              <View style={styles.divider} />

              {/* Scout report / Overheard */}
              <View style={styles.reportBox}>
                {item.report ? (
                  <>
                    <Text style={styles.reportTitle}>
                      Your Twin's Scout Report · {item.report.score}% match
                    </Text>

                    <View style={styles.reportLine}>
                      <Text style={styles.reportLineText}>{item.report.summary}</Text>
                    </View>

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
                  </>
                ) : (
                  <>
                    <Text style={styles.reportTitle}>
                      Overheard: Your Agent &amp; {item.name}'s Agent
                    </Text>
                    {item.overheard.map((line, i) => (
                      <View key={i} style={styles.reportLine}>
                        <Text style={styles.reportLineText}>{line}</Text>
                      </View>
                    ))}
                  </>
                )}
              </View>

              <Text style={styles.refText}>
                Scout ref: {item.scoutRef.slice(0, 14)}…
                {item.reportRef ? ` · Report: ${item.reportRef.slice(0, 14)}…` : ''}
              </Text>

              {/* Action buttons */}
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.passButton}
                  onPress={() => handlePass(item.id)}
                  activeOpacity={0.8}
                >
                  <Text style={styles.passButtonText}>Pass</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.chatButtonWrap}
                  onPress={() => handleChatWithAgent(item)}
                  activeOpacity={0.88}
                >
                  <LinearGradient
                    colors={
                      isFocusedProfile || humanMatch
                        ? ['#2ecc71', '#1a9950']
                        : ['#D94A8C', '#7A3EB8']
                    }
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.chatButtonGradient}
                  >
                    <Text style={styles.chatButtonText}>
                      {humanMatch
                        ? 'Open Human Chat'
                        : isFocusedProfile
                        ? 'Open Focus Chat'
                        : isUnlocked
                        ? 'Continue Chat'
                        : 'Chat with Agent'}
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

  // ─── Loading state ──────────────────────────────────────────────────────────
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

  // ─── No twin ────────────────────────────────────────────────────────────────
  if (hasLocalTwin === false) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.noSessionContainer}>
          <Text style={styles.logoText}>Chaptr.</Text>
          <Text style={styles.noSessionTitle}>Create your Twin first</Text>
          <Text style={styles.noSessionBody}>
            This browser doesn't have a local Chaptr identity yet. Create your Twin to scout, chat, and receive proposals.
          </Text>

          <TouchableOpacity
            style={styles.primaryButtonWrap}
            onPress={() => router.replace('/' as Href)}
            activeOpacity={0.9}
          >
            <LinearGradient
              colors={['#D94A8C', '#7A3EB8']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.primaryButtonGradient}
            >
              <Text style={styles.primaryButtonText}>Connect with Google</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Main screen ────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.container}>

        {/* Header */}
        <View style={styles.headerRow}>
          <Text style={styles.logoText}>Chaptr.</Text>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.pillButton}
              onPress={openProposals}
              activeOpacity={0.85}
            >
              <Text style={styles.pillButtonText}>Proposals</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.pillButton, styles.pillButtonDanger]}
              onPress={handleLogout}
              disabled={isLoggingOut}
              activeOpacity={0.85}
            >
              <Text style={[styles.pillButtonText, styles.pillButtonDangerText]}>
                {isLoggingOut ? 'Leaving…' : 'Log Out'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Current Match Banner ── */}
        {activeHumanMatch ? (
          <View style={styles.matchBannerOuter}>
            <LinearGradient
              colors={['rgba(74,222,128,0.14)', 'rgba(217,74,140,0.10)', 'rgba(18,15,24,0.97)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.matchBannerGradient}
            >
              {/* Top row: label + LIVE pill */}
              <View style={styles.matchBannerTopRow}>
                <Text style={styles.matchBannerKicker}>CURRENT MATCH</Text>
                <View style={styles.livePill}>
                  <View style={styles.liveDot} />
                  <Text style={styles.livePillText}>LIVE</Text>
                </View>
              </View>

              {/* Avatar + name row */}
              <View style={styles.matchIdentityRow}>
                <View style={styles.matchAvatar}>
                  <Text style={styles.matchAvatarInitial}>
                    {getInitial(activeHumanMatch.participantName)}
                  </Text>
                </View>
                <View style={styles.matchIdentityText}>
                  <Text style={styles.matchBannerName}>
                    {activeHumanMatch.participantName} is your current chapter.
                  </Text>
                  <View style={styles.matchMetaRow}>
                    <View style={styles.metaPill}>
                      <Text style={styles.metaPillText}>1 active match</Text>
                    </View>
                    <View style={styles.metaPill}>
                      <Text style={styles.metaPillText}>Sui locked</Text>
                    </View>
                  </View>
                </View>
              </View>

              {/* Actions */}
              <View style={styles.matchBannerActions}>
                <TouchableOpacity
                  style={styles.matchChatButtonWrap}
                  onPress={openCurrentHumanMatch}
                  activeOpacity={0.88}
                >
                  <LinearGradient
                    colors={['#D94A8C', '#7A3EB8']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 0 }}
                    style={styles.matchChatGradient}
                  >
                    <Text style={styles.matchChatText}>Open Human Chat</Text>
                  </LinearGradient>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.endMatchButton}
                  onPress={handleEndActiveMatch}
                  disabled={isEndingMatch}
                  activeOpacity={0.8}
                >
                  <Text style={styles.endMatchText}>
                    {isEndingMatch ? 'Ending…' : 'End Match'}
                  </Text>
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </View>
        ) : activeProposal ? (
          /* ── Focus Mode Banner ── */
          <View style={styles.focusBannerOuter}>
            <LinearGradient
              colors={['rgba(74,222,128,0.10)', 'rgba(13,11,16,0.97)']}
              style={styles.focusBannerGradient}
            >
              <View style={styles.focusTopRow}>
                <Text style={styles.focusKicker}>FOCUS MODE</Text>
                <View style={styles.focusBadge}>
                  <Text style={styles.focusBadgeText}>Pending</Text>
                </View>
              </View>

              <Text style={styles.focusTitle}>
                Your Twin is focused on {activeProposal.candidateName}.
              </Text>
              <Text style={styles.focusBody}>
                You can browse and chat, but cannot propose again until this resolves.
              </Text>

              <View style={styles.focusActions}>
                <TouchableOpacity
                  style={styles.focusActionPrimary}
                  onPress={openActiveProposal}
                  activeOpacity={0.85}
                >
                  <Text style={styles.focusActionPrimaryText}>Open Focus Chat</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.focusActionSecondary}
                  onPress={handleWithdrawActiveProposal}
                  disabled={isWithdrawing}
                  activeOpacity={0.8}
                >
                  <Text style={styles.focusActionSecondaryText}>
                    {isWithdrawing ? 'Withdrawing…' : 'Withdraw'}
                  </Text>
                </TouchableOpacity>
              </View>
            </LinearGradient>
          </View>
        ) : null}

        {/* ── Morning Briefing header ── */}
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

        {/* ── Profile list ── */}
        <FlatList
          data={topConnections}
          keyExtractor={(item) => item.id}
          renderItem={renderProfileCard}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          extraData={`${passedProfileIds.join(',')}-${unlockedProfileIds.join(',')}-${humanMatches.map((m) => m.matchId ?? m.proposalId).join(',')}-${activeProposal?.candidateTwinId ?? ''}`}
          ListEmptyComponent={
            !error ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No compatible Twins yet</Text>
                <Text style={styles.emptyBody}>
                  The pool may be empty, filtered by preferences, or only contain your own Twin.
                </Text>
              </View>
            ) : null
          }
        />
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },

  // Loading
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: '#A299A8', fontSize: 14, letterSpacing: 0.3 },

  // No session
  noSessionContainer: {
    flex: 1,
    maxWidth: 520,
    alignSelf: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  noSessionTitle: {
    color: '#FDFBF7',
    fontSize: 28,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 10,
  },
  noSessionBody: {
    color: '#A299A8',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 28,
  },
  primaryButtonWrap: { height: 52, borderRadius: 18, overflow: 'hidden' },
  primaryButtonGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#FFF', fontSize: 16, fontWeight: '800' },

  // Main layout
  container: {
    flex: 1,
    maxWidth: 620,
    alignSelf: 'center',
    width: '100%',
    paddingHorizontal: 16,
    paddingTop: 12,
  },

  // Header row
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  logoText: {
    color: '#FDFBF7',
    fontSize: 22,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    letterSpacing: 0.4,
  },
  headerActions: { flexDirection: 'row', gap: 8 },
  pillButton: {
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#16131A',
    borderRadius: 999,
    paddingHorizontal: 13,
    paddingVertical: 7,
  },
  pillButtonText: { color: '#A299A8', fontSize: 12, fontWeight: '700' },
  pillButtonDanger: { borderColor: 'rgba(248,113,113,0.35)' },
  pillButtonDangerText: { color: '#f87171' },

  // ── Current Match Banner ──────────────────────────────────────────────────
  matchBannerOuter: {
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.38)',
    marginBottom: 18,
    // shadow
    shadowColor: '#4ade80',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
  },
  matchBannerGradient: {
    padding: 18,
  },
  matchBannerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  matchBannerKicker: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.5)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(74,222,128,0.10)',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#4ade80',
  },
  livePillText: {
    color: '#4ade80',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.5,
  },
  matchIdentityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 16,
  },
  matchAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(217,74,140,0.22)',
    borderWidth: 2,
    borderColor: 'rgba(217,74,140,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  matchAvatarInitial: {
    color: '#FDFBF7',
    fontSize: 22,
    fontWeight: '900',
  },
  matchIdentityText: { flex: 1 },
  matchBannerName: {
    color: '#FDFBF7',
    fontSize: 17,
    fontWeight: '800',
    lineHeight: 22,
    marginBottom: 8,
  },
  matchMetaRow: {
    flexDirection: 'row',
    gap: 8,
  },
  metaPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.28)',
    backgroundColor: 'rgba(74,222,128,0.07)',
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  metaPillText: {
    color: '#a7f3d0',
    fontSize: 11,
    fontWeight: '700',
  },
  matchBannerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  matchChatButtonWrap: {
    flex: 2,
    height: 48,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#D94A8C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius: 12,
    elevation: 6,
  },
  matchChatGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  matchChatText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  endMatchButton: {
    flex: 1,
    height: 48,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.55)',
    backgroundColor: 'rgba(248,113,113,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  endMatchText: {
    color: '#fca5a5',
    fontSize: 13,
    fontWeight: '900',
  },

  // ── Focus Banner ──────────────────────────────────────────────────────────
  focusBannerOuter: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.32)',
    marginBottom: 18,
  },
  focusBannerGradient: { padding: 16 },
  focusTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  focusKicker: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },
  focusBadge: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.35)',
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: 'rgba(74,222,128,0.08)',
  },
  focusBadgeText: { color: '#a7f3d0', fontSize: 11, fontWeight: '700' },
  focusTitle: { color: '#FDFBF7', fontSize: 16, fontWeight: '800', marginBottom: 4 },
  focusBody: { color: '#8DA89A', fontSize: 12, lineHeight: 17, marginBottom: 12 },
  focusActions: { flexDirection: 'row', gap: 10 },
  focusActionPrimary: {
    flex: 1,
    height: 42,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.42)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(74,222,128,0.08)',
  },
  focusActionPrimaryText: { color: '#d1fae5', fontSize: 13, fontWeight: '800' },
  focusActionSecondary: {
    flex: 1,
    height: 42,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(248,113,113,0.08)',
  },
  focusActionSecondaryText: { color: '#fecaca', fontSize: 13, fontWeight: '800' },

  // ── Briefing header ────────────────────────────────────────────────────────
  briefingHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 14,
    gap: 10,
  },
  briefingTitle: {
    color: '#FDFBF7',
    fontSize: 24,
    fontWeight: '800',
  },
  briefingSubtitle: {
    color: '#A299A8',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
    maxWidth: 300,
  },
  briefingClock: {
    color: '#D94A8C',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    marginTop: 4,
  },

  errorText: { color: '#D94A8C', fontSize: 13, textAlign: 'center', marginBottom: 10 },

  // ── Profile list ───────────────────────────────────────────────────────────
  listContent: { paddingBottom: 32, gap: 14 },

  card: {
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#231E2C',
  },
  focusCard: {
    borderColor: 'rgba(217,74,140,0.48)',
    shadowColor: '#D94A8C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 18,
    elevation: 8,
  },
  cardGradient: { padding: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },

  avatar: {
    width: 68,
    height: 80,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#2A2432',
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.32)',
  },
  avatarImage: { width: '100%', height: '100%' },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(13,11,16,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockIcon: { fontSize: 20 },

  profileInfo: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  profileName: { color: '#FDFBF7', fontSize: 18, fontWeight: '800' },
  zkBadge: {
    borderWidth: 1,
    borderColor: '#4ade80',
    backgroundColor: 'rgba(74,222,128,0.10)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  zkBadgeText: { color: '#4ade80', fontSize: 10, fontWeight: '800' },
  location: { color: '#7A7085', fontSize: 12, marginTop: 4 },
  bio: { color: '#C8C0CE', fontSize: 13, lineHeight: 18, marginTop: 5 },

  statusHint: { fontSize: 12, marginTop: 7, fontWeight: '700' },
  hintGreen: { color: '#4ade80' },
  hintMuted: { color: '#55505e' },

  scorePill: {
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
  },
  scoreValue: { fontSize: 15, fontWeight: '900' },
  scoreLabel: { color: '#A299A8', fontSize: 10, marginTop: 1 },

  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginVertical: 14,
  },

  // Report box
  reportBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.28)',
    backgroundColor: 'rgba(217,74,140,0.06)',
    padding: 14,
    gap: 8,
  },
  reportTitle: { color: '#FDFBF7', fontSize: 12, fontWeight: '800', marginBottom: 2 },
  reportLine: {
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(13,11,16,0.55)',
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  reportLineRisk: { borderWidth: 1, borderColor: 'rgba(248,113,113,0.2)' },
  reportLineOpener: { borderWidth: 1, borderColor: 'rgba(74,222,128,0.2)' },
  reportLineMuted: { color: '#7A7085', fontSize: 12, fontWeight: '700' },
  reportLineText: { color: '#DDD6E0', fontSize: 12, lineHeight: 17, flex: 1 },

  refText: {
    color: '#4A4356',
    fontSize: 11,
    marginTop: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Card actions
  actionRow: { marginTop: 14, gap: 10 },
  passButton: {
    height: 46,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#302840',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  passButtonText: { color: '#C0B8C8', fontSize: 14, fontWeight: '700' },
  chatButtonWrap: { height: 50, borderRadius: 16, overflow: 'hidden' },
  chatButtonGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chatButtonText: { color: '#FFF', fontSize: 15, fontWeight: '800' },

  // Empty state
  emptyState: { marginTop: 60, alignItems: 'center', paddingHorizontal: 24 },
  emptyTitle: { color: '#FDFBF7', fontSize: 20, fontWeight: '800', textAlign: 'center' },
  emptyBody: {
    color: '#A299A8',
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
});