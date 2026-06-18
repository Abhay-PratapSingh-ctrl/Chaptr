import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { mintDigitalTwin } from '@/utils/suiTransactions';
import { getJwtForTransaction, setupZkLoginParams, fetchZkProof, getEnokiEphemeralPublicKey, loadZkLoginParams, executeSponsoredZkLoginTransaction } from '@/utils/zkLoginService';
import { Transaction } from '@mysten/sui/transactions';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import {
  buildProfileMemoryFacts,
  buildScoutCapsule,
  saveLocalScoutCapsule,
  upsertTwinMemoryFacts,
} from '@/utils/twinMemory';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const PACKAGE_ID = process.env.EXPO_PUBLIC_PACKAGE_ID || '';
const TWIN_POOL_ID = process.env.EXPO_PUBLIC_TWIN_POOL_ID || '';
const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

const firstParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const extractBlobId = (result: any): string | null => {
  return result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? null;
};

const extractCreatedTwinId = (objectChanges: any[] | undefined): string | null => {
  const twin = objectChanges?.find(
    (change) =>
      change.type === 'created' &&
      typeof change.objectType === 'string' &&
      change.objectType.endsWith('::agent::DigitalTwin'),
  );

  return twin?.objectId ?? null;
};

const encryptPayload = (payload: unknown, userAddress: string): string => {
  const key = userAddress.slice(2, 18) || 'chaptr-local-key';
  const json = JSON.stringify(payload);

  return Array.from(json)
    .map((char, i) =>
      (char.charCodeAt(0) ^ key.charCodeAt(i % key.length))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
};

const uploadImageToWalrus = async (uri: string): Promise<string> => {
  const imageResponse = await fetch(uri);
  const imageBlob = await imageResponse.blob();

  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=10`, {
    method: 'PUT',
    headers: { 'Content-Type': imageBlob.type || 'application/octet-stream' },
    body: imageBlob,
  });

  if (!response.ok) {
    throw new Error(`Walrus image upload failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const blobId = extractBlobId(result);

  if (!blobId) throw new Error(`No image blobId in Walrus response: ${JSON.stringify(result)}`);

  return blobId;
};

const uploadPrivateProfileToWalrus = async (
  payload: unknown,
  userAddress: string,
): Promise<string> => {
  const encryptedPayload = encryptPayload(payload, userAddress);

  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=10`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedPayload,
  });

  if (!response.ok) {
    throw new Error(`Walrus private profile upload failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const blobId = extractBlobId(result);

  if (!blobId) throw new Error(`No private profile blobId: ${JSON.stringify(result)}`);

  return blobId;
};

const uploadScoutProfileToWalrus = async (payload: unknown): Promise<string> => {
  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=10`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Walrus scout profile upload failed: ${response.status} ${await response.text()}`);
  }

  const result = await response.json();
  const blobId = extractBlobId(result);

  if (!blobId) throw new Error(`No scout profile blobId: ${JSON.stringify(result)}`);

  return blobId;
};

