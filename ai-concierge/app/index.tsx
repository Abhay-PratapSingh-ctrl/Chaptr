import React, { useEffect, useState, useRef } from 'react';
import {
  ActivityIndicator,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Image,
  ScrollView,
  Animated,
  Dimensions,
  Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { router, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { getJwtForTransaction, loadZkLoginParams, setupZkLoginParams, fetchZkProof, getEnokiEphemeralPublicKey } from '@/utils/zkLoginService';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const TWIN_POOL_ID = process.env.EXPO_PUBLIC_TWIN_POOL_ID || '';

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toPlainString = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value?.id && typeof value.id === 'string') return value.id;
  if (value === null || value === undefined) return '';
  return String(value);
};

const hasLocalTwin = async () => {
  const [myOwner, myTwinId, myScoutRef] = await Promise.all([
    AsyncStorage.getItem('chaptr:my-owner'),
    AsyncStorage.getItem('chaptr:my-twin-id'),
    AsyncStorage.getItem('chaptr:my-scout-ref'),
  ]);

  return Boolean(myOwner && myTwinId && myScoutRef);
};

/**
 * Queries the Twin Pool for an existing entry matching this Sui address.
 * Returns { twinId, scoutRef } if found, null if not.
 * Safe — never throws. Failure means "not found", falls through to onboarding.
 */
