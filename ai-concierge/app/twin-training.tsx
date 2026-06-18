import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Platform,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router, useFocusEffect } from 'expo-router';
import {
  loadLocalScoutCapsule,
  loadTwinMemoryFacts,
  publishPublicSafeScoutCapsule,
  type ScoutCapsule,
  type TwinMemoryFact,
  type TwinTrainingFeedback,
} from '@/utils/twinMemory';
import { TextInput } from 'react-native';
import { Transaction } from '@mysten/sui/transactions';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { fetchZkProof, loadZkLoginParams, setupZkLoginParams } from '@/utils/zkLoginService';
import { buildCreateMandateTx, buildUpdateMandateTx } from '@/utils/suiTransactions';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet'), network: 'testnet' });
const discovery = { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth' };

const getJwtForTransaction = async (): Promise<string> => {
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
  if (!result.params.id_token) throw new Error('No id_token');
  return result.params.id_token;
};

const UPDATED_SCOUT_REF_KEY = 'chaptr:my-updated-scout-ref';

const feedbackLabels: Record<TwinTrainingFeedback['type'], string> = {
  match_ended: 'Match ended',
  ai_chat: 'AI chat signal',
  report_accuracy: 'Scout report accuracy',
  safety_report: 'Safety report',
  block: 'Block',
};

const signalLabel = (value?: string | null) =>
  (value ?? 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const feedbackTone = (type: TwinTrainingFeedback['type']) => {
  if (type === 'block' || type === 'safety_report') return '#f87171';
  if (type === 'ai_chat') return '#D94A8C';
  if (type === 'report_accuracy') return '#60a5fa';
  return '#4ade80';
};

const formatDate = (value?: string) => {
  if (!value) return 'Just now';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
};

export default function TwinTrainingScreen() {
  const [capsule, setCapsule] = useState<ScoutCapsule | null>(null);
  const [facts, setFacts] = useState<TwinMemoryFact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishedRef, setPublishedRef] = useState<string | null>(null);

  const loadTraining = useCallback(async () => {
    setIsLoading(true);

    try {
      const [savedCapsule, savedFacts, savedPublishedRef, savedMandateId, savedMandateSettings] = await Promise.all([
        loadLocalScoutCapsule(),
        loadTwinMemoryFacts(),
        AsyncStorage.getItem(UPDATED_SCOUT_REF_KEY),
        AsyncStorage.getItem('chaptr:mandate-id'),
        AsyncStorage.getItem('chaptr:mandate-settings'),
      ]);
      
      setCapsule(savedCapsule);
      setFacts(savedFacts);
      setPublishedRef(savedPublishedRef);
      setMandateId(savedMandateId);
      if(savedMandateSettings) {
        const s = JSON.parse(savedMandateSettings);
    setMayScout(s.mayScout ?? true);
    setMayRunA2A(s.mayRunA2A ?? false);
    setMayPropose(s.mayPropose ?? false);
    setMinScore(String(s.minScore ?? '80'));
  }
    } catch (error) {
      console.warn('Failed to load Twin training:', error);
      setCapsule(null);
      setFacts([]);
      setPublishedRef(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadTraining().catch(console.warn);
    }, [loadTraining]),
  );

  const handlePublishTraining = async () => {
    if (isPublishing) return;

    setIsPublishing(true);

    try {
      const result = await publishPublicSafeScoutCapsule();
      setPublishedRef(result.blobId);

      Alert.alert(
        'Training published',
        `Public-safe Scout Capsule stored on Walrus.\n\n${result.blobId.slice(0, 24)}...`,
      );
    } catch (error: any) {
      console.warn('Publish training failed:', error);
      Alert.alert('Publish failed', error?.message ?? 'Could not publish training.');
    } finally {
      setIsPublishing(false);
    }
  };
  // ── Mandate / Twin Autonomy state ─────────────────────────────────────────
const [mayScout, setMayScout] = useState(true);
const [mayRunA2A, setMayRunA2A] = useState(false);
const [mayPropose, setMayPropose] = useState(false);
const [minScore, setMinScore] = useState('80');
const [mandateId, setMandateId] = useState<string | null>(null);
const [isActivatingMandate, setIsActivatingMandate] = useState(false);
const [mandateStatusMsg, setMandateStatusMsg] = useState('');

const MANDATE_KEY = 'chaptr:mandate-id';


const handleActivateMandate = async () => {
  if (isActivatingMandate) return;
  setIsActivatingMandate(true);
  setMandateStatusMsg('Opening Google sign-in...');

  try {
    const myOwner = await AsyncStorage.getItem('chaptr:my-owner');
    if (!myOwner) throw new Error('No local identity found.');

    const jwt = await getJwtForTransaction();

    setMandateStatusMsg('Generating ZK proof...');
    const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
    const { zkProof, addressSeed, userAddress } = await fetchZkProof(
      jwt, ephemeralKeyPair, maxEpoch, randomness,
    );

    if (userAddress.toLowerCase() !== myOwner.toLowerCase()) {
      throw new Error('Google account does not match this browser identity.');
    }

    const scoreVal = Math.max(70, Math.min(99, Number(minScore) || 80));

    setMandateStatusMsg(mandateId ? 'Updating Mandate...' : 'Activating Mandate...');

    const tx = mandateId
      ? buildUpdateMandateTx(mandateId, mayScout, mayRunA2A, mayPropose, scoreVal)
      : buildCreateMandateTx(mayScout, mayRunA2A, mayPropose, scoreVal);

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

    const result = await suiClient.executeTransactionBlock({
      transactionBlock: bytes,
      signature: zkSignature,
      options: { showEffects: true, showObjectChanges: true },
    });

    // Extract new mandate object ID if this was a create
    if (!mandateId) {
      const mandateObj = (result as any).objectChanges?.find(
        (change: any) =>
          change.type === 'created' &&
          typeof change.objectType === 'string' &&
          change.objectType.includes('::mandate::Mandate'),
      );
      if (mandateObj?.objectId) {
        await AsyncStorage.setItem(MANDATE_KEY, mandateObj.objectId);
        setMandateId(mandateObj.objectId);
      }
    }
    await AsyncStorage.setItem('chaptr:mandate-settings', JSON.stringify({
      mayScout,
      mayRunA2A,
      mayPropose,
      minScore: Number(minScore),
    }));
    setMandateStatusMsg(mandateId ? 'Mandate updated ✅' : 'Mandate activated ✅');
    setTimeout(() => setMandateStatusMsg(''), 3000);
  } catch (err: any) {
    console.error('Mandate activation failed:', err);
    setMandateStatusMsg(`Failed: ${err.message}`);
  } finally {
    setIsActivatingMandate(false);
  }
};

  const feedbackHistory = useMemo(
    () => [...(capsule?.feedbackHistory ?? [])].reverse(),
    [capsule],
  );

  const feedbackFacts = useMemo(
    () =>
      facts
        .filter((fact) => fact.source === 'feedback')
        .slice()
        .reverse()
        .slice(0, 12),
    [facts],
  );

  const stats = useMemo(() => {
    const history = capsule?.feedbackHistory ?? [];

    return {
      total: history.length,
      positive: history.filter(
        (item) =>
          item.signal === 'good_fit' ||
          item.signal === 'accurate' ||
          item.signal === 'somewhat' ||
          item.signal === 'somewhat_accurate',
      ).length,
      safety: history.filter((item) => item.type === 'block' || item.type === 'safety_report')
        .length,
      reports: history.filter((item) => item.type === 'report_accuracy').length,
    };
  }, [capsule]);

  if (isLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loading}>
          <ActivityIndicator color="#D94A8C" />
          <Text style={styles.loadingText}>Loading Twin training...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={styles.backButton}>
          <Text style={styles.backText}>{'< Back'}</Text>
        </TouchableOpacity>

        <Text style={styles.headerTitle}>Twin Training</Text>

        <TouchableOpacity onPress={loadTraining} style={styles.refreshButton}>
          <Text style={styles.refreshText}>Refresh</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.heroPanel}>
          <Text style={styles.kicker}>LEARNING LOOP</Text>
          <Text style={styles.title}>Your Twin is adapting from your signals.</Text>
          <Text style={styles.body}>
            Feedback from chats, scout reports, blocks, and match reflections is saved into your
            local Scout Capsule and reused in future AI prompts.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.publishButton, isPublishing && styles.publishButtonDisabled]}
          onPress={handlePublishTraining}
          disabled={isPublishing}
          activeOpacity={0.85}
        >
          <Text style={styles.publishButtonText}>
            {isPublishing ? 'Publishing...' : 'Publish Public-Safe Training'}
          </Text>
        </TouchableOpacity>

        {publishedRef ? (
          <Text style={styles.publishedRef}>
            Walrus ref: {publishedRef.slice(0, 18)}...
          </Text>
        ) : null}

        <View style={styles.statsGrid}>
          <Stat label="Signals" value={stats.total} />
          <Stat label="Good fit" value={stats.positive} />
          <Stat label="Report notes" value={stats.reports} />
          <Stat label="Safety" value={stats.safety} danger={stats.safety > 0} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Feedback</Text>

          {feedbackHistory.length === 0 ? (
            <EmptyText text="No training feedback yet. Chat, report accuracy, block, or end a match to train your Twin." />
          ) : (
            feedbackHistory.slice(0, 20).map((item) => {
              const color = feedbackTone(item.type);

              return (
                <View key={item.id ?? `${item.type}-${item.createdAt}`} style={styles.feedbackCard}>
                  <View style={styles.feedbackTopRow}>
                    <View style={[styles.typePill, { borderColor: color + '66' }]}>
                      <Text style={[styles.typePillText, { color }]}>
                        {feedbackLabels[item.type]}
                      </Text>
                    </View>
                    <Text style={styles.dateText}>{formatDate(item.createdAt)}</Text>
                  </View>

                  <Text style={styles.feedbackSignal}>{signalLabel(item.signal)}</Text>

                  {item.targetName ? (
                    <Text style={styles.feedbackMeta}>Target: {item.targetName}</Text>
                  ) : null}

                  {item.score ? (
                    <Text style={styles.feedbackMeta}>Score: {item.score}%</Text>
                  ) : null}

                  {item.note ? (
                    <Text style={styles.feedbackNote} numberOfLines={3}>
                      {item.note}
                    </Text>
                  ) : null}
                </View>
              );
            })
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Memory Facts</Text>

          {feedbackFacts.length === 0 ? (
            <EmptyText text="No feedback-derived memory facts yet." />
          ) : (
            feedbackFacts.map((fact) => (
              <View key={fact.id} style={styles.memoryRow}>
                <View style={styles.memoryDot} />
                <View style={styles.memoryTextWrap}>
                  <Text style={styles.memoryText}>{fact.text}</Text>
                  <Text style={styles.memoryMeta}>
                    {fact.category} · confidence {Math.round(fact.confidence * 100)}%
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Current Capsule</Text>

          <CapsuleLine label="Traits" value={capsule?.traits?.join(', ')} />
          <CapsuleLine label="Dating intent" value={capsule?.datingIntent} />
          <CapsuleLine label="Dating pace" value={capsule?.datingPace} />
          <CapsuleLine label="Values" value={capsule?.values?.join(' | ')} />
          <CapsuleLine label="Boundaries" value={capsule?.boundaries?.join(' | ')} />
          <CapsuleLine label="Communication" value={capsule?.communicationStyle} />
          <CapsuleLine
            label="Updated"
            value={capsule?.updatedAt ? formatDate(capsule.updatedAt) : undefined}
          />
        </View>
        {/* ── Twin Autonomy ──────────────────────────────────────────────── */}
<View style={styles.section}>
  <Text style={styles.sectionTitle}>Twin Autonomy</Text>

  <View style={autonomyStyles.panel}>
    <Text style={autonomyStyles.panelKicker}>MANDATE OBJECT · SUI</Text>
    <Text style={autonomyStyles.panelTitle}>
      What is your Twin allowed to do?
    </Text>
    <Text style={autonomyStyles.panelBody}>
      A Mandate object lives in your wallet and defines your Twin's permissions. 
      No human is involved when your Twin acts within these bounds.
    </Text>

    {mandateId ? (
      <Text style={autonomyStyles.mandateRef}>
        Mandate: {mandateId.slice(0, 10)}...{mandateId.slice(-6)}
      </Text>
    ) : null}

    {/* Permission toggles */}
    <ToggleRow
      label="May scout profiles automatically"
      value={mayScout}
      onChange={setMayScout}
    />
    <ToggleRow
      label="May run Agent-to-Agent conversations"
      value={mayRunA2A}
      onChange={setMayRunA2A}
    />
    <ToggleRow
      label="May propose without my approval"
      value={mayPropose}
      onChange={setMayPropose}
    />

    {mayPropose && (
      <View style={autonomyStyles.scoreRow}>
        <Text style={autonomyStyles.scoreLabel}>
          Min score to auto-propose
        </Text>
        <TextInput
          style={autonomyStyles.scoreInput}
          value={minScore}
          onChangeText={setMinScore}
          keyboardType="numeric"
          maxLength={2}
          placeholderTextColor="#6D6175"
        />
        <Text style={autonomyStyles.scoreUnit}>%</Text>
      </View>
    )}

    {mandateStatusMsg ? (
      <Text style={autonomyStyles.statusMsg}>{mandateStatusMsg}</Text>
    ) : null}

    <TouchableOpacity
      style={[autonomyStyles.activateButton, isActivatingMandate && autonomyStyles.activateButtonDisabled]}
      onPress={handleActivateMandate}
      disabled={isActivatingMandate}
      activeOpacity={0.85}
    >
      <Text style={autonomyStyles.activateButtonText}>
        {isActivatingMandate
          ? mandateStatusMsg || 'Processing...'
          : mandateId
          ? 'Update Mandate'
          : 'Activate Mandate'}
      </Text>
    </TouchableOpacity>
  </View>
</View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, danger && styles.statDanger]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function EmptyText({ text }: { text: string }) {
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function CapsuleLine({ label, value }: { label: string; value?: string }) {
  if (!value) return null;

  return (
    <View style={styles.capsuleLine}>
      <Text style={styles.capsuleLabel}>{label}</Text>
      <Text style={styles.capsuleValue}>{value}</Text>
    </View>
  );
}
function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <TouchableOpacity
      style={autonomyStyles.toggleRow}
      onPress={() => onChange(!value)}
      activeOpacity={0.8}
    >
      <Text style={autonomyStyles.toggleLabel}>{label}</Text>
      <View style={[autonomyStyles.toggle, value && autonomyStyles.toggleActive]}>
        <View style={[autonomyStyles.toggleThumb, value && autonomyStyles.toggleThumbActive]} />
      </View>
    </TouchableOpacity>
  );
}
// Add this as a separate StyleSheet outside the main styles
const autonomyStyles = StyleSheet.create({
  panel: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(122,62,184,0.38)',
    backgroundColor: 'rgba(122,62,184,0.07)',
    padding: 16,
    gap: 12,
  },
  panelKicker: {
    color: '#7A3EB8',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
  },
  panelTitle: {
    color: '#FDFBF7',
    fontSize: 18,
    fontWeight: '900',
    lineHeight: 24,
  },
  panelBody: {
    color: '#A299A8',
    fontSize: 13,
    lineHeight: 19,
  },
  mandateRef: {
    color: '#6D6175',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#141018',
    padding: 14,
    gap: 12,
  },
  toggleLabel: {
    color: '#C8C0CE',
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },
  toggle: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#2A2432',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  toggleActive: {
    backgroundColor: 'rgba(122,62,184,0.6)',
    borderColor: '#7A3EB8',
    borderWidth: 1,
  },
  toggleThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#6D6175',
  },
  toggleThumbActive: {
    backgroundColor: '#FDFBF7',
    transform: [{ translateX: 18 }],
  },
  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#141018',
    padding: 14,
  },
  scoreLabel: {
    color: '#C8C0CE',
    fontSize: 13,
    flex: 1,
  },
  scoreInput: {
    width: 52,
    backgroundColor: '#0D0B10',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2A2432',
    color: '#FDFBF7',
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
    padding: 8,
  },
  scoreUnit: {
    color: '#A299A8',
    fontSize: 14,
    fontWeight: '700',
  },
  statusMsg: {
    color: '#A299A8',
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  activateButton: {
    height: 48,
    borderRadius: 15,
    backgroundColor: '#7A3EB8',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  activateButtonDisabled: {
    opacity: 0.6,
  },
  activateButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
});
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
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
    paddingTop: 18,
    paddingBottom: 48,
  },
  heroPanel: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.34)',
    backgroundColor: 'rgba(217,74,140,0.07)',
    padding: 16,
    marginBottom: 14,
  },
  kicker: { color: '#D94A8C', fontSize: 11, fontWeight: '900', letterSpacing: 2 },
  title: { color: '#FDFBF7', fontSize: 22, fontWeight: '900', marginTop: 8, lineHeight: 28 },
  body: { color: '#A299A8', fontSize: 13, lineHeight: 19, marginTop: 8 },
  publishButton: {
    height: 48,
    borderRadius: 15,
    backgroundColor: '#D94A8C',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  publishButtonDisabled: { opacity: 0.65 },
  publishButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
  publishedRef: {
    color: '#6D6175',
    fontSize: 11,
    marginBottom: 18,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 22,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: '47%',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#16131A',
    padding: 14,
  },
  statValue: { color: '#4ade80', fontSize: 24, fontWeight: '900' },
  statDanger: { color: '#f87171' },
  statLabel: { color: '#A299A8', fontSize: 12, fontWeight: '700', marginTop: 3 },
  section: { marginBottom: 24 },
  sectionTitle: { color: '#FDFBF7', fontSize: 16, fontWeight: '900', marginBottom: 10 },
  feedbackCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#141018',
    padding: 14,
    marginBottom: 10,
  },
  feedbackTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    gap: 10,
  },
  typePill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  typePillText: { fontSize: 11, fontWeight: '900' },
  dateText: { color: '#6D6175', fontSize: 11, fontWeight: '700' },
  feedbackSignal: { color: '#FDFBF7', fontSize: 15, fontWeight: '900', marginBottom: 5 },
  feedbackMeta: { color: '#A299A8', fontSize: 12, marginTop: 2 },
  feedbackNote: {
    color: '#C8C0CE',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  emptyBox: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#141018',
    padding: 14,
  },
  emptyText: { color: '#8E8498', fontSize: 13, lineHeight: 19 },
  memoryRow: {
    flexDirection: 'row',
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#141018',
    padding: 12,
    marginBottom: 8,
  },
  memoryDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#D94A8C',
    marginTop: 5,
  },
  memoryTextWrap: { flex: 1 },
  memoryText: { color: '#D8D0DD', fontSize: 13, lineHeight: 18 },
  memoryMeta: { color: '#6D6175', fontSize: 11, marginTop: 5 },
  capsuleLine: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#141018',
    padding: 12,
    marginBottom: 8,
  },
  capsuleLabel: { color: '#6D6175', fontSize: 11, fontWeight: '900', marginBottom: 5 },
  capsuleValue: { color: '#D8D0DD', fontSize: 13, lineHeight: 18 },
});