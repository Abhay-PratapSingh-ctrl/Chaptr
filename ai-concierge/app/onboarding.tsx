import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, TextInput, TouchableOpacity,
  View, ScrollView, SafeAreaView, ActivityIndicator,
  KeyboardAvoidingView, Platform
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { uploadVectorToWalrus } from '@/utils/walrusService';
import { fetchZkProof } from '@/utils/zkLoginService';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { getZkLoginSignature } from '@mysten/sui/zklogin';

const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
const PACKAGE_ID = '0x39d941cfafec6d528c50300fc71d60af3bc9c0d890596bbe998644382357c8c9';

const QUESTIONS = [
  { set: 1, text: "Given the choice of anyone in the world, whom would you want as a dinner guest?" },
  { set: 1, text: "Would you like to be famous? In what way?" },
  { set: 1, text: "Before making a telephone call, do you ever rehearse what you are going to say? Why?" },
  { set: 1, text: "What could constitute a 'perfect' day for you?" },
  { set: 1, text: "When did you last sing to yourself? To someone else?" },
  { set: 1, text: "If you were able to live to the age of 90 and retain either the mind or body of a 30-year-old for the last 60 years of your life, which would you want?" },
  { set: 1, text: "Do you have a secret hunch about how you will die?" },
  { set: 1, text: "For what in your life do you feel most grateful?" },
  { set: 1, text: "If you could change anything about the way you were raised, what would it be?" },
  { set: 1, text: "If you could wake up tomorrow having gained any one quality or ability, what would it be?" },
  { set: 2, text: "If a crystal ball could tell you the truth about yourself, your life, the future, or anything else, what would you want to know?" },
  { set: 2, text: "Is there something that you've dreamed of doing for a long time? Why haven't you done it?" },
  { set: 2, text: "What is the greatest accomplishment of your life?" },
  { set: 2, text: "What do you value most in a friendship?" },
  { set: 2, text: "What is your most treasured memory?" },
  { set: 2, text: "What is your most terrible memory?" },
  { set: 2, text: "If you knew that in one year you would die suddenly, would you change anything about the way you are now living? Why?" },
  { set: 2, text: "What roles do love and affection play in your life?" },
  { set: 2, text: "How close and warm is your family? Do you feel your childhood was happier than most other people's?" },
  { set: 2, text: "How do you feel about your relationship with your mother?" },
  { set: 3, text: 'Complete this sentence: "I wish I had someone with whom I could share..."' },
  { set: 3, text: "Share an embarrassing moment in your life." },
  { set: 3, text: "When did you last cry in front of another person? By yourself?" },
  { set: 3, text: "What, if anything, is too serious to be joked about?" },
  { set: 3, text: "If you were to die this evening with no opportunity to communicate with anyone, what would you most regret not having told someone? Why haven't you told them yet?" },
  { set: 3, text: "Your house, containing everything you own, catches fire. After saving your loved ones and pets, you have time to safely make a final dash to save any one item. What would it be? Why?" },
   { set: 3, text: "Of all the people in your family, whose death would you find most disturbing? Why?" },
];