export default function ProfileSetupScreen() {
  const params = useLocalSearchParams<{ blobId?: string; jwt?: string }>();
  const vectorBlobId = firstParam(params.blobId);
  const existingJwt = firstParam(params.jwt);

  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [location, setLocation] = useState('');
  const [bio, setBio] = useState('');
  const [gender, setGender] = useState('');
  const [interestedIn, setInterestedIn] = useState('');
  const [lookingFor, setLookingFor] = useState('');
  const [ageMin, setAgeMin] = useState('22');
  const [ageMax, setAgeMax] = useState('35');
  const [distanceKm, setDistanceKm] = useState('25');
  const [communicationStyle, setCommunicationStyle] = useState('');
  const [mustHave, setMustHave] = useState('');
  const [dealBreaker, setDealBreaker] = useState('');
  const [photos, setPhotos] = useState<string[]>(Array(6).fill(''));
  const [isMinting, setIsMinting] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const photoCount = photos.filter(Boolean).length;
  const validAge = Number(age) >= 18;

  const isFormReady = Boolean(
    name.trim() &&
      validAge &&
      gender &&
      interestedIn &&
      lookingFor &&
      bio.trim().length >= 12 &&
      photoCount >= 2,
  );

  const pickImage = async (index: number) => {
    const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permissionResult.granted) {
      Alert.alert('Photo access needed', 'Please allow photo access to add profile photos.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 5],
      quality: 0.55,
    });

    if (!result.canceled) {
      setPhotos((current) =>
        current.map((uri, i) => (i === index ? result.assets[0].uri : uri)),
      );
    }
  };

  const getJwtForMint = async (): Promise<string> => {
    if (existingJwt) return existingJwt;

    setStatusMsg('Opening Google sign-in...');

    return await getJwtForTransaction(true);
  };


  const handleMint = async (jwt: string) => {
    if (!vectorBlobId) throw new Error('No vector blob found. Please restart onboarding.');
    if (!PACKAGE_ID) throw new Error('Missing EXPO_PUBLIC_PACKAGE_ID');
    if (!TWIN_POOL_ID) throw new Error('Missing EXPO_PUBLIC_TWIN_POOL_ID');

    setStatusMsg('Generating ZK proof...');

    const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
    const { zkProof, addressSeed, userAddress } = await fetchZkProof(
      jwt,
      ephemeralKeyPair,
      maxEpoch,
      randomness,
    );

    console.log('Using zkLogin address:', userAddress);

    let photoBlobIds: string[] = [];

    try {
      setStatusMsg('Uploading photos to Walrus...');
      photoBlobIds = await Promise.all(
        photos.filter(Boolean).map((uri) => uploadImageToWalrus(uri)),
      );
    } catch (error: any) {
      Alert.alert('Photo Upload Failed', `Walrus rejected the image: ${error.message || error}. Please try a smaller image or try again.`);
      setIsMinting(false);
      return;
    }

    const profileFacts = buildProfileMemoryFacts({
      bio: bio.trim(),
      lookingFor,
      communicationStyle: communicationStyle.trim(),
      mustHave: mustHave.trim(),
      dealBreaker: dealBreaker.trim(),
    });

    const allMemoryFacts = await upsertTwinMemoryFacts(profileFacts);
    const scoutCapsule = buildScoutCapsule(allMemoryFacts);
    await saveLocalScoutCapsule(scoutCapsule);

    const privateProfilePayload = {
      version: 2,
      kind: 'chaptr-private-profile',
      vectorBlobId,
      profile: {
        name: name.trim(),
        age: Number(age),
        location: location.trim(),
        bio: bio.trim(),
        gender,
        photoBlobIds,
      },
      preferences: {
        interestedIn,
        lookingFor,
        ageRange: [Number(ageMin), Number(ageMax)],
        distanceKm: Number(distanceKm),
        communicationStyle: communicationStyle.trim(),
        mustHave: mustHave.trim(),
        dealBreaker: dealBreaker.trim(),
      },
      localTwinMemory: {
        storage: 'device-only',
        factCount: allMemoryFacts.length,
      },
      scoutCapsule,
      createdAt: new Date().toISOString(),
    };

    const scoutProfilePayload = {
      version: 2,
      kind: 'chaptr-scout-profile',
      displayName: name.trim(),
      age: Number(age),
      location: location.trim(),
      bio: bio.trim(),
      gender,
      interestedIn,
      lookingFor,
      communicationStyle: communicationStyle.trim(),
      mustHave: mustHave.trim(),
      dealBreaker: dealBreaker.trim(),
      scoutCapsule,
      previewPhotoBlobId: photoBlobIds[0] ?? null,
      createdAt: new Date().toISOString(),
    };

    let privateProfileBlobId = vectorBlobId;

    try {
      setStatusMsg('Saving private profile to Walrus...');
      privateProfileBlobId = await uploadPrivateProfileToWalrus(
        privateProfilePayload,
        userAddress,
      );
    } catch (error) {
      console.warn('Private profile upload skipped, using vector blob instead:', error);
    }

    setStatusMsg('Publishing scout profile to Walrus...');
    const scoutProfileBlobId = await uploadScoutProfileToWalrus(scoutProfilePayload);

    setStatusMsg('Minting Digital Twin and joining Twin Pool...');

    const tx = new Transaction();
    tx.setSender(userAddress);
    tx.moveCall({
      target: `${PACKAGE_ID}::agent::mint_agent_and_register`,
      arguments: [
        tx.object(TWIN_POOL_ID),
        tx.pure.string(privateProfileBlobId),
        tx.pure.string(scoutProfileBlobId),
      ],
    });

    const result = await executeSponsoredZkLoginTransaction(tx, userAddress, jwt);

    const objectChanges = (result as any).objectChanges;
    const twinObjectId = extractCreatedTwinId(objectChanges);

    console.log('TX Digest:', result.digest);
    console.log('Twin mint object changes:', result.objectChanges);
    console.log('Twin object id:', twinObjectId);
    console.log('Scout profile blob:', scoutProfileBlobId);

    const localEntries: [string, string][] = [
      ['chaptr:my-owner', userAddress],
      ['chaptr:my-gender', gender],
      ['chaptr:my-interested-in', interestedIn],
      ['chaptr:my-private-ref', privateProfileBlobId],
      ['chaptr:my-scout-ref', scoutProfileBlobId],
      ['chaptr:last-mint-digest', result.digest],
    ];

    if (twinObjectId) {
      localEntries.push(['chaptr:my-twin-id', twinObjectId]);
    }

    await AsyncStorage.multiSet(localEntries);

    setStatusMsg('Digital Twin joined the Twin Pool');
    setTimeout(() => router.replace('/(tabs)'), 1200);
  };

  // ── Re-register existing twin ──────────────────────────────────────────────
  // Used when the Walrus scout blob has expired but the on-chain twin is intact.
  // Calls register_existing_agent with the current scout ref (already re-uploaded).
  const handleReRegister = async () => {
    try {
      setIsMinting(true);

      const existingTwinId = await AsyncStorage.getItem('chaptr:my-twin-id');
      const existingOwner = await AsyncStorage.getItem('chaptr:my-owner');
      const existingScoutRef = await AsyncStorage.getItem('chaptr:my-scout-ref');

      if (!existingTwinId || !existingOwner || !existingScoutRef) {
        throw new Error('Missing local twin data. Cannot re-register.');
      }

      setStatusMsg('Opening Google sign-in...');
      const jwt = await getJwtForMint();

      setStatusMsg('Generating ZK proof...');
      const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
      const { zkProof, addressSeed, userAddress } = await fetchZkProof(
        jwt,
        ephemeralKeyPair,
        maxEpoch,
        randomness,
      );

      if (userAddress.toLowerCase() !== existingOwner.toLowerCase()) {
        throw new Error('Google account does not match this browser identity.');
      }

      setStatusMsg('Re-registering twin in pool...');

      const tx = new Transaction();
      tx.setSender(userAddress);
      tx.moveCall({
        target: `${PACKAGE_ID}::agent::register_existing_agent`,
        arguments: [
          tx.object(TWIN_POOL_ID),
          tx.object(existingTwinId),
          tx.pure.string(existingScoutRef),
        ],
      });

      const result = await executeSponsoredZkLoginTransaction(
        tx, userAddress, jwt
      );

      console.log('Re-register digest:', result.digest);
      setStatusMsg('Twin re-registered in pool ✅');
      setTimeout(() => router.replace('/(tabs)'), 1200);
    } catch (e: any) {
      console.error('Re-register failed:', e);
      setStatusMsg(`Re-register failed: ${e.message}`);
    } finally {
      setIsMinting(false);
    }
  };

  const handleComplete = async () => {
    try {
      setIsMinting(true);
      const jwt = await getJwtForMint();
      await handleMint(jwt);
    } catch (e: any) {
      console.error('Mint failed:', e);
      setStatusMsg(`Mint failed: ${e.message}`);
      setIsMinting(false);
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.title}>The Human Behind the Agent</Text>
            <Text style={styles.subtitle}>
              Set up the profile people will see, then tell your agent who to look for.
            </Text>
            {vectorBlobId && (
              <Text style={styles.blobConfirm}>
                Vector stored: {vectorBlobId.slice(0, 10)}...
              </Text>
            )}
          </View>

          {/* ── Re-register banner — shown when twin already exists ── */}
          <View style={styles.reRegisterBanner}>
            <Text style={styles.reRegisterTitle}>Already have a Twin?</Text>
            <Text style={styles.reRegisterBody}>
              If your scout profile expired or went missing from the pool, re-register your
              existing Twin without creating a new one.
            </Text>
            <TouchableOpacity
              onPress={handleReRegister}
              disabled={isMinting}
              style={styles.reRegisterButtonWrap}
              activeOpacity={0.85}
            >
              <LinearGradient
                colors={isMinting ? ['#1a2a1a', '#1a2a1a'] : ['#4ade80', '#22c55e']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.reRegisterButton}
              >
                {isMinting ? (
                  <View style={styles.loadingRow}>
                    <ActivityIndicator color="#fff" size="small" />
                    <Text style={styles.reRegisterButtonText}>{statusMsg || 'Processing...'}</Text>
                  </View>
                ) : (
                  <Text style={styles.reRegisterButtonText}>Re-register Existing Twin</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>

          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerLabel}>or create a new Twin</Text>
            <View style={styles.dividerLine} />
          </View>

          <Text style={styles.sectionLabel}>Your Photos</Text>

          <View style={styles.photoGrid}>
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <TouchableOpacity
                key={index}
                style={styles.photoSlot}
                activeOpacity={0.7}
                onPress={() => pickImage(index)}
              >
                {photos[index] ? (
                  <Image source={{ uri: photos[index] }} style={styles.selectedImage} />
                ) : (
                  <View style={styles.photoPlaceholderEmpty}>
                    <Text style={styles.plusIcon}>+</Text>
                  </View>
                )}
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.photoHint}>{photoCount}/2 minimum photos selected</Text>

          <Text style={styles.sectionLabel}>The Basics</Text>

          <View style={styles.inputGroup}>
            <TextInput
              style={styles.input}
              placeholder="First name"
              placeholderTextColor="#6D6175"
              value={name}
              onChangeText={setName}
            />
            <TextInput
              style={styles.input}
              placeholder="Age"
              placeholderTextColor="#6D6175"
              keyboardType="numeric"
              maxLength={2}
              value={age}
              onChangeText={setAge}
            />
            <TextInput
              style={styles.input}
              placeholder="City"
              placeholderTextColor="#6D6175"
              value={location}
              onChangeText={setLocation}
            />
            <TextInput
              style={[styles.input, styles.bioInput]}
              placeholder="Short bio"
              placeholderTextColor="#6D6175"
              multiline
              value={bio}
              onChangeText={setBio}
            />
          </View>

          <Text style={styles.sectionLabel}>I am a</Text>
          <View style={styles.pillContainer}>
            {['Woman', 'Man', 'Non-binary'].map((option) => (
              <TouchableOpacity
                key={option}
                onPress={() => setGender(option)}
                style={[styles.pill, gender === option && styles.pillActive]}
              >
                <Text style={[styles.pillText, gender === option && styles.pillTextActive]}>
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Interested in</Text>
          <View style={styles.pillContainer}>
            {['Women', 'Men', 'Everyone'].map((option) => (
              <TouchableOpacity
                key={option}
                onPress={() => setInterestedIn(option)}
                style={[styles.pill, interestedIn === option && styles.pillActive]}
              >
                <Text style={[styles.pillText, interestedIn === option && styles.pillTextActive]}>
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Looking for</Text>
          <View style={styles.pillContainer}>
            {['Long-term', 'Short-term', 'Friends first', 'Open to explore'].map((option) => (
              <TouchableOpacity
                key={option}
                onPress={() => setLookingFor(option)}
                style={[styles.pill, lookingFor === option && styles.pillActive]}
              >
                <Text style={[styles.pillText, lookingFor === option && styles.pillTextActive]}>
                  {option}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.sectionLabel}>Match Preferences</Text>
          <View style={styles.inputGroup}>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.halfInput]}
                placeholder="Min age"
                placeholderTextColor="#6D6175"
                keyboardType="numeric"
                value={ageMin}
                onChangeText={setAgeMin}
              />
              <TextInput
                style={[styles.input, styles.halfInput]}
                placeholder="Max age"
                placeholderTextColor="#6D6175"
                keyboardType="numeric"
                value={ageMax}
                onChangeText={setAgeMax}
              />
            </View>
            <TextInput
              style={styles.input}
              placeholder="Distance in km"
              placeholderTextColor="#6D6175"
              keyboardType="numeric"
              value={distanceKm}
              onChangeText={setDistanceKm}
            />
            <TextInput
              style={styles.input}
              placeholder="Communication style you like"
              placeholderTextColor="#6D6175"
              value={communicationStyle}
              onChangeText={setCommunicationStyle}
            />
            <TextInput
              style={styles.input}
              placeholder="One must-have"
              placeholderTextColor="#6D6175"
              value={mustHave}
              onChangeText={setMustHave}
            />
            <TextInput
              style={styles.input}
              placeholder="One deal-breaker"
              placeholderTextColor="#6D6175"
              value={dealBreaker}
              onChangeText={setDealBreaker}
            />
          </View>

          {statusMsg ? <Text style={styles.statusText}>{statusMsg}</Text> : null}

          <TouchableOpacity
            onPress={handleComplete}
            disabled={!isFormReady || isMinting}
            style={styles.submitWrapper}
          >
            <LinearGradient
              colors={!isFormReady || isMinting ? ['#2A2432', '#2A2432'] : ['#D94A8C', '#7A3EB8']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.button}
            >
              {isMinting ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color="#fff" size="small" />
                  <Text style={styles.buttonText}>{statusMsg || 'Processing...'}</Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Create My Agent</Text>
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
  scrollContent: {
    padding: 24,
    paddingTop: 40,
    paddingBottom: 80,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },
  header: { marginBottom: 32 },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 12,
  },
  subtitle: { fontSize: 15, color: '#A299A8', lineHeight: 22 },
  blobConfirm: { marginTop: 10, fontSize: 12, color: '#4ade80', fontFamily: 'monospace' },

  // ── Re-register banner ──
  reRegisterBanner: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.28)',
    backgroundColor: 'rgba(74,222,128,0.06)',
    padding: 16,
    marginBottom: 8,
  },
  reRegisterTitle: {
    color: '#4ade80',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  reRegisterBody: {
    color: '#8DA89A',
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 14,
  },
  reRegisterButtonWrap: {
    height: 46,
    borderRadius: 14,
    overflow: 'hidden',
  },
  reRegisterButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reRegisterButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },

  // ── Divider ──
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 20,
    marginBottom: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#2A2432',
  },
  dividerLabel: {
    color: '#4A4356',
    fontSize: 12,
    fontWeight: '600',
  },

  sectionLabel: {
    color: '#D94A8C',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 16,
    marginTop: 24,
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 12,
  },
  photoSlot: { width: '31%', aspectRatio: 0.7, borderRadius: 12, overflow: 'hidden', marginBottom: 12 },
  photoPlaceholderEmpty: {
    flex: 1,
    backgroundColor: '#16131A',
    borderWidth: 1,
    borderColor: '#2A2432',
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
  },
  selectedImage: { width: '100%', height: '100%', borderRadius: 12 },
  plusIcon: { color: '#6D6175', fontSize: 24, fontWeight: '300' },
  photoHint: { color: '#6D6175', fontSize: 13, textAlign: 'center', marginTop: 4 },
  inputGroup: { gap: 14 },
  input: {
    backgroundColor: '#16131A',
    borderRadius: 12,
    padding: 18,
    color: '#E0DCE3',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2A2432',
    outlineStyle: 'none',
  } as any,
  bioInput: { minHeight: 92, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 12 },
  halfInput: { flex: 1 },
  pillContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  pill: {
    backgroundColor: '#16131A',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 30,
    borderWidth: 1,
    borderColor: '#2A2432',
  },
  pillActive: { backgroundColor: 'rgba(217, 74, 140, 0.15)', borderColor: '#D94A8C' },
  pillText: { color: '#A299A8', fontSize: 15, fontWeight: '600' },
  pillTextActive: { color: '#D94A8C' },
  statusText: { marginTop: 16, color: '#A299A8', fontSize: 13, textAlign: 'center', fontStyle: 'italic' },
  submitWrapper: { marginTop: 48 },
  button: { height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  buttonText: { color: '#FFF', fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
});