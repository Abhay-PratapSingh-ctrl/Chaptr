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

export default function OnboardingFlow() {
  const { jwt } = useLocalSearchParams<{ jwt?: string }>();

  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [currentAnswer, setCurrentAnswer] = useState('');
  const [selectedChoices, setSelectedChoices] = useState<string[]>([]);
  const [customChoice, setCustomChoice] = useState('');
  const [showSetTransition, setShowSetTransition] = useState(true);
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

    const nextIndex = currentIndex + 1;

    if (QUESTIONS[nextIndex].set !== currentQuestion.set) {
      setShowSetTransition(true);
    }

    setCurrentIndex(nextIndex);
  };

  const handleNext = () => {
    if (isProcessing || !canContinue) return;
    advance(currentAnswerValue());
  };

  const handleSkip = () => {
    if (isProcessing) return;
    advance('');
  };

  if (agentReady) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.successContainer}>
          <View style={styles.agentAvatarGlow}>
            <LinearGradient
              colors={['#D94A8C', '#7A3EB8']}
              style={styles.agentAvatar}
            >
              <Text style={styles.agentIcon}>AI</Text>
            </LinearGradient>
          </View>

          <Text style={styles.successTitle}>Your Twin Seed Is Ready</Text>

          <Text style={styles.successSub}>
            Your answers have been distilled into a first personality signal.{'\n'}
            Set up your profile to bring your Digital Twin on-chain.
          </Text>

          {blobId && (
            <Text style={styles.blobIdText}>
              Blob: {blobId.slice(0, 12)}...{blobId.slice(-6)}
            </Text>
          )}

          <TouchableOpacity
            style={styles.primaryButton}
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
            <Text style={styles.primaryButtonText}>Continue to Profile Setup</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (showSetTransition) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.transitionContainer}>
          <Text style={styles.setNumber}>PART {currentQuestion.set}</Text>

          <Text style={styles.setTitle}>
            {currentQuestion.set === 1 ? 'Quick Signals' : 'Your Twin Voice'}
          </Text>

          <Text style={styles.setDesc}>
            {currentQuestion.set === 1
              ? 'A few fast picks give your Twin its first read on your dating style.'
              : 'Short answers help your Twin understand your values and sound more like you.'}
          </Text>

          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => setShowSetTransition(false)}
          >
            <Text style={styles.primaryButtonText}>
              Begin Part {currentQuestion.set}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.progressContainer}>
        <View style={[styles.progressBar, { width: `${progress}%` as any }]} />
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.header}>
            <Text style={styles.stepCounter}>
              Step {currentIndex + 1} of {QUESTIONS.length}
            </Text>

            <Text style={styles.privacyNote}>Local AI seed</Text>
          </View>

          <View style={styles.questionCard}>
            <Text style={styles.questionText}>{currentQuestion.text}</Text>
            <Text style={styles.questionHint}>{currentQuestion.hint}</Text>

            {currentQuestion.kind === 'text' ? (
              <TextInput
                style={styles.input}
                placeholder={currentQuestion.placeholder}
                placeholderTextColor="#6D6175"
                multiline
                autoFocus
                value={currentAnswer}
                onChangeText={setCurrentAnswer}
              />
            ) : (
              <>
                <View style={styles.choiceWrap}>
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
                        <Text
                          style={[
                            styles.choiceText,
                            active && styles.choiceTextActive,
                          ]}
                        >
                          {option}
                        </Text>
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

          {isProcessing ? (
            <View style={[styles.primaryButton, styles.processingButton]}>
              <ActivityIndicator color="#FFF" size="small" />
              <Text style={styles.primaryButtonText}>
                {statusMsg || 'Processing...'}
              </Text>
            </View>
          ) : (
            <View style={styles.actionRow}>
              <TouchableOpacity onPress={handleSkip} style={styles.skipButton}>
                <Text style={styles.skipButtonText}>Skip</Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleNext}
                disabled={!canContinue}
                style={[
                  styles.primaryButton,
                  styles.continueButton,
                  !canContinue && styles.disabledButton,
                ]}
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
  root: {
    flex: 1,
    backgroundColor: '#0D0B10',
  },

  flex: {
    flex: 1,
  },

  progressContainer: {
    height: 4,
    backgroundColor: '#1A1621',
    width: '100%',
  },

  progressBar: {
    height: '100%',
    backgroundColor: '#D94A8C',
  },

  scrollContent: {
    padding: 24,
    paddingTop: 40,
    paddingBottom: 40,
    maxWidth: 600,
    width: '100%',
    alignSelf: 'center',
  },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 30,
    gap: 12,
  },

  stepCounter: {
    color: '#D94A8C',
    fontWeight: '700',
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },

  privacyNote: {
    color: '#6D6175',
    fontSize: 12,
    fontWeight: '700',
  },

  questionCard: {
    minHeight: 320,
    marginBottom: 34,
  },

  questionText: {
    fontSize: 28,
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    lineHeight: 38,
    marginBottom: 18,
  },

  questionHint: {
    color: '#A299A8',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 24,
  },

  input: {
    backgroundColor: '#16131A',
    borderWidth: 1,
    borderColor: '#2A2432',
    borderRadius: 18,
    padding: 18,
    fontSize: 17,
    color: '#E0DCE3',
    lineHeight: 26,
    minHeight: 170,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,

  choiceWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },

  choiceChip: {
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#16131A',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },

  choiceChipActive: {
    borderColor: '#D94A8C',
    backgroundColor: 'rgba(217, 74, 140, 0.16)',
  },

  choiceText: {
    color: '#A299A8',
    fontSize: 14,
    fontWeight: '700',
  },

  choiceTextActive: {
    color: '#FDFBF7',
  },

  customInput: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#16131A',
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
  },

  primaryButton: {
    backgroundColor: '#D94A8C',
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    width: '100%',
  },

  continueButton: {
    flex: 1,
  },

  processingButton: {
    flexDirection: 'row',
    gap: 10,
  },

  primaryButtonText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.5,
  },

  disabledButton: {
    backgroundColor: '#2A2432',
  },

  transitionContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: 40,
    alignItems: 'center',
    maxWidth: 500,
    alignSelf: 'center',
  },

  setNumber: {
    color: '#D94A8C',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 2,
    marginBottom: 16,
  },

  setTitle: {
    fontSize: 40,
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 16,
    textAlign: 'center',
  },

  setDesc: {
    fontSize: 16,
    color: '#A299A8',
    textAlign: 'center',
    lineHeight: 26,
    marginBottom: 40,
  },

  successContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 30,
    maxWidth: 500,
    alignSelf: 'center',
  },

  agentAvatarGlow: {
    padding: 4,
    borderRadius: 50,
    backgroundColor: 'rgba(217, 74, 140, 0.15)',
    marginBottom: 24,
  },

  agentAvatar: {
    width: 90,
    height: 90,
    borderRadius: 45,
    justifyContent: 'center',
    alignItems: 'center',
  },

  agentIcon: {
    color: '#FFF',
    fontSize: 24,
    fontWeight: '900',
  },

  successTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 16,
    textAlign: 'center',
  },

  successSub: {
    fontSize: 16,
    color: '#A299A8',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 16,
  },

  blobIdText: {
    fontSize: 12,
    color: '#6D6175',
    fontFamily: 'monospace',
    marginBottom: 24,
  },

  skipButton: {
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    borderWidth: 1.5,
    borderColor: '#2A2432',
  },

  skipButtonText: {
    color: '#6D6175',
    fontWeight: '600',
    fontSize: 15,
  },
});