export default function OnboardingFlow() {
  // Grab the crypto data passed from the login screen
  const { jwt, ephemeralSecret, maxEpoch, randomness } = useLocalSearchParams<{
    jwt?: string;
    ephemeralSecret?: string;
    maxEpoch?: string;
    randomness?: string;
  }>();

  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [showSetTransition, setShowSetTransition] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [agentReady, setAgentReady] = useState(false);
  const [blobId, setBlobId] = useState<string | null>(null);
  const [isMinting, setIsMinting] = useState(false);

  const worker = useRef<Worker | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      worker.current = new Worker('/aiWorker.js', { type: 'module' });
      worker.current.onmessage = async (event) => {
        const { type, vector } = event.data;
        if (type === 'complete') {
          // Step 2: Try uploading to Walrus (optional for demo)
          try {
            setStatusMsg('Uploading to Walrus...');
            const id = await uploadVectorToWalrus(vector, 'pending');
            setBlobId(id);
          } catch (e: any) {
            console.warn('Walrus upload skipped:', e.message);
            setBlobId('local-demo'); // Continue without Walrus for hackathon
          }
          setIsProcessing(false);
          setAgentReady(true);
        } else if (type === 'progress') {
          setStatusMsg('Analyzing your psychology...');
        }
      };
    }
    return () => worker.current?.terminate();
  }, []);

  const currentQuestion = QUESTIONS[currentIndex];
  const progress = (currentIndex / QUESTIONS.length) * 100;

  const handleNext = () => {
    if (isProcessing) return;
    const updatedAnswers = [...answers, currentAnswer];
    setAnswers(updatedAnswers);
    setCurrentAnswer('');

    if (currentIndex === QUESTIONS.length - 1) {
      finishQuestionnaire(updatedAnswers);
      return;
    }

    const nextQuestion = QUESTIONS[currentIndex + 1];
    if (nextQuestion.set !== currentQuestion.set) {
      setShowSetTransition(true);
    }
    setCurrentIndex(currentIndex + 1);
  };

  const handleSkip = () => {
    if (isProcessing) return;
    const updatedAnswers = [...answers, ''];
    setAnswers(updatedAnswers);
    setCurrentAnswer('');

    if (currentIndex === QUESTIONS.length - 1) {
      finishQuestionnaire(updatedAnswers);
      return;
    }

    const nextQuestion = QUESTIONS[currentIndex + 1];
    if (nextQuestion.set !== currentQuestion.set) {
      setShowSetTransition(true);
    }
    setCurrentIndex(currentIndex + 1);
  };

  const finishQuestionnaire = (allAnswers: string[]) => {
    setIsProcessing(true);
    setStatusMsg('Distilling your answers into a Digital Twin...');
    const megaContext = allAnswers
      .slice(0, QUESTIONS.length)
      .map((ans, i) => ({ question: QUESTIONS[i].text, answer: ans }))
      .filter(({ answer }) => answer.trim().length > 0)
      .map(({ question, answer }) => `Q: ${question} A: ${answer}`)
      .join(' ');
    worker.current?.postMessage({ text: megaContext });
  };

  // THE FINAL BOSS: ZK Proof → Sign → Mint on Sui
  const handleMintAgent = async () => {
    if (!jwt || !ephemeralSecret || !maxEpoch || !randomness) {
      setStatusMsg('Missing login credentials. Please restart the app.');
      return;
    }

    try {
      setIsMinting(true);
      setStatusMsg('Generating ZK Proof (complex math)...');

      // 1. Rebuild the ephemeral key from the bech32 string
      const ephemeralKeyPair = Ed25519Keypair.fromSecretKey(ephemeralSecret);

      // 2. Fetch the ZK Proof from Mysten's prover
      const { zkProof, userSalt, userAddress } = await fetchZkProof(
        jwt,
        ephemeralKeyPair,
        Number(maxEpoch),
        randomness
      );
      console.log('🔥 User Wallet:', userAddress);

      setStatusMsg('Minting Agent on the Blockchain...');

      // 3. Build the transaction
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::agent::mint_agent`,
        arguments: [tx.pure.string(blobId ?? 'local-demo')],
      });
      tx.setSender(userAddress);

      // 4. Sign the transaction with the ephemeral key
      const { bytes, signature: userSignature } = await tx.sign({
        client: suiClient,
        signer: ephemeralKeyPair,
      });

      // 5. Combine the user's signature with the ZK Proof
      const zkSignature = getZkLoginSignature({
        inputs: {
          ...zkProof,
          addressSeed: userSalt,
        },
        maxEpoch: Number(maxEpoch),
        userSignature,
      });

      // 6. Execute the transaction on the Sui blockchain!
      const result = await suiClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature: zkSignature,
        options: { showEffects: true },
      });

      console.log('🎉 SUCCESS! TX Digest:', result.digest);
      setStatusMsg('Agent Successfully Minted on Sui! 🎉');

      // Navigate to the main app after a brief celebration
      setTimeout(() => router.replace('/(tabs)'), 2000);

    } catch (error: any) {
      console.error('Mint failed:', error);
      setStatusMsg(`Mint failed: ${error.message}`);
      setIsMinting(false);
    }
  };

  // RENDER 1: SUCCESS
  if (agentReady) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.successContainer}>
          <View style={styles.agentAvatarGlow}>
            <LinearGradient colors={['#D94A8C', '#7A3EB8']} style={styles.agentAvatar}>
              <Text style={styles.agentIcon}>✨</Text>
            </LinearGradient>
          </View>
          <Text style={styles.successTitle}>Your Agent is Ready</Text>
          <Text style={styles.successSub}>
            Your personality has been encrypted and stored on Walrus.{'\n'}
            Connect with Google to mint it on Sui.
          </Text>
          {blobId && (
            <Text style={styles.blobIdText}>
              Blob: {blobId.slice(0, 12)}...{blobId.slice(-6)}
            </Text>
          )}
          {isMinting ? (
            <View style={[styles.primaryButton, { flexDirection: 'row' }]}>
              <ActivityIndicator color="#FFF" size="small" />
              <Text style={styles.primaryButtonText}>  {statusMsg}</Text>
            </View>
          ) : (
            <TouchableOpacity style={styles.primaryButton} onPress={handleMintAgent}>
              <Text style={styles.primaryButtonText}>
                {jwt ? 'Mint Agent on Sui →' : 'Connect with Google → Mint'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  // RENDER 2: SET TRANSITION
  if (showSetTransition) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.transitionContainer}>
          <Text style={styles.setNumber}>PART {currentQuestion.set}</Text>
          <Text style={styles.setTitle}>
            {currentQuestion.set === 1 && 'Breaking the Ice'}
            {currentQuestion.set === 2 && 'Going Deeper'}
            {currentQuestion.set === 3 && 'Vulnerability'}
          </Text>
          <Text style={styles.setDesc}>
            {currentQuestion.set === 1 && "Let's start with the basics. Don't overthink it."}
            {currentQuestion.set === 2 && 'These questions require more thought. Your agent is learning your values.'}
            {currentQuestion.set === 3 && 'The final stage. This is where true compatibility is found.'}
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={() => setShowSetTransition(false)}>
            <Text style={styles.primaryButtonText}>Begin Part {currentQuestion.set}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // RENDER 3: QUESTIONNAIRE
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.progressContainer}>
        <View style={[styles.progressBar, { width: `${progress}%` as any }]} />
      </View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.stepCounter}>Question {currentIndex + 1} of {QUESTIONS.length}</Text>
            <Text style={styles.privacyNote}>🔒 Local AI processing</Text>
          </View>
          <View style={styles.questionCard}>
            <Text style={styles.questionText}>{currentQuestion.text}</Text>
            <TextInput
              style={styles.input}
              placeholder="Share your thoughts..."
              placeholderTextColor="#6D6175"
              multiline
              autoFocus
              value={currentAnswer}
              onChangeText={setCurrentAnswer}
            />
          </View>
          {isProcessing ? (
            <View style={[styles.primaryButton, { flexDirection: 'row' }]}>
              <ActivityIndicator color="#FFF" size="small" />
              <Text style={styles.primaryButtonText}>  {statusMsg}</Text>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 12, width: '100%' }}>
              <TouchableOpacity
                onPress={handleSkip}
                style={styles.skipButton}
              >
                <Text style={styles.skipButtonText}>Skip</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleNext}
                disabled={!currentAnswer.trim()}
                style={[styles.primaryButton, { flex: 1 }, !currentAnswer.trim() && styles.disabledButton]}
              >
                <Text style={styles.primaryButtonText}>Continue</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  flex: { flex: 1 },
  progressContainer: { height: 4, backgroundColor: '#1A1621', width: '100%' },
  progressBar: { height: '100%', backgroundColor: '#D94A8C' },
  scrollContent: { padding: 24, paddingTop: 40, maxWidth: 600, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 30 },
  stepCounter: { color: '#D94A8C', fontWeight: '700', fontSize: 13, textTransform: 'uppercase', letterSpacing: 1 },
  privacyNote: { color: '#6D6175', fontSize: 12 },
  questionCard: { minHeight: 250, marginBottom: 40 },
  questionText: { fontSize: 26, color: '#FDFBF7', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', lineHeight: 36, marginBottom: 24 },
  input: { fontSize: 18, color: '#E0DCE3', lineHeight: 28, minHeight: 120, textAlignVertical: 'top', outlineStyle: 'none' } as any,
  primaryButton: { backgroundColor: '#D94A8C', height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', width: '100%' },
  primaryButtonText: { color: '#FFF', fontWeight: '700', fontSize: 16, letterSpacing: 0.5 },
  disabledButton: { backgroundColor: '#2A2432' },
  loadingRow: { flexDirection: 'row', alignItems: 'center' },
  transitionContainer: { flex: 1, justifyContent: 'center', padding: 40, alignItems: 'center', maxWidth: 500, alignSelf: 'center' },
  setNumber: { color: '#D94A8C', fontSize: 14, fontWeight: '800', letterSpacing: 2, marginBottom: 16 },
  setTitle: { fontSize: 40, color: '#FDFBF7', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', marginBottom: 16, textAlign: 'center' },
  setDesc: { fontSize: 16, color: '#A299A8', textAlign: 'center', lineHeight: 26, marginBottom: 40 },
  successContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 30, maxWidth: 500, alignSelf: 'center' },
  agentAvatarGlow: { padding: 4, borderRadius: 50, backgroundColor: 'rgba(217, 74, 140, 0.15)', marginBottom: 24 },
  agentAvatar: { width: 90, height: 90, borderRadius: 45, justifyContent: 'center', alignItems: 'center' },
  agentIcon: { fontSize: 36 },
  successTitle: { fontSize: 32, fontWeight: '700', color: '#FDFBF7', fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', marginBottom: 16 },
  successSub: { fontSize: 16, color: '#A299A8', textAlign: 'center', lineHeight: 24, marginBottom: 16 },
  blobIdText: { fontSize: 12, color: '#6D6175', fontFamily: 'monospace', marginBottom: 24 },
  skipButton: { height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, borderWidth: 1.5, borderColor: '#2A2432' },
  skipButtonText: { color: '#6D6175', fontWeight: '600', fontSize: 15 },
});