const lookupExistingTwin = async (
  userAddress: string,
): Promise<{ twinId: string; scoutRef: string } | null> => {
  if (!TWIN_POOL_ID || !userAddress) return null;

  try {
    const obj = await suiClient.getObject({
      id: TWIN_POOL_ID,
      options: { showContent: true },
    });

    const fields = (obj.data?.content as any)?.fields;
    const raw: any[] = fields?.entries ?? [];

    // Find ALL pool entries for this address (there may be duplicates)
    const myEntries = raw.filter((entry) => {
      const f = entry.fields ?? entry;
      const owner = toPlainString(f.owner);
      return owner.toLowerCase() === userAddress.toLowerCase();
    });

    if (myEntries.length === 0) return null;

    // Check each entry — the Twin might be consumed (wrapped in Match/Proposal).
    // Return the FIRST entry whose Twin object still exists on-chain.
    for (const entry of myEntries) {
      const f = entry.fields ?? entry;
      const twinId = toPlainString(f.twin_id);
      const scoutRef = toPlainString(f.scout_ref);

      if (!twinId || !scoutRef) continue;

      try {
        const twinObj = await suiClient.getObject({ id: twinId, options: { showType: true } });
        if (twinObj.error || !twinObj.data) {
          console.warn(`[ConnectScreen] Twin ${twinId.slice(0, 12)}… is consumed/wrapped — skipping`);
          continue;
        }
        // Twin exists and is accessible
        return { twinId, scoutRef };
      } catch {
        console.warn(`[ConnectScreen] Failed to verify Twin ${twinId.slice(0, 12)}… — skipping`);
        continue;
      }
    }

    // All pool entries have consumed Twins — fall through to onboarding
    console.warn('[ConnectScreen] All pool entry Twins are consumed — user needs to re-mint');
    return null;
  } catch (err) {
    console.warn('[ConnectScreen] Twin Pool lookup failed:', err);
    return null;
  }
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConnectScreen() {
  const scrollX = useRef(new Animated.Value(0)).current;
  const [activeIndex, setActiveIndex] = useState(0);
  const { width } = Dimensions.get('window');

  const cardsData = [
    {
      id: 0,
      chapter: 'CHAPTER 01',
      title: 'Who are\nyou?',
      desc: 'Your Twin\nlearns your story.',
      colors: ['rgba(217, 74, 140, 0.3)', 'rgba(5, 3, 10, 0.9)', 'rgba(122, 62, 184, 0.15)'] as readonly [string, string, ...string[]],
      borderColor: 'rgba(217, 74, 140, 0.6)',
      shadowOut: 'rgba(217, 74, 140, 0.25)',
      shadowIn: 'rgba(217, 74, 140, 0.2)',
      chapterColor: '#D94A8C'
    },
    {
      id: 1,
      chapter: 'CHAPTER 02',
      title: 'What\nmatters?',
      desc: 'Your Twin\nfinds what matters.',
      colors: ['rgba(122, 62, 184, 0.3)', 'rgba(5, 3, 10, 0.9)', 'rgba(80, 40, 150, 0.15)'] as readonly [string, string, ...string[]],
      borderColor: 'rgba(122, 62, 184, 0.6)',
      shadowOut: 'rgba(122, 62, 184, 0.25)',
      shadowIn: 'rgba(122, 62, 184, 0.2)',
      chapterColor: '#7A3EB8'
    },
    {
      id: 2,
      chapter: 'CHAPTER 03',
      title: 'Who are you\nbecoming?',
      desc: 'Your Twin\nlooks ahead.',
      colors: ['rgba(80, 40, 150, 0.3)', 'rgba(5, 3, 10, 0.9)', 'rgba(50, 20, 100, 0.15)'] as readonly [string, string, ...string[]],
      borderColor: 'rgba(80, 40, 150, 0.6)',
      shadowOut: 'rgba(80, 40, 150, 0.25)',
      shadowIn: 'rgba(80, 40, 150, 0.2)',
      chapterColor: '#502896'
    }
  ];

  const [isChecking, setIsChecking] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);

  const handleSwap = () => {
    const nextIndex = (activeIndex + 1) % cardsData.length;
    setActiveIndex(nextIndex);
    Animated.spring(scrollX, {
      toValue: nextIndex * width,
      friction: 7,
      tension: 50,
      useNativeDriver: false,
    }).start();
  };
  const [isRestoring, setIsRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showManifesto, setShowManifesto] = useState(false);

  useEffect(() => {
    let mounted = true;

    hasLocalTwin()
      .then((hasTwin) => {
        if (!mounted) return;

        if (hasTwin) {
          router.replace('/(tabs)' as Href);
          return;
        }

        setIsChecking(false);
      })
      .catch(() => {
        if (!mounted) return;
        setIsChecking(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleConnect = async () => {
    try {
      setError(null);
      setIsConnecting(true);

      if (!GOOGLE_CLIENT_ID) {
        throw new Error('Missing EXPO_PUBLIC_GOOGLE_CLIENT_ID');
      }

      // Step 1: setup zkLogin params and run Google OAuth
      // We use forcePrompt: true because this is the explicit login screen.
      // This shared function also automatically caches the JWT so future
      // background operations won't pop up again.
      const jwt = await getJwtForTransaction(true);

      // Step 2: Derive Sui address from JWT.
      // fetchZkProof is the same call used in every transaction flow.
      // We need the userAddress to check the Twin Pool.
      setIsConnecting(false);
      setIsRestoring(true);

      const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
      const { userAddress } = await fetchZkProof(jwt, ephemeralKeyPair, maxEpoch, randomness);

      // Step 3: Save owner address regardless — same as onboarding does
      await AsyncStorage.setItem('chaptr:my-owner', userAddress);

      // Step 4: Check if this address already has a Twin in the pool
      const existing = await lookupExistingTwin(userAddress);

      if (existing) {
        // Returning user — restore their Twin from chain, skip onboarding
        await Promise.all([
          AsyncStorage.setItem('chaptr:my-twin-id', existing.twinId),
          AsyncStorage.setItem('chaptr:my-scout-ref', existing.scoutRef),
        ]);

        router.replace('/(tabs)' as Href);
        return;
      }

      // Step 5: Genuinely new user — go to onboarding exactly as before
      // JWT is passed along so onboarding doesn't need another Google sign-in
      router.push({
        pathname: '/onboarding',
        params: { jwt },
      } as Href);
    } catch (e: any) {
      setError(e?.message ?? 'Could not connect Google account.');
    } finally {
      setIsConnecting(false);
      setIsRestoring(false);
    }
  };

  // ─── Loading: initial storage check ────────────────────────────────────────
  if (isChecking) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color="#D94A8C" />
          <Text style={styles.muted}>Checking your Chaptr identity...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Loading: restoring existing Twin from chain ────────────────────────────
  if (isRestoring) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.center}>
          <ActivityIndicator color="#4ade80" />
          <Text style={styles.muted}>Restoring your Twin...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ─── Main connect screen — visually identical to original ──────────────────
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.topNav}>
        <Text style={styles.logo}>Chaptr.</Text>
        <TouchableOpacity style={styles.navButton} onPress={() => setShowManifesto(true)}>
          <Text style={styles.navButtonText}>Who we are</Text>
        </TouchableOpacity>
      </View>
      
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false} style={{ flex: 1, width: '100%' }}>
        <View style={styles.badgeContainer}>
          <Text style={styles.badgeText}>YOUR TWIN. YOUR STORY.</Text>
        </View>

        <Text style={styles.title}>
          Every great connection{'\n'}starts with a <Text style={styles.titleHighlightPink}>chapter</Text>.
        </Text>

        <Text style={styles.subtitle}>
          Your Twin helps write the right one.
        </Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <TouchableOpacity
          style={styles.button}
          onPress={handleConnect}
          disabled={isConnecting || isRestoring}
          activeOpacity={0.9}
        >
          <LinearGradient colors={['#D94A8C', '#7A3EB8']} style={styles.buttonGradient}>
            {isConnecting ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.buttonText}>Build My Twin {'\u2192'}</Text>
            )}
          </LinearGradient>
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.9} onPress={handleSwap} style={styles.cardsContainer}>
          <View style={styles.ambientFloorGlow} />

          {cardsData.map((card, index) => {
            const inputRange = [
              (index - 2) * width,
              (index - 1) * width,
              index * width,
              (index + 1) * width,
            ];

            const translateX = scrollX.interpolate({
              inputRange,
              outputRange: [100, 25, -60, -200],
              extrapolate: 'clamp',
            });

            const translateY = scrollX.interpolate({
              inputRange,
              outputRange: [-30, -5, 20, 40],
              extrapolate: 'clamp',
            });

            const scale = scrollX.interpolate({
              inputRange,
              outputRange: [0.8, 0.9, 1, 1.1],
              extrapolate: 'clamp',
            });

            const opacity = scrollX.interpolate({
              inputRange,
              outputRange: [0.4, 0.8, 1, 0],
              extrapolate: 'clamp',
            });

            const zIndex = scrollX.interpolate({
              inputRange,
              outputRange: [1, 2, 3, 4],
              extrapolate: 'clamp',
            });

            return (
              <Animated.View
                key={card.id}
                style={[
                  styles.glassCard,
                  {
                    borderColor: card.borderColor,
                    opacity,
                    zIndex,
                    transform: [
                      { perspective: 1000 },
                      { translateX },
                      { translateY },
                      { rotateY: '25deg' },
                      { scale }
                    ],
                    ...(Platform.OS === 'web' ? {
                      boxShadow: `0px 0px 40px ${card.shadowOut}, inset 0px 0px 20px ${card.shadowIn}`,
                    } as any : {})
                  }
                ]}
              >
                <LinearGradient
                  colors={card.colors}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 16 }}
                />
                <View style={styles.cardContent}>
                  <Text style={[styles.cardChapter, { color: card.chapterColor }]}>{card.chapter}</Text>
                  <Text style={styles.cardTitle}>{card.title}</Text>
                  <View style={[styles.cardDivider, { backgroundColor: card.borderColor }]} />
                  <Text style={styles.cardDesc}>{card.desc}</Text>
                </View>
              </Animated.View>
            );
          })}
        </TouchableOpacity>

        {/* Powered By Tech Stack Section */}
        <View style={styles.techStackContainer}>
          <Text style={styles.techStackTitle}>POWERED BY</Text>
          
          <View style={styles.bentoGrid}>
            <View style={styles.bentoCard}>
              <View style={[styles.bentoGlow, { backgroundColor: '#4EABFA' }]} />
              <Text style={styles.bentoCardTitle}>Sui Network</Text>
              <Text style={styles.bentoCardDesc}>Ultra-fast, scalable Layer-1 blockchain powering real-time logic and ecosystem economics.</Text>
            </View>
            <View style={styles.bentoCard}>
              <View style={[styles.bentoGlow, { backgroundColor: '#7A3EB8' }]} />
              <Text style={styles.bentoCardTitle}>Walrus Network</Text>
              <Text style={styles.bentoCardDesc}>Decentralized, immutable storage for your Twin's high-dimensional memory vectors.</Text>
            </View>
            <View style={styles.bentoCard}>
              <View style={[styles.bentoGlow, { backgroundColor: '#D94A8C' }]} />
              <Text style={styles.bentoCardTitle}>Autonomous Agents</Text>
              <Text style={styles.bentoCardDesc}>Always-on AI scouting and deep semantic matching algorithms.</Text>
            </View>
            <View style={styles.bentoCard}>
              <View style={[styles.bentoGlow, { backgroundColor: '#4A90E2' }]} />
              <Text style={styles.bentoCardTitle}>Zero-Knowledge</Text>
              <Text style={styles.bentoCardDesc}>End-to-end encrypted connection handshakes preserving absolute privacy.</Text>
            </View>
          </View>
        </View>

        <Text style={styles.privacyText}>
          {'\uD83D\uDD12'} Your data stays private. Always.
        </Text>
      </ScrollView>
        <Modal visible={showManifesto} transparent animationType="fade">
          <View style={styles.manifestoOverlay}>
            <TouchableOpacity style={styles.manifestoCloseBg} onPress={() => setShowManifesto(false)} activeOpacity={1} />
            <View style={styles.manifestoCard}>
              <Text style={styles.manifestoTitle}>The end of{'\n'}surface-level matching.</Text>
              <View style={styles.manifestoDivider} />
              <Text style={styles.manifestoBody}>
                Chaptr is a dating platform that replaces endless swiping with AI-mediated compatibility.
              </Text>
              <Text style={styles.manifestoBody}>
                Each user has a personal Digital Twin that learns their preferences, screens potential matches, and helps both sides connect more intentionally.
              </Text>
              <TouchableOpacity style={styles.manifestoCloseButton} onPress={() => setShowManifesto(false)}>
                <Text style={styles.manifestoCloseText}>Close</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

    </SafeAreaView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#05030A' }, // very dark background
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: '#A299A8', fontSize: 14 },
  topNav: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 20,
    width: '100%',
    maxWidth: 1000,
    alignSelf: 'center',
  },
  navButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#2A2432',
  },
  navButtonText: {
    color: '#E0DCE3',
    fontSize: 13,
    fontWeight: '600',
  },
  container: {
    width: '100%',
    maxWidth: 1000,
    alignSelf: 'center',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 28,
    paddingBottom: 80,
  },
  logo: {
    color: '#FDFBF7',
    fontSize: 24,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  badgeContainer: {
    backgroundColor: 'rgba(217, 74, 140, 0.1)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    marginBottom: 24,
  },
  badgeText: {
    color: '#D94A8C',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  title: {
    color: '#FDFBF7',
    fontSize: 46,
    lineHeight: 52,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 24,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  titleHighlightPink: {
    color: '#D94A8C',
    fontStyle: 'italic',
  },
  titleHighlightPurple: {
    color: '#7A3EB8',
    fontStyle: 'italic',
  },
  subtitle: {
    color: '#A299A8',
    fontSize: 16,
    lineHeight: 26,
    textAlign: 'center',
    marginBottom: 40,
  },
  error: {
    color: '#FF6B6B',
    marginTop: 15,
    textAlign: 'center',
    fontSize: 14,
  },
  button: {
    height: 56,
    width: 220,
    borderRadius: 28,
    overflow: 'hidden',
    marginBottom: 40,
  },
  buttonGradient: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  cardsContainer: {
    height: 320,
    width: '100%',
    marginTop: -10,
    marginBottom: 40,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    ...(Platform.OS === 'web' ? {
      perspective: 1000,
    } as any : {}),
  },
  glassCard: {
    position: 'absolute',
    width: 160,
    height: 250,
    backgroundColor: 'rgba(20, 10, 30, 0.7)',
    borderWidth: 1.5,
    borderRadius: 16,
    justifyContent: 'flex-start',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(24px)',
    } as any : {}),
  },
  cardContent: {
    padding: 24,
    flex: 1,
    justifyContent: 'flex-start',
    zIndex: 2,
  },
  ambientFloorGlow: {
    position: 'absolute',
    bottom: 40,
    left: '10%',
    width: '80%',
    height: 60,
    backgroundColor: '#D94A8C',
    borderRadius: 30,
    opacity: 0.15,
    ...(Platform.OS === 'web' ? {
      filter: 'blur(50px)',
    } as any : {}),
  },
  cardChapter: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.5,
    marginBottom: 20,
  },
  cardTitle: {
    color: '#FDFBF7',
    fontSize: 26,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    lineHeight: 32,
  },
  cardDivider: {
    height: 1.5,
    width: 40,
    marginVertical: 24,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0px 0px 8px #D94A8C',
    } as any : {}),
  },
  cardDesc: {
    color: '#A299A8',
    fontSize: 14,
    lineHeight: 22,
  },
  privacyText: {
    color: '#6D6175',
    fontSize: 13,
    marginTop: 30,
    textAlign: 'center',
  },
  manifestoOverlay: {
    flex: 1,
    backgroundColor: 'rgba(5, 3, 10, 0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } as any : {}),
  },
  manifestoCloseBg: {
    ...StyleSheet.absoluteFillObject,
  },
  manifestoCard: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: 'rgba(30, 15, 45, 0.7)',
    borderRadius: 24,
    padding: 32,
    borderWidth: 1,
    borderColor: 'rgba(217, 74, 140, 0.5)',
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 40px rgba(217, 74, 140, 0.2)',
      backdropFilter: 'blur(20px)',
    } as any : {
      shadowColor: '#D94A8C', shadowOpacity: 0.5, shadowRadius: 20,
    }),
  },
  manifestoTitle: {
    color: '#FDFBF7',
    fontSize: 28,
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    lineHeight: 34,
    marginBottom: 20,
  },
  manifestoDivider: {
    height: 1.5,
    width: 60,
    backgroundColor: '#D94A8C',
    marginBottom: 24,
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 10px #D94A8C' } as any : {}),
  },
  manifestoBody: {
    color: '#A299A8',
    fontSize: 16,
    lineHeight: 26,
    marginBottom: 20,
  },
  manifestoCloseButton: {
    marginTop: 10,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#7A3EB8',
  },
  manifestoCloseText: {
    color: '#FDFBF7',
    fontSize: 14,
    fontWeight: '600',
  },
  techStackContainer: {
    width: '100%',
    maxWidth: 1000,
    marginTop: 20,
    marginBottom: 20,
    alignItems: 'center',
  },
  techStackTitle: {
    color: '#6D6175',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 24,
  },
  bentoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    width: '100%',
    paddingHorizontal: 20,
    justifyContent: 'center',
  },
  bentoCard: {
    flex: 1,
    minWidth: 280,
    backgroundColor: 'rgba(20, 10, 30, 0.7)',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(122, 62, 184, 0.3)',
    position: 'relative',
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(12px)',
    } as any : {}),
  },
  bentoGlow: {
    position: 'absolute',
    top: -30,
    right: -30,
    width: 100,
    height: 100,
    borderRadius: 50,
    opacity: 0.3,
    ...(Platform.OS === 'web' ? { filter: 'blur(30px)' } as any : {}),
  },
  bentoCardTitle: {
    color: '#FDFBF7',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
    zIndex: 2,
  },
  bentoCardDesc: {
    color: '#A299A8',
    fontSize: 14,
    lineHeight: 22,
    zIndex: 2,
  },
});