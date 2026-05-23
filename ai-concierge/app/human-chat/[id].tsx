import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';

interface Message {
  id: string;
  text: string;
  sender: 'me' | 'them' | 'system';
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

const HUMAN_MATCHES_KEY = 'chaptr:human-matches';

const firstParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const humanChatKey = (matchId: string) => `chaptr:human-chat:${matchId}`;

const loadHumanMatch = async (matchId: string): Promise<HumanMatch | null> => {
  const raw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    return (
      parsed.find(
        (item) =>
          item?.proposalId === matchId ||
          item?.participantTwinId === matchId ||
          item?.participantOwner === matchId,
      ) ?? null
    );
  } catch {
    return null;
  }
};

export default function HumanChatScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    name?: string | string[];
  }>();

  const matchId = firstParam(params.id) ?? 'unknown-match';
  const routeName = firstParam(params.name);

  const [match, setMatch] = useState<HumanMatch | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  const listRef = useRef<FlatList<Message> | null>(null);

  const displayName = match?.participantName || routeName || 'Your match';

  const introMessage = useMemo<Message>(
    () => ({
      id: 'intro',
      text: `Human chat opened with ${displayName}. Both Twins helped create this match, but this room is for the two of you.`,
      sender: 'system',
      createdAt: new Date().toISOString(),
    }),
    [displayName],
  );

  useEffect(() => {
    const load = async () => {
      try {
        setIsLoading(true);

        const [savedChatRaw, savedMatch] = await Promise.all([
          AsyncStorage.getItem(humanChatKey(matchId)),
          loadHumanMatch(matchId),
        ]);

        setMatch(savedMatch);

        const restored = savedChatRaw ? JSON.parse(savedChatRaw) : null;
        setMessages(Array.isArray(restored) ? restored : [introMessage]);
      } catch (error) {
        console.warn('Failed to load human chat:', error);
        setMessages([introMessage]);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [introMessage, matchId]);

  useEffect(() => {
    if (isLoading || messages.length === 0) return;

    AsyncStorage.setItem(humanChatKey(matchId), JSON.stringify(messages)).catch(console.warn);
  }, [isLoading, matchId, messages]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 180);

    return () => clearTimeout(timeout);
  }, [messages]);

  const handleSend = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;

    const userMessage: Message = {
      id: `${Date.now()}`,
      text: trimmed,
      sender: 'me',
      createdAt: new Date().toISOString(),
    };

    setMessages((current) => [...current, userMessage]);
    setInputText('');
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loading}>
          <Text style={styles.loadingText}>Opening human chat...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.name}>{displayName}</Text>
            <Text style={styles.mode}>Human Match</Text>
          </View>

          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.matchBanner}>
          <Text style={styles.bannerKicker}>Match Mode</Text>
          <Text style={styles.bannerText}>
            Twins made the introduction. Now the conversation is yours.
          </Text>
          {match?.acceptedDigest ? (
            <Text style={styles.digestText}>Tx: {match.acceptedDigest.slice(0, 18)}...</Text>
          ) : null}
        </View>

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.chatContent}
          renderItem={({ item }) => {
            const isMe = item.sender === 'me';
            const isSystem = item.sender === 'system';

            return (
              <View
                style={[
                  styles.messageWrap,
                  isSystem ? styles.systemWrap : isMe ? styles.meWrap : styles.themWrap,
                ]}
              >
                <View
                  style={[
                    styles.bubble,
                    isSystem ? styles.systemBubble : isMe ? styles.meBubble : styles.themBubble,
                  ]}
                >
                  <Text style={isSystem ? styles.systemText : styles.messageText}>
                    {item.text}
                  </Text>
                </View>
              </View>
            );
          }}
        />

        <View style={styles.inputBar}>
          <TextInput
            style={styles.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Message your match..."
            placeholderTextColor="#6D6175"
            multiline
            maxLength={280}
          />

          <TouchableOpacity
            style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!inputText.trim()}
          >
            <LinearGradient
              colors={inputText.trim() ? ['#D94A8C', '#7A3EB8'] : ['#2A2432', '#2A2432']}
              style={styles.sendGradient}
            >
              <Text style={styles.sendText}>Send</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#A299A8', fontSize: 14 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2432',
  },
  backButton: { width: 72 },
  backText: { color: '#D94A8C', fontSize: 15, fontWeight: '700' },
  headerCenter: { flex: 1, alignItems: 'center' },
  name: { color: '#FDFBF7', fontSize: 18, fontWeight: '900' },
  mode: { color: '#4ade80', fontSize: 10, fontWeight: '900', letterSpacing: 1, marginTop: 3 },
  headerSpacer: { width: 72 },
  matchBanner: {
    margin: 14,
    padding: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(74, 222, 128, 0.42)',
    backgroundColor: 'rgba(74, 222, 128, 0.08)',
  },
  bannerKicker: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 5,
  },
  bannerText: { color: '#D8D0DD', fontSize: 13, lineHeight: 18 },
  digestText: {
    color: '#6D6175',
    fontSize: 11,
    marginTop: 8,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  chatContent: { paddingHorizontal: 16, paddingBottom: 16, gap: 10 },
  messageWrap: { maxWidth: '84%' },
  meWrap: { alignSelf: 'flex-end' },
  themWrap: { alignSelf: 'flex-start' },
  systemWrap: { alignSelf: 'center', maxWidth: '92%' },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10 },
  meBubble: { backgroundColor: '#D94A8C', borderBottomRightRadius: 4 },
  themBubble: {
    backgroundColor: '#1E1826',
    borderWidth: 1,
    borderColor: '#2A2432',
    borderBottomLeftRadius: 4,
  },
  systemBubble: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: '#2A2432',
  },
  messageText: { color: '#FDFBF7', fontSize: 15, lineHeight: 21 },
  systemText: { color: '#A299A8', fontSize: 13, lineHeight: 19, textAlign: 'center' },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#2A2432',
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#1E1826',
    color: '#FDFBF7',
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sendButton: { borderRadius: 12, overflow: 'hidden' },
  sendButtonDisabled: { opacity: 0.6 },
  sendGradient: { paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: '#FDFBF7', fontSize: 14, fontWeight: '900' },
});