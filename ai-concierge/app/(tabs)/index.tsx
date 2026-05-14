import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  View,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  SafeAreaView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

export default function ChaptrScreen() {
  const [inputText, setInputText] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [vectorReady, setVectorReady] = useState(false);

  // Hidden state for the actual vector (Phase 2: Sui Integration)
  const [hiddenVector, setHiddenVector] = useState<number[] | null>(null);
  const worker = useRef<Worker | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web') {
      worker.current = new Worker('/aiWorker.js', { type: 'module' });

      worker.current.addEventListener('message', (event) => {
        const { type, info, vector, error } = event.data;

        if (type === 'progress') {
          if (info?.status === 'downloading') {
            setStatusMsg('Your agent is initializing...');
          } else if (info?.status === 'ready') {
            setStatusMsg('Analyzing your vibe...');
          }
        } else if (type === 'complete') {
          setHiddenVector(vector); 
          setVectorReady(true);    
          setStatusMsg('');
          setLoading(false);
        } else if (type === 'error') {
          setStatusMsg('Connection interrupted. Try again.');
          setLoading(false);
        }
      });
    }
    return () => worker.current?.terminate();
  }, []);

  const handleGenerate = () => {
    if (!inputText.trim() || !worker.current) return;
    
    setLoading(true);
    setVectorReady(false);
    setStatusMsg('Your agent is taking notes...');
    worker.current.postMessage({ text: inputText });
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
          keyboardShouldPersistTaps="handled"
        >
          {/* Chaptr Header */}
          <View style={styles.header}>
            <Text style={styles.brand}>Chaptr.</Text>
            <Text style={styles.subtitle}>
              We talk. We swap. You connect.
            </Text>
          </View>

          {!vectorReady ? (
            /* State 1: The Hinge-Style Prompt Card */
            <View style={styles.cardContainer}>
              <View style={styles.card}>
                <View style={styles.promptBadge}>
                  <Text style={styles.promptBadgeText}>Train your Agent</Text>
                </View>
                <Text style={styles.promptText}>
                  What does your next chapter look like?
                </Text>
                
                <TextInput
                  style={styles.input}
                  placeholder="I'm looking for someone who loves spontaneous weekend trips, respects quiet mornings, and doesn't take themselves too seriously..."
                  placeholderTextColor="#6D6175"
                  multiline
                  numberOfLines={6}
                  value={inputText}
                  onChangeText={setInputText}
                />
              </View>

              <Text style={styles.privacyNote}>
                🔒 Your thoughts never leave this device.
              </Text>

              <TouchableOpacity
                onPress={handleGenerate}
                disabled={!inputText.trim() || loading}
                activeOpacity={0.8}
              >
                <LinearGradient
                  colors={
                    !inputText.trim() || loading
                      ? ['#2A2432', '#2A2432'] // Disabled state
                      : ['#D94A8C', '#7A3EB8'] // Soft pink to purple gradient
                  }
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.button}
                >
                  {loading ? (
                    <View style={styles.buttonRow}>
                      <ActivityIndicator color="#FFF" size="small" />
                      <Text style={styles.buttonText}>  {statusMsg}</Text>
                    </View>
                  ) : (
                    <Text style={styles.buttonText}>Create My Agent</Text>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            /* State 2: Success - Agent Ready (Inspired by image) */
            <View style={styles.successContainer}>
              <View style={styles.agentAvatarGlow}>
                <LinearGradient
                  colors={['#D94A8C', '#7A3EB8']}
                  style={styles.agentAvatar}
                >
                  <Text style={styles.agentIcon}>✨</Text>
                </LinearGradient>
              </View>
              
              <Text style={styles.successTitle}>Your Agent is Ready</Text>
              <Text style={styles.successSub}>
                Your digital twin has been securely created. It will now scout, chat, and vibe-check matches on your behalf.
              </Text>
              
              <View style={styles.actionBox}>
                <Text style={styles.actionText}>
                  Connect your account to let your agent enter the dating pool.
                </Text>
              </View>

              <TouchableOpacity style={styles.outlineButton}>
                <Text style={styles.outlineButtonText}>Connect zkLogin</Text>
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
    backgroundColor: '#0D0B10', // Deep, warm midnight dark mode
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    padding: 24,
    paddingTop: Platform.OS === 'web' ? 80 : 60,
    paddingBottom: 60,
    maxWidth: 500,
    width: '100%',
    alignSelf: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  brand: {
    fontSize: 32,
    fontWeight: '700',
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif', // Hinge-style editorial feel
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 15,
    color: '#A299A8',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  cardContainer: {
    width: '100%',
  },
  card: {
    backgroundColor: '#16131A', // Slightly lighter than background
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: 'rgba(217, 74, 140, 0.15)', // Very soft pink outline
    marginBottom: 16,
  },
  promptBadge: {
    backgroundColor: 'rgba(217, 74, 140, 0.1)',
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    marginBottom: 16,
  },
  promptBadgeText: {
    color: '#D94A8C',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  promptText: {
    fontSize: 22,
    fontWeight: '600',
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    lineHeight: 30,
    marginBottom: 16,
  },
  input: {
    backgroundColor: 'transparent',
    color: '#E0DCE3',
    fontSize: 16,
    lineHeight: 24,
    minHeight: 120,
    textAlignVertical: 'top',
    outlineStyle: 'none',
  } as any,
  privacyNote: {
    fontSize: 12,
    color: '#6D6175',
    textAlign: 'center',
    marginBottom: 24,
  },
  button: {
    borderRadius: 30, // Fully rounded pill like Hinge
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#D94A8C',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  /* Success State Styles */
  successContainer: {
    alignItems: 'center',
    marginTop: 20,
  },
  agentAvatarGlow: {
    padding: 4,
    borderRadius: 50,
    backgroundColor: 'rgba(217, 74, 140, 0.15)',
    marginBottom: 24,
  },
  agentAvatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  agentIcon: {
    fontSize: 32,
  },
  successTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#FDFBF7',
    fontFamily: Platform.OS === 'ios' ? 'Georgia' : 'serif',
    marginBottom: 12,
  },
  successSub: {
    fontSize: 15,
    color: '#A299A8',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
    paddingHorizontal: 10,
  },
  actionBox: {
    backgroundColor: '#16131A',
    padding: 16,
    borderRadius: 16,
    width: '100%',
    marginBottom: 24,
    borderWidth: 1,
    borderColor: '#2A2432',
  },
  actionText: {
    fontSize: 14,
    color: '#E0DCE3',
    textAlign: 'center',
    lineHeight: 20,
  },
  outlineButton: {
    borderWidth: 1.5,
    borderColor: '#D94A8C',
    borderRadius: 30,
    height: 56,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  outlineButtonText: {
    color: '#D94A8C',
    fontSize: 16,
    fontWeight: '600',
  },
});