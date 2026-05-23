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
import { buildWithdrawProposalTx } from '@/utils/suiTransactions';
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
      firstValue(
        parsed.proposal_id,
        parsed.proposalId,
        parsed.proposal?.id,
        parsed.match_id,
        parsed.matchId,
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
    throw new Error('Selected Google account does not match this local Chaptr identity.');
  }

  tx.setSender(expectedOwner);

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
    const [passed, unlocked, proposal, matches, myOwner] = await Promise.all([
      readStringArray(PASSED_PROFILES_KEY),
      readStringArray(UNLOCKED_PROFILES_KEY),
      readActiveProposal(),
      readHumanMatches(),
      AsyncStorage.getItem('chaptr:my-owner'),
    ]);

    const synced = await syncActiveProposalAcceptance(proposal, matches, myOwner).catch(
      (error) => {
        console.warn('Accepted match sync failed:', error);
        return { proposal, matches };
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
          id: humanMatch.proposalId,
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
        params: { id: humanMatch.proposalId, name: humanMatch.participantName },
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

  const renderProfileCard = ({ item, index }: { item: Profile; index: number }) => {
    const isTopCard = index === 0;
    const isUnlocked = unlockedProfileIds.includes(item.id);
    const isFocusedProfile = activeProposal?.candidateTwinId === item.id;
    const humanMatch = findHumanMatchForProfile(humanMatches, item);

    return (
      <View style={[styles.card, isTopCard && styles.focusCard]}>
        <LinearGradient
          colors={
            isTopCard
              ? ['rgba(217, 74, 140, 0.22)', 'rgba(18, 15, 24, 0.96)']
              : ['rgba(42, 36, 50, 0.9)', 'rgba(18, 15, 24, 0.96)']
          }
          style={styles.cardGradient}
        >
          <View style={styles.cardHeader}>
            <View style={styles.avatar}>
              <Image
                source={{ uri: item.photoUrl }}
                style={styles.avatarImage}
                blurRadius={isUnlocked ? 0 : 18}
              />

              {!isUnlocked && (
                <View style={styles.lockOverlay}>
                  <Text style={styles.lockText}>LOCKED</Text>
                </View>
              )}
            </View>

            <View style={styles.profileInfo}>
              <View style={styles.nameRow}>
                <Text style={styles.profileName}>
                  {item.name}
                  {item.age > 0 ? `, ${item.age}` : ''}
                </Text>

                <View style={styles.zkBadge}>
                  <Text style={styles.zkBadgeText}>ZK</Text>
                </View>
              </View>

              {item.location ? <Text style={styles.location}>{item.location}</Text> : null}

              <Text style={styles.bio} numberOfLines={3}>
                {item.bio}
              </Text>

              <Text style={humanMatch ? styles.unlockedHint : isFocusedProfile ? styles.focusHint : isUnlocked ? styles.unlockedHint : styles.lockedHint}>
                {humanMatch
                  ? 'Human match accepted — open human chat'
                  : isFocusedProfile
                    ? 'Your Twin is focused here'
                    : isUnlocked
                      ? 'Human profile unlocked'
                      : 'Chat to unlock human profile'}
              </Text>
            </View>

            <View style={styles.compatibilityPill}>
              <Text style={styles.compatibilityValue}>{item.compatibility}%</Text>
              <Text style={styles.compatibilityLabel}>match</Text>
            </View>
          </View>

          {isTopCard && (
            <>
              <View style={styles.overheardBox}>
                {item.report ? (
                  <>
                    <Text style={styles.overheardTitle}>
                      Your Twin's Scout Report · {item.report.score}% match
                    </Text>

                    <View style={styles.chatLine}>
                      <Text style={styles.chatLineText}>{item.report.summary}</Text>
                    </View>

                    {item.report.reasons.map((reason, i) => (
                      <View key={`reason-${i}`} style={styles.chatLine}>
                        <Text style={styles.chatLineText}>Why: {reason}</Text>
                      </View>
                    ))}

                    {item.report.risks.slice(0, 1).map((risk, i) => (
                      <View key={`risk-${i}`} style={styles.chatLine}>
                        <Text style={styles.chatLineText}>Watch-out: {risk}</Text>
                      </View>
                    ))}

                    <View style={styles.chatLine}>
                      <Text style={styles.chatLineText}>
                        Opener: {item.report.suggestedOpener}
                      </Text>
                    </View>
                  </>
                ) : (
                  <>
                    <Text style={styles.overheardTitle}>
                      Overheard: Your Agent and {item.name}'s Agent
                    </Text>

                    {item.overheard.map((line, i) => (
                      <View key={i} style={styles.chatLine}>
                        <Text style={styles.chatLineText}>{line}</Text>
                      </View>
                    ))}
                  </>
                )}
              </View>

              <Text style={styles.blobId}>
                Scout ref: {item.scoutRef.slice(0, 14)}...
                {item.reportRef ? ` · Report ref: ${item.reportRef.slice(0, 14)}...` : ''}
              </Text>

              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.passButton}
                  onPress={() => handlePass(item.id)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.passButtonText}>Pass</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.chatButton}
                  onPress={() => handleChatWithAgent(item)}
                  activeOpacity={0.9}
                >
                  <LinearGradient
                    colors={isFocusedProfile ? ['#4ade80', '#1f8f54'] : ['#D94A8C', '#7A3EB8']}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
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

  if (isLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#D94A8C" size="large" />
          <Text style={styles.loadingText}>Scouting the Twin Pool...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (hasLocalTwin === false) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.noSessionContainer}>
          <Text style={styles.logo}>Chaptr.</Text>
          <Text style={styles.noSessionTitle}>Create your Twin first</Text>
          <Text style={styles.noSessionText}>
            This browser does not have a local Chaptr identity yet. Create your Twin to scout, chat, and receive proposals.
          </Text>

          <TouchableOpacity
            style={styles.chatButton}
            onPress={() => router.replace('/' as Href)}
            activeOpacity={0.9}
          >
            <LinearGradient
              colors={['#D94A8C', '#7A3EB8']}
              style={styles.chatButtonGradient}
            >
              <Text style={styles.chatButtonText}>Connect with Google</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.container}>
        <Text style={styles.logo}>Chaptr.</Text>

        <View style={styles.topActions}>
          <TouchableOpacity style={styles.utilityButton} onPress={openProposals} activeOpacity={0.85}>
            <Text style={styles.utilityButtonText}>View Proposals</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.utilityButton, styles.logoutButton]}
            onPress={handleLogout}
            disabled={isLoggingOut}
            activeOpacity={0.85}
          >
            <Text style={[styles.utilityButtonText, styles.logoutButtonText]}>
              {isLoggingOut ? 'Logging Out...' : 'Log Out'}
            </Text>
          </TouchableOpacity>
        </View>

        {activeProposal ? (
          <View style={styles.focusBanner}>
            <Text style={styles.focusBannerKicker}>Focus Mode</Text>
            <Text style={styles.focusBannerTitle}>
              Your Twin is focused on {activeProposal.candidateName}.
            </Text>
            <Text style={styles.focusBannerText}>
              You can still browse and chat, but you cannot propose again until this proposal is resolved.
            </Text>

            <View style={styles.focusActions}>
              <TouchableOpacity style={styles.focusActionButton} onPress={openActiveProposal}>
                <Text style={styles.focusActionText}>Open Focus Chat</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.focusActionButton, styles.withdrawButton]}
                onPress={handleWithdrawActiveProposal}
                disabled={isWithdrawing}
              >
                <Text style={[styles.focusActionText, styles.withdrawButtonText]}>
                  {isWithdrawing ? 'Withdrawing...' : 'Withdraw'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        <View style={styles.titleRow}>
          <Text style={styles.title}>Your Morning Briefing</Text>
          <Text style={styles.clock}>
            {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>

        <Text style={styles.subtitle}>
          {topConnections.length > 0
            ? `Your Twin scouted ${topConnections.length} compatible profile${topConnections.length === 1 ? '' : 's'} from the pool.`
            : 'Your Agent is waiting for compatible Twins to join the pool.'}
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <FlatList
          data={topConnections}
          keyExtractor={(item) => item.id}
          renderItem={renderProfileCard}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          extraData={`${passedProfileIds.join(',')}-${unlockedProfileIds.join(',')}-${humanMatches.map((m) => m.proposalId).join(',')}-${activeProposal?.candidateTwinId ?? ''}`}
          ListEmptyComponent={
            !error ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>No compatible Twins yet</Text>
                <Text style={styles.emptyText}>
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

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: '#A299A8', fontSize: 14 },
  noSessionContainer: {
    flex: 1,
    width: '100%',
    maxWidth: 520,
    alignSelf: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  noSessionTitle: {
    color: '#FDFBF7',
    fontSize: 28,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 10,
  },
  noSessionText: {
    color: '#A299A8',
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
  },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 600,
    alignSelf: 'center',
    paddingHorizontal: 18,
    paddingTop: 14,
  },
  logo: {
    color: '#FDFBF7',
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 18,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  topActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 14,
  },
  utilityButton: {
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#16131A',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  utilityButtonText: {
    color: '#A299A8',
    fontSize: 12,
    fontWeight: '800',
  },
  logoutButton: {
    borderColor: 'rgba(248, 113, 113, 0.38)',
  },
  logoutButtonText: {
    color: '#f87171',
  },
  focusBanner: {
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.46)',
    backgroundColor: 'rgba(74, 222, 128, 0.1)',
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  focusBannerKicker: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  focusBannerTitle: {
    color: '#FDFBF7',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 4,
  },
  focusBannerText: {
    color: '#A7B8AB',
    fontSize: 12,
    lineHeight: 17,
  },
  focusActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  focusActionButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.36)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  focusActionText: {
    color: '#DDFBE7',
    fontSize: 12,
    fontWeight: '900',
  },
  withdrawButton: {
    borderColor: 'rgba(248, 113, 113, 0.5)',
    backgroundColor: 'rgba(248, 113, 113, 0.1)',
  },
  withdrawButtonText: {
    color: '#fecaca',
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  title: { color: '#FDFBF7', fontSize: 25, fontWeight: '800', flex: 1 },
  clock: { color: '#D94A8C', fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  subtitle: {
    color: '#A299A8',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
    marginBottom: 18,
  },
  errorText: {
    color: '#D94A8C',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
  },
  listContent: { paddingBottom: 28, gap: 14 },
  card: {
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2A2432',
  },
  focusCard: {
    borderColor: 'rgba(217, 74, 140, 0.52)',
    shadowColor: '#D94A8C',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.22,
    shadowRadius: 18,
  },
  cardGradient: { padding: 16 },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  avatar: {
    width: 68,
    height: 78,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#2A2432',
    borderWidth: 1,
    borderColor: 'rgba(217, 74, 140, 0.35)',
  },
  avatarImage: { width: '100%', height: '100%' },
  lockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(13, 11, 16, 0.34)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockText: { color: '#FDFBF7', fontSize: 10, fontWeight: '900', letterSpacing: 1 },
  profileInfo: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  profileName: { color: '#FDFBF7', fontSize: 19, fontWeight: '800' },
  zkBadge: {
    borderWidth: 1,
    borderColor: '#4ade80',
    backgroundColor: 'rgba(74, 222, 128, 0.12)',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  zkBadgeText: { color: '#4ade80', fontSize: 10, fontWeight: '800' },
  location: { color: '#A299A8', fontSize: 12, marginTop: 4 },
  bio: { color: '#D8D0DD', fontSize: 13, lineHeight: 18, marginTop: 6 },
  lockedHint: { color: '#6D6175', fontSize: 12, marginTop: 7, fontWeight: '700' },
  unlockedHint: { color: '#4ade80', fontSize: 12, marginTop: 7, fontWeight: '800' },
  focusHint: { color: '#4ade80', fontSize: 12, marginTop: 7, fontWeight: '900' },
  compatibilityPill: {
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1,
    borderColor: '#2A2432',
  },
  compatibilityValue: { color: '#FDFBF7', fontSize: 15, fontWeight: '800' },
  compatibilityLabel: { color: '#A299A8', fontSize: 10, marginTop: 1 },
  overheardBox: {
    marginTop: 16,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(217, 74, 140, 0.38)',
    backgroundColor: 'rgba(217, 74, 140, 0.08)',
  },
  overheardTitle: { color: '#FDFBF7', fontSize: 12, fontWeight: '800', marginBottom: 10 },
  chatLine: {
    borderRadius: 11,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(13, 11, 16, 0.6)',
    marginBottom: 8,
  },
  chatLineText: { color: '#E0DCE3', fontSize: 12, lineHeight: 17 },
  blobId: {
    color: '#6D6175',
    fontSize: 11,
    marginTop: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  actionRow: { marginTop: 14, gap: 10 },
  passButton: {
    height: 46,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#3A3342',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  passButtonText: { color: '#E0DCE3', fontSize: 15, fontWeight: '700' },
  chatButton: { height: 48, borderRadius: 16, overflow: 'hidden' },
  chatButtonGradient: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  chatButtonText: { color: '#FFF', fontSize: 15, fontWeight: '800' },
  emptyState: { marginTop: 80, alignItems: 'center' },
  emptyTitle: { color: '#FDFBF7', fontSize: 20, fontWeight: '800' },
  emptyText: { color: '#A299A8', fontSize: 14, marginTop: 8, textAlign: 'center' },
});