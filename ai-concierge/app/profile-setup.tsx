import React, { useState, useEffect } from 'react';
import {
  StyleSheet, Text, TextInput, TouchableOpacity,
  View, ScrollView, SafeAreaView, Platform,
  KeyboardAvoidingView, ActivityIndicator
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { setupZkLoginParams } from '@/utils/zkLoginService';
import { mintDigitalTwin } from '@/utils/suiTransactions';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

export default function ProfileSetupScreen() {
  const { blobId } = useLocalSearchParams<{ blobId: string }>();

  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [gender, setGender] = useState('');
  const [preference, setPreference] = useState('');
  const [photos, setPhotos] = useState<number[]>([1, 0, 0, 0, 0, 0]);
  const [isMinting, setIsMinting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [nonce, setNonce] = useState('');

  // Generate ephemeral keypair + nonce on screen load
  useEffect(() => {
    const init = async () => {
      try {
        const params = await setupZkLoginParams();
        setNonce(params.nonce);
      } catch (e) {
        console.error('ZK init failed:', e);
      }
    };
    init();
  }, []);

  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'aiconcierge' });

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes: ['openid', 'email', 'profile'],
      redirectUri,
      extraParams: { nonce },   // binds Google JWT to ephemeral keypair
    },
    { authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth' }
  );

  // Phase 2 complete — JWT received, trigger mint
  useEffect(() => {
    if (response?.type === 'success') {
      const { id_token } = response.params;
      console.log('✅ GOOGLE JWT SECURED:', id_token);
      handleMint(id_token);
    }
    if (response?.type === 'error') {
      setStatusMsg('Google sign-in failed. Try again.');
      setIsMinting(false);
    }
  }, [response]);

  const handleMint = async (jwt: string) => {
    try {
      setStatusMsg('Generating ZK proof...');
      // Phase 3 goes here — for now log success
      console.log('JWT ready for ZK proof:', jwt.slice(0, 30) + '...');

      // TODO Phase 3: send jwt → Mysten proving service → get zkProof → mint
      // await mintDigitalTwin(blobId, zkProof, ephemeralKeyPair);

      setStatusMsg('Agent live on-chain ✓');
      router.replace('/(tabs)');
    } catch (e: any) {
      setStatusMsg(`Mint failed: ${e.message}`);
      setIsMinting(false);
    }
  };

  const handleComplete = async () => {
    if (!blobId) {
      setStatusMsg('No vector found. Please restart onboarding.');
      return;
    }
    if (!nonce) {
      setStatusMsg('ZK params not ready. Please wait...');
      return;
    }
    setIsMinting(true);
    setStatusMsg('Opening Google sign-in...');
    await promptAsync();
  };

  const isFormReady = name && age && gender && preference;

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

          <View style={styles.header}>
            <Text style={styles.title}>The Human Behind the Agent</Text>
            <Text style={styles.subtitle}>
              Your agent is ready to scout. Set up the profile your match will see.
            </Text>
            {blobId && (
              <Text style={styles.blobConfirm}>
                ✓ Vector stored: {blobId.slice(0, 10)}...
              </Text>
            )}
          </View>

          {/* Photos */}
          <Text style={styles.sectionLabel}>Your Photos</Text>
          <View style={styles.photoGrid}>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <TouchableOpacity key={index} style={styles.photoSlot} activeOpacity={0.7}>
                {photos[index] === 1 ? (
                  <LinearGradient colors={['#2A2432', '#1A1621']} style={styles.photoPlaceholderFilled}>
                    <Text style={styles.photoIcon}>📸</Text>
                  </LinearGradient>
                ) : (
                  <View style={styles.photoPlaceholderEmpty}>
                    <Text style={styles.plusIcon}>+</Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.photoHint}>Add at least 2 photos to continue.</Text>

          {/* Basic Info */}
          <Text style={styles.sectionLabel}>The Basics</Text>
          <View style={styles.inputGroup}>
            <TextInput style={styles.input} placeholder="First Name" placeholderTextColor="#6D6175" value={name} onChangeText={setName} />
            <TextInput style={styles.input} placeholder="Age" placeholderTextColor="#6D6175" keyboardType="numeric" maxLength={2} value={age} onChangeText={setAge} />
          </View>

          {/* Gender */}
          <Text style={styles.sectionLabel}>I am a...</Text>
          <View style={styles.pillContainer}>
            {['Woman', 'Man', 'Non-binary'].map((option) => (
              <TouchableOpacity key={option} onPress={() => setGender(option)} style={[styles.pill, gender === option && styles.pillActive]}>
                <Text style={[styles.pillText, gender === option && styles.pillTextActive]}>{option}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Preference */}
          <Text style={styles.sectionLabel}>Looking to connect with...</Text>
          <View style={styles.pillContainer}>
            {['Women', 'Men', 'Everyone'].map((option) => (
              <TouchableOpacity key={option} onPress={() => setPreference(option)} style={[styles.pill, preference === option && styles.pillActive]}>
                <Text style={[styles.pillText, preference === option && styles.pillTextActive]}>{option}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {statusMsg ? <Text style={styles.statusText}>{statusMsg}</Text> : null}

          <TouchableOpacity
            onPress={handleComplete}
            disabled={!isFormReady || isMinting || !request}
            style={styles.submitWrapper}
          >
            <LinearGradient
              colors={(!isFormReady || isMinting || !request) ? ['#2A2432', '#2A2432'] : ['#D94A8C', '#7A3EB8']}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={styles.button}
            >
              {isMinting ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={styles.buttonText}>{statusMsg || 'Processing...'}</Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Enter Chaptr</Text>
              )}
            </LinearGradient>
          </TouchableOpacity>

        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  flex: { flex: 1 },
  scrollContent: { padding: 24, paddingTop: 40, paddingBottom: 80, maxWidth: 600, width: '100%', alignSelf: 'center' },
  header: { marginBottom: 32 },
  title: { fontSize: 28, fontWeight: '700', color: '#FDFBF7', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', marginBottom: 12 },
  subtitle: { fontSize: 15, color: '#A299A8', lineHeight: 22 },
  blobConfirm: { marginTop: 10, fontSize: 12, color: '#4ade80', fontFamily: 'monospace' },
  sectionLabel: { color: '#D94A8C', fontSize: 13, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 16, marginTop: 24 },
  photoGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12 },
  photoSlot: { width: '31%', aspectRatio: 0.7, borderRadius: 12, overflow: 'hidden', marginBottom: 12 },
  photoPlaceholderEmpty: { flex: 1, backgroundColor: '#16131A', borderWidth: 1, borderColor: '#2A2432', borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center', borderRadius: 12 },
  photoPlaceholderFilled: { flex: 1, justifyContent: 'center', alignItems: 'center', borderRadius: 12 },
  plusIcon: { color: '#6D6175', fontSize: 24, fontWeight: '300' },
  photoIcon: { fontSize: 32 },
  photoHint: { color: '#6D6175', fontSize: 13, textAlign: 'center', marginTop: 4 },
  inputGroup: { gap: 16 },
  input: { backgroundColor: '#16131A', borderRadius: 12, padding: 18, color: '#E0DCE3', fontSize: 16, borderWidth: 1, borderColor: '#2A2432', outlineStyle: 'none' } as any,
  pillContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  pill: { backgroundColor: '#16131A', paddingVertical: 14, paddingHorizontal: 24, borderRadius: 30, borderWidth: 1, borderColor: '#2A2432' },
  pillActive: { backgroundColor: 'rgba(217, 74, 140, 0.15)', borderColor: '#D94A8C' },
  pillText: { color: '#A299A8', fontSize: 15, fontWeight: '600' },
  pillTextActive: { color: '#D94A8C' },
  statusText: { marginTop: 16, color: '#A299A8', fontSize: 13, textAlign: 'center', fontStyle: 'italic' },
  submitWrapper: { marginTop: 48 },
  button: { height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center' },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
});