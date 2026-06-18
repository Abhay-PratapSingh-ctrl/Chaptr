import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  Image,
  Animated,
  Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { uploadVectorToWalrus } from '@/utils/walrusService';
import { buildOnboardingMemoryFacts, upsertTwinMemoryFacts } from '@/utils/twinMemory';

type SeedQuestion = {
  set: 1 | 2;
  kind: 'single' | 'multi' | 'text';
  text: string;
  hint: string;
  options?: string[];
  maxChoices?: number;
  allowCustom?: boolean;
  placeholder?: string;
};

const QUESTIONS: SeedQuestion[] = [
  {
    set: 1,
    kind: 'single',
    text: 'What are you hoping Chaptr helps you find?',
    hint: 'Pick the closest one.',
    options: [
      'Long-term relationship',
      'Slow-burn connection',
      'Dating and exploring',
      'Friends first',
      'Still figuring it out',
    ],
  },
  {
    set: 1,
    kind: 'multi',
    text: 'Pick three words that feel most like you.',
    hint: 'Your Twin uses these as a first personality signal.',
    maxChoices: 3,
    allowCustom: true,
    options: [
      'Curious',
      'Warm',
      'Ambitious',
      'Playful',
      'Calm',
      'Creative',
      'Grounded',
      'Adventurous',
      'Thoughtful',
      'Direct',
      'Romantic',
      'Intense',
    ],
  },
  {
    set: 1,
    kind: 'single',
    text: 'What dating pace feels right to you?',
    hint: 'How should your Twin read momentum?',
    options: [
      'Start light and see',
      'Consistent momentum',
      'Go deep early if it clicks',
      'Slow and intentional',
    ],
  },
  {
    set: 1,
    kind: 'multi',
    text: 'What kind of conversation feels like chemistry?',
    hint: 'Pick up to two.',
    maxChoices: 2,
    options: [
      'Playful banter',
      'Deep late-night talks',
      'Shared curiosity and ideas',
      'Flirty teasing',
      'Honest directness',
      'Quiet comfort',
    ],
  },
  {
    set: 2,
    kind: 'text',
    text: 'Describe your ideal first date in one small scene.',
    hint: 'Where are you, what are you doing, and why does it feel good?',
    placeholder:
      'A bookstore stop, chai after, and a walk that accidentally becomes two hours...',
  },
  {
    set: 2,
    kind: 'text',
    text: 'What kind of person do you naturally click with?',
    hint: 'Describe the energy, habits, or values you love being around.',
    placeholder:
      'Someone curious, kind under stress, and able to laugh at themselves...',
  },
  {
    set: 2,
    kind: 'text',
    text: 'What makes you feel cared for while dating?',
    hint: 'This helps your Twin understand your emotional language.',
    placeholder:
      'Consistency, small check-ins, honest plans, and room to breathe...',
  },
  {
    set: 2,
    kind: 'text',
    text: 'Give your Twin your green flags and hard noes.',
    hint: 'A few signals are enough.',
    placeholder:
      'Green flags: clear communication, warmth, follow-through. Hard noes: cruelty, games...',
  },
  {
    set: 2,
    kind: 'text',
    text: 'Write one message in your own voice.',
    hint: 'Finish this: Here is what I am genuinely hoping to find right now...',
    placeholder:
      'Here is what I am genuinely hoping to find right now...',
  },
];

const QuantumCore = () => {
  const spinValue1 = useRef(new Animated.Value(0)).current;
  const spinValue2 = useRef(new Animated.Value(0)).current;
  const spinValue3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(Animated.timing(spinValue1, { toValue: 1, duration: 3000, easing: Easing.linear, useNativeDriver: false })).start();
    Animated.loop(Animated.timing(spinValue2, { toValue: 1, duration: 4000, easing: Easing.linear, useNativeDriver: false })).start();
    Animated.loop(Animated.timing(spinValue3, { toValue: 1, duration: 5000, easing: Easing.linear, useNativeDriver: false })).start();
  }, [spinValue1, spinValue2, spinValue3]);

  const spin1 = spinValue1.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const spin2 = spinValue2.interpolate({ inputRange: [0, 1], outputRange: ['360deg', '0deg'] });
  const spin3 = spinValue3.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });

  return (
    <View style={styles.quantumCoreContainer}>
      {/* 3D Rings */}
      <Animated.View style={[styles.quantumLayer, styles.quantumLayer1, { transform: [{ rotateX: spin1 }, { rotateY: spin2 }, { rotateZ: spin3 }] }]} />
      <Animated.View style={[styles.quantumLayer, styles.quantumLayer2, { transform: [{ rotateX: spin2 }, { rotateY: spin3 }, { rotateZ: spin1 }] }]} />
      <Animated.View style={[styles.quantumLayer, styles.quantumLayer3, { transform: [{ rotateX: spin3 }, { rotateY: spin1 }, { rotateZ: spin2 }] }]} />
      
      {/* Pulsing Center */}
      <View style={styles.quantumCenterGlow} />
      <View style={styles.quantumCenterCore} />

      {/* Floor Glow */}
      <View style={styles.quantumFloorGlow} />
    </View>
  );
};

export default function OnboardingFlow() {
  const { jwt } = useLocalSearchParams<{ jwt?: string }>();

  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [selectedChoices, setSelectedChoices] = useState<string[]>([]);
  const [customChoice, setCustomChoice] = useState('');
  const [showWelcome, setShowWelcome] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [agentReady, setAgentReady] = useState(false);
  const [blobId, setBlobId] = useState<string | null>(null);

  const worker = useRef<Worker | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      worker.current = new Worker('/aiWorker.js', { type: 'module' });

      worker.current.onmessage = async (event) => {
        const { type, vector } = event.data;

        if (type === 'complete') {
          try {
            setStatusMsg('Uploading to Walrus...');
            const id = await uploadVectorToWalrus(vector, 'pending');
            setBlobId(id);
          } catch (error: any) {
            console.warn('Walrus upload skipped:', error.message);
            setBlobId('local-demo');
          }

          setIsProcessing(false);
          setAgentReady(true);
        }

        if (type === 'progress') {
          setStatusMsg('Building your Twin seed...');
        }
      };
    }

    return () => worker.current?.terminate();
  }, []);

  const currentQuestion = QUESTIONS[currentIndex];
  const progress = ((currentIndex + 1) / QUESTIONS.length) * 100;

  const currentAnswerValue = () => {
    if (currentQuestion.kind === 'text') {
      return currentAnswer.trim();
    }

    const custom = customChoice.trim();
    const choices = custom ? [...selectedChoices, custom] : selectedChoices;

    return choices.join(', ');
  };

  const canContinue = currentAnswerValue().length > 0;

  const resetDraft = () => {
    setCurrentAnswer('');
    setSelectedChoices([]);
    setCustomChoice('');
  };

  const toggleChoice = (option: string) => {
    if (currentQuestion.kind === 'single') {
      setSelectedChoices([option]);
      return;
    }

    setSelectedChoices((current) => {
      if (current.includes(option)) {
        return current.filter((item) => item !== option);
      }

      if (current.length >= (currentQuestion.maxChoices ?? 1)) {
        return current;
      }

      return [...current, option];
    });
  };

  const finishQuestionnaire = (allAnswers: string[]) => {
    upsertTwinMemoryFacts(buildOnboardingMemoryFacts(allAnswers, QUESTIONS)).catch(console.warn);
    setIsProcessing(true);
    setStatusMsg('Distilling your answers into a Digital Twin...');

    const megaContext = allAnswers
      .slice(0, QUESTIONS.length)
      .map((answer, index) => ({
        question: QUESTIONS[index].text,
        answer,
      }))
      .filter(({ answer }) => answer.trim().length > 0)
      .map(({ question, answer }) => `Q: ${question} A: ${answer}`)
      .join(' ');

    if (!worker.current) {
      console.warn('AI worker unavailable, continuing with local demo blob.');
      setBlobId('local-demo');
      setIsProcessing(false);
      setAgentReady(true);
      return;
    }

    worker.current.postMessage({ text: megaContext });
  };

  const advance = (answer: string) => {
    const updatedAnswers = [...answers, answer];

    setAnswers(updatedAnswers);
    resetDraft();

    if (currentIndex === QUESTIONS.length - 1) {
      finishQuestionnaire(updatedAnswers);
      return;
    }

    setCurrentIndex(currentIndex + 1);
  };

  const handleNext = () => {
    if (isProcessing || !canContinue) return;
    advance(currentAnswerValue());
  };

  const handleSkip = () => {
    if (isProcessing) return;
    advance('');
  };

  const HeaderLine = () => (
    <View style={styles.onboardingHeader}>
      <TouchableOpacity onPress={() => { if(showWelcome) router.back(); else if(currentIndex > 0) setCurrentIndex(currentIndex - 1); else setShowWelcome(true); }}>
        <Text style={styles.backArrow}>{'<-'}</Text>
      </TouchableOpacity>
      <View style={styles.progressLine}>
        <View style={[styles.progressFill, { width: `${progress}%` } as any]} />
      </View>
    </View>
  );

  if (agentReady) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.onboardingHeader}>
           <TouchableOpacity onPress={() => router.back()}><Text style={styles.backArrow}>{'<-'}</Text></TouchableOpacity>
           <View style={styles.progressLine}><View style={[styles.progressFill, { width: '100%' }]} /></View>
        </View>
        <View style={styles.successContainer}>
          <Text style={styles.successTitle}>Your Twin{'\n'}is ready.</Text>
          <Text style={styles.successSub}>Now let it scout.</Text>

          <QuantumCore />

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => {
              router.push({
                pathname: '/profile-setup',
                params: {
                  blobId: blobId ?? '',
                  jwt: jwt ?? '',
                },
              });
            }}
          >
            <LinearGradient colors={['#D94A8C', '#7A3EB8']} style={styles.actionButtonGradient}>
              <Text style={styles.actionButtonText}>Open Scout Feed</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (isProcessing) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.onboardingHeader}>
           <TouchableOpacity disabled><Text style={styles.backArrow}>{'<-'}</Text></TouchableOpacity>
           <View style={styles.progressLine}><View style={[styles.progressFill, { width: '95%' }]} /></View>
        </View>
        <View style={styles.successContainer}>
          <Text style={styles.successTitle}>Building{'\n'}your Twin...</Text>

          <QuantumCore />

          <View style={styles.checkmarksContainer}>
             <Text style={styles.checkmarkItem}>Learning humor   {'\u2713'}</Text>
             <Text style={styles.checkmarkItem}>Learning values  {'\u2713'}</Text>
             <Text style={styles.checkmarkItem}>Learning goals   {'\u2713'}</Text>
             <Text style={styles.checkmarkItemActive}>Learning boundaries  {'\u21BB'}</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (showWelcome) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.successContainer}>
          <View style={styles.onboardingHeaderAbsolute}>
            <Text style={styles.logoText}>Chaptr.</Text>
          </View>

          <QuantumCore />

          <Text style={styles.welcomeText}>
            Before anyone else,{'\n'}your Twin gets{'\n'}to know you.
          </Text>

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => setShowWelcome(false)}
          >
            <LinearGradient colors={['#D94A8C', '#7A3EB8']} style={styles.actionButtonGradient}>
              <Text style={styles.actionButtonText}>Let's begin</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <HeaderLine />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.stepIndicatorContainer}>
            <View style={styles.stepCircle}>
              <Text style={styles.stepCircleText}>{(currentIndex + 1).toString().padStart(2, '0')}</Text>
            </View>
            <Text style={styles.stepTitleText}>
              {currentQuestion.set === 1 ? 'Quick Signals' : 'Your Story'}
            </Text>
          </View>

          <View style={styles.questionCard}>
            <Text style={styles.questionText}>{currentQuestion.text}</Text>

            {currentQuestion.kind === 'text' ? (
              <TextInput
                style={styles.input}
                placeholder={currentQuestion.placeholder || "Write something..."}
                placeholderTextColor="#6D6175"
                multiline
                autoFocus
                value={currentAnswer}
                onChangeText={setCurrentAnswer}
              />
            ) : (
              <>
                <View style={styles.choiceWrapColumn}>
                  {currentQuestion.options?.map((option) => {
                    const active = selectedChoices.includes(option);

                    return (
                      <TouchableOpacity
                        key={option}
                        onPress={() => toggleChoice(option)}
                        style={[
                          styles.choiceChip,
                          active && styles.choiceChipActive,
                        ]}
                        activeOpacity={0.85}
                      >
                        <Text style={[styles.choiceIcon, active && styles.choiceIconActive]}>
                          {active ? '\u2728' : '\u2B21'}
                        </Text>
                        <Text
                          style={[
                            styles.choiceText,
                            active && styles.choiceTextActive,
                          ]}
                        >
                          {option}
                        </Text>
                        <Text style={styles.choiceArrow}>{'>'}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                {currentQuestion.allowCustom && (
                  <TextInput
                    style={styles.customInput}
                    placeholder="Add your own word"
                    placeholderTextColor="#6D6175"
                    value={customChoice}
                    onChangeText={setCustomChoice}
                  />
                )}
              </>
            )}
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={handleNext}
              disabled={!canContinue}
              style={[
                styles.primaryButton,
                styles.continueButton,
                !canContinue && styles.disabledButton,
              ]}
            >
              {canContinue ? (
                <LinearGradient colors={['#D94A8C', '#7A3EB8']} style={styles.actionButtonGradient}>
                  <Text style={styles.primaryButtonText}>Continue</Text>
                </LinearGradient>
              ) : (
                <Text style={styles.primaryButtonTextDisabled}>Continue</Text>
              )}
            </TouchableOpacity>
          </View>
          <Text style={styles.enterHint}>Press Enter {'\u21B5'}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#05030A',
  },
  flex: {
    flex: 1,
  },
  onboardingHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: 16,
    gap: 16,
  },
  onboardingHeaderAbsolute: {
    position: 'absolute',
    top: 60,
    left: 30,
  },
  logoText: {
    color: '#FDFBF7',
    fontSize: 24,
    fontWeight: '900',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
  },
  backArrow: {
    color: '#D94A8C',
    fontSize: 16,
    fontWeight: '700',
  },
  progressLine: {
    flex: 1,
    height: 4,
    backgroundColor: '#1A1621',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#D94A8C',
  },
  scrollContent: {
    padding: 24,
    paddingTop: 20,
    paddingBottom: 40,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },
  stepIndicatorContainer: {
    alignItems: 'center',
    marginBottom: 40,
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#7A3EB8',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  stepCircleText: {
    color: '#7A3EB8',
    fontSize: 12,
    fontWeight: '700',
  },
  stepTitleText: {
    color: '#FDFBF7',
    fontSize: 14,
    fontWeight: '600',
  },
  questionCard: {
    minHeight: 280,
    marginBottom: 34,
  },
  questionText: {
    fontSize: 26,
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    lineHeight: 36,
    marginBottom: 24,
  },
  input: {
    backgroundColor: '#0A0812',
    borderWidth: 1,
    borderColor: '#2A2432',
    borderRadius: 16,
    padding: 18,
    fontSize: 16,
    color: '#E0DCE3',
    lineHeight: 24,
    minHeight: 150,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,
  choiceWrapColumn: {
    flexDirection: 'column',
    gap: 12,
  },
  choiceChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#0A0812',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  choiceChipActive: {
    borderColor: '#D94A8C',
    backgroundColor: 'rgba(217, 74, 140, 0.08)',
  },
  choiceIcon: {
    color: '#6D6175',
    fontSize: 16,
    marginRight: 12,
  },
  choiceIconActive: {
    color: '#D94A8C',
  },
  choiceText: {
    flex: 1,
    color: '#A299A8',
    fontSize: 15,
    fontWeight: '600',
  },
  choiceTextActive: {
    color: '#FDFBF7',
  },
  choiceArrow: {
    color: '#6D6175',
    fontSize: 16,
  },
  customInput: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#0A0812',
    borderRadius: 16,
    padding: 16,
    color: '#E0DCE3',
    fontSize: 15,
    outlineStyle: 'none',
  } as any,
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButton: {
    height: 56,
    width: '100%',
    maxWidth: 240,
    borderRadius: 28,
    overflow: 'hidden',
  },
  continueButton: {
    flex: 1,
  },
  disabledButton: {
    backgroundColor: '#16131A',
    borderWidth: 1,
    borderColor: '#2A2432',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.5,
  },
  primaryButtonTextDisabled: {
    color: '#6D6175',
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.5,
  },
  enterHint: {
    color: '#6D6175',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 16,
  },
  successContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
    maxWidth: 500,
    alignSelf: 'center',
  },
  successTitle: {
    fontSize: 36,
    fontWeight: '700',
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 8,
    textAlign: 'center',
    lineHeight: 44,
  },
  successSub: {
    fontSize: 15,
    color: '#A299A8',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 16,
  },
  welcomeText: {
    fontSize: 32,
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    lineHeight: 40,
    textAlign: 'center',
    marginBottom: 40,
  },
  actionButton: {
    height: 56,
    width: 220,
    borderRadius: 28,
    overflow: 'hidden',
  },
  actionButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '700',
  },
  quantumCoreContainer: {
    width: 140,
    height: 140,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 40,
    position: 'relative',
    ...(Platform.OS === 'web' ? { perspective: 1000 } as any : {}),
  },
  quantumLayer: {
    position: 'absolute',
    borderWidth: 2,
    width: 100,
    height: 100,
    borderRadius: 50,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 15px rgba(217, 74, 140, 0.6), inset 0 0 15px rgba(217, 74, 140, 0.4)',
    } as any : {})
  },
  quantumLayer1: {
    borderColor: 'rgba(217, 74, 140, 1)',
  },
  quantumLayer2: {
    borderColor: 'rgba(122, 62, 184, 1)',
  },
  quantumLayer3: {
    borderColor: 'rgba(80, 40, 150, 1)',
    borderStyle: 'dashed',
  },
  quantumCenterGlow: {
    position: 'absolute',
    width: 60, height: 60, borderRadius: 30, backgroundColor: '#D94A8C',
    opacity: 0.6,
    ...(Platform.OS === 'web' ? { filter: 'blur(20px)' } as any : {})
  },
  quantumCenterCore: {
    position: 'absolute',
    width: 20, height: 20, borderRadius: 10, backgroundColor: '#FFF',
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 20px #FFF', filter: 'blur(1px)' } as any : {})
  },
  quantumFloorGlow: {
    position: 'absolute',
    bottom: -20,
    width: 80, height: 10, borderRadius: 5, backgroundColor: '#D94A8C',
    opacity: 0.3,
    ...(Platform.OS === 'web' ? { filter: 'blur(10px)' } as any : {})
  },
  checkmarksContainer: {
    marginTop: 20,
    alignItems: 'flex-start',
    gap: 12,
  },
  checkmarkItem: {
    color: '#A299A8',
    fontSize: 15,
    fontWeight: '500',
  },
  checkmarkItemActive: {
    color: '#D94A8C',
    fontSize: 15,
    fontWeight: '600',
  },
});