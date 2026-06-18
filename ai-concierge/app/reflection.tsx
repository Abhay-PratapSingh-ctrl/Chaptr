import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { getZkLoginSignature, generateNonce } from '@mysten/sui/zklogin';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { executeSponsoredZkLogin } from '@/utils/shinamiSponsor';
import { buildEndMatchTx } from '@/utils/suiTransactions';
import { writeFeedback, submitReport, writeBlockEntry } from '@/utils/safetyService';
import { fetchZkProof, getJwtForTransaction, loadZkLoginParams, setupZkLoginParams } from '@/utils/zkLoginService';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const HUMAN_MATCHES_KEY = 'chaptr:human-matches';

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

type ReflectionParams = {
  source?: string | string[];
  matchId?: string | string[];
  proposalId?: string | string[];
  targetOwner?: string | string[];
  targetTwinId?: string | string[];
  targetName?: string | string[];
  score?: string | string[];
  initialBlock?: string | string[];
};

const firstParam = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value);
const humanChatKey = (matchId: string) => `chaptr:human-chat:${matchId}`;
const normalize = (value?: string | null) => (value ?? '').trim().toLowerCase();

const END_REASONS = [
  { key: 'different_intentions', label: 'Different intentions' },
  { key: 'communication_style', label: 'Communication style' },
  { key: 'no_real_spark', label: 'No real spark' },
  { key: 'something_felt_unsafe', label: 'Something felt unsafe' },
  { key: 'finished_naturally', label: 'We just finished naturally' },
  { key: 'other', label: 'Other' },
];

const REPORT_REASONS = [
  { key: 'harassment', label: 'Harassment or threats' },
  { key: 'fake_profile', label: 'Fake or misleading profile' },
  { key: 'inappropriate_content', label: 'Inappropriate content' },
  { key: 'off_platform', label: 'Pressured to move off-platform' },
  { key: 'other', label: 'Other' },
];

const ACCURACY_OPTIONS = [
  { key: 'accurate', label: 'Yes, the scout report was accurate' },
  { key: 'somewhat', label: 'Somewhat' },
  { key: 'not_accurate', label: 'No, the report missed the mark' },
];

// Gets JWT immediately on user gesture — must be called before any awaits
const getJwtForEndMatch = async () => {
  const getJwtForUpload = async (): Promise<string> => {
    return await getJwtForTransaction(true);
  };
  return await getJwtForUpload();
};

// Accepts jwt as parameter — called after local writes so popup isn't blocked
const executeEndMatch = async (matchId: string, expectedOwner: string, jwt: string) => {
  const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
  const { zkProof, addressSeed, userAddress } = await fetchZkProof(
    jwt,
    ephemeralKeyPair,
    maxEpoch,
    randomness,
  );

  if (userAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error("Selected Google account does not match this browser's Chaptr identity.");
  }

  const tx = buildEndMatchTx(matchId);
  return executeSponsoredZkLogin(
    tx, userAddress, ephemeralKeyPair, zkProof, addressSeed, maxEpoch, suiClient
  );
};

const cleanupEndedMatch = async (input: {
  matchId: string;
  proposalId: string;
  targetOwner: string;
  targetTwinId: string;
}) => {
  const targets = [
    input.matchId,
    input.proposalId,
    input.targetOwner,
    input.targetTwinId,
  ].map(normalize).filter(Boolean);

  const raw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
  const parsed = raw ? JSON.parse(raw) : [];
  const matches = Array.isArray(parsed) ? parsed : [];
  // Remove participant's twin ID from unlocked profiles on match end
  const unlockedRaw = await AsyncStorage.getItem('chaptr:unlocked-profiles');
  const unlocked = unlockedRaw ? JSON.parse(unlockedRaw) : [];
  const filtered = unlocked.filter((id: string) => 
    id.toLowerCase() !== input.targetTwinId.toLowerCase()
  );
  await AsyncStorage.setItem('chaptr:unlocked-profiles', JSON.stringify(filtered));

  // ── Remove Agentic Guard Keys ──
  // This allows the AI to propose or accept proposals from this user again in the future
  if (input.targetOwner) {
    await AsyncStorage.removeItem(`chaptr:auto-proposed:${input.targetOwner.toLowerCase()}`);
  }
  if (input.proposalId) {
    await AsyncStorage.removeItem(`chaptr:auto-accepted:${input.proposalId.toLowerCase()}`);
  }

  const next = matches.filter((match) => {
    const matchKeys = [
      match?.matchId,
      match?.proposalId,
      match?.participantOwner,
      match?.participantTwinId,
    ].map(normalize).filter(Boolean);

    return !targets.some((target) => matchKeys.includes(target));
  });

  await AsyncStorage.setItem(HUMAN_MATCHES_KEY, JSON.stringify(next));

  const chatKeys = Array.from(
    new Set([input.matchId, input.proposalId].filter(Boolean).map(humanChatKey)),
  );

  if (chatKeys.length > 0) {
    await AsyncStorage.multiRemove(chatKeys);
  }
};

export default function ReflectionScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<ReflectionParams>();

  const source = firstParam(params.source) ?? 'human-chat';
  const matchId = firstParam(params.matchId) ?? '';
  const proposalId = firstParam(params.proposalId) ?? '';
  const targetOwner = firstParam(params.targetOwner) ?? '';
  const targetTwinId = firstParam(params.targetTwinId) ?? '';
  const targetName = firstParam(params.targetName) || 'your match';

  const parsedScore = Number(firstParam(params.score) ?? '');
  const score = Number.isFinite(parsedScore) ? parsedScore : null;

  const initialBlock = firstParam(params.initialBlock) === '1';
  const isHumanReflection = source === 'human-chat' || source === 'morning-briefing';

  const [endReason, setEndReason] = useState<string | null>(null);
  const [reportReason, setReportReason] = useState<string | null>(null);
  const [accuracy, setAccuracy] = useState<string | null>(null);
  const [wantsToReport, setWantsToReport] = useState(false);
  const [wantsToBlock, setWantsToBlock] = useState(initialBlock);
  const [submitting, setSubmitting] = useState(false);

  const isSafetyConcern = endReason === 'something_felt_unsafe';

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);

    try {
      const reporterOwner = await AsyncStorage.getItem('chaptr:my-owner');
      if (isHumanReflection && !reporterOwner) throw new Error('Missing local Chaptr identity.');

      // ── Get JWT FIRST before any other async work ──
      // Must be close to the user gesture so the browser allows the popup.
      // If we await other things first, the browser blocks the popup window.
      let jwt: string | null = null;
      if (isHumanReflection && matchId && reporterOwner) {
        jwt = await getJwtForEndMatch();
      }

      // ── Now do all local writes ──
      const metaNote = [`source:${source}`, proposalId ? `proposal:${proposalId}` : '']
        .filter(Boolean)
        .join(' ');

      if (endReason && isHumanReflection) {
        await writeFeedback({
          type: 'match_ended',
          signal: endReason,
          targetTwinId,
          targetOwner,
          targetName,
          matchId,
          score,
          note: metaNote,
        });
      }

      if (accuracy) {
        await writeFeedback({
          type: 'report_accuracy',
          signal: accuracy,
          targetTwinId,
          targetOwner,
          targetName,
          matchId,
          score,
          note: metaNote,
        });
      }

      const selectedReportReason = reportReason ?? (isSafetyConcern ? 'something_felt_unsafe' : null);

      if ((wantsToReport || isSafetyConcern) && selectedReportReason) {
        await submitReport({
          matchId,
          reporterOwner,
          reportedOwner: targetOwner,
          reportedTwinId: targetTwinId,
          reportedName: targetName,
          reason: selectedReportReason,
          note: metaNote,
        });
      }

      if (wantsToBlock) {
        await writeBlockEntry({
          twinId: targetTwinId,
          ownerAddress: targetOwner,
          name: targetName,
          reason: endReason ?? 'blocked_from_reflection',
          note: metaNote,
          matchId,
        });
      }

      // ── Fire on-chain tx using the JWT we got upfront ──
      if (isHumanReflection && matchId && reporterOwner && jwt) {
        await executeEndMatch(matchId, reporterOwner, jwt);
        await cleanupEndedMatch({ matchId, proposalId, targetOwner, targetTwinId });
      }

      router.replace('/(tabs)');
    } catch (error: any) {
      console.error('Reflection submit error:', error);
      Alert.alert('Could not finish match', error?.message ?? 'Try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        <View style={s.header}>
          <Text style={s.title}>
            {isHumanReflection ? `Match with ${targetName} ended` : 'That conversation is done'}
          </Text>
          <Text style={s.subtitle}>Take 10 seconds - help your Twin learn</Text>
        </View>

        {isHumanReflection ? (
          <Section label="What felt off?">
            {END_REASONS.map((reason) => (
              <Chip
                key={reason.key}
                label={reason.label}
                selected={endReason === reason.key}
                onPress={() => setEndReason(endReason === reason.key ? null : reason.key)}
                danger={reason.key === 'something_felt_unsafe'}
              />
            ))}
          </Section>
        ) : null}

        <Section label="Was this match what your Twin predicted?">
          {ACCURACY_OPTIONS.map((option) => (
            <Chip
              key={option.key}
              label={option.label}
              selected={accuracy === option.key}
              onPress={() => setAccuracy(accuracy === option.key ? null : option.key)}
            />
          ))}
        </Section>

        {isHumanReflection ? (
          <Section label="Safety options">
            <TouchableOpacity
              style={[s.safetyRow, (wantsToReport || isSafetyConcern) && s.safetyRowActive]}
              onPress={() => setWantsToReport((value) => !value)}
              activeOpacity={0.7}
            >
              <Text style={s.safetyRowLabel}>Report this person</Text>
            </TouchableOpacity>

            {(wantsToReport || isSafetyConcern) ? (
              <View style={s.subSection}>
                {REPORT_REASONS.map((reason) => (
                  <Chip
                    key={reason.key}
                    label={reason.label}
                    selected={reportReason === reason.key}
                    onPress={() => setReportReason(reportReason === reason.key ? null : reason.key)}
                    danger
                  />
                ))}
              </View>
            ) : null}

            <TouchableOpacity
              style={[s.safetyRow, wantsToBlock && s.safetyRowActive]}
              onPress={() => setWantsToBlock((value) => !value)}
              activeOpacity={0.7}
            >
              <Text style={s.safetyRowLabel}>Block this person</Text>
            </TouchableOpacity>
          </Section>
        ) : null}

        <TouchableOpacity
          style={[s.submitBtn, submitting && s.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={submitting}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={s.submitLabel}>Submit & Close</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.replace('/(tabs)')} style={s.skipBtn}>
          <Text style={s.skipLabel}>Skip</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.section}>
      <Text style={s.sectionLabel}>{label}</Text>
      <View style={s.chipRow}>{children}</View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
  danger = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[s.chip, selected && (danger ? s.chipDangerSelected : s.chipSelected)]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text style={[s.chipLabel, selected && s.chipLabelSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  scroll: { padding: 24, paddingBottom: 48 },
  header: { marginBottom: 32 },
  title: { fontSize: 22, fontWeight: '700', color: '#fff', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#888' },
  section: { marginBottom: 28 },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#aaa',
    marginBottom: 12,
    letterSpacing: 0.5,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#333',
    backgroundColor: '#1a1820',
  },
  chipSelected: { borderColor: '#E91E8C', backgroundColor: 'rgba(233,30,140,0.12)' },
  chipDangerSelected: { borderColor: '#FF4444', backgroundColor: 'rgba(255,68,68,0.12)' },
  chipLabel: { fontSize: 13, color: '#888' },
  chipLabelSelected: { color: '#fff' },
  subSection: { marginTop: 10, flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  safetyRow: {
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2a2830',
    backgroundColor: '#18161e',
    marginBottom: 8,
  },
  safetyRowActive: { borderColor: '#FF4444', backgroundColor: 'rgba(255,68,68,0.08)' },
  safetyRowLabel: { color: '#aaa', fontSize: 14 },
  submitBtn: {
    backgroundColor: '#E91E8C',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitLabel: { color: '#fff', fontSize: 16, fontWeight: '700' },
  skipBtn: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  skipLabel: { color: '#555', fontSize: 13 },
});