import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { buildSendHumanMessageTx } from '@/utils/suiTransactions';
import { fetchJsonFromWalrus, uploadJsonToWalrus } from '@/utils/walrusService';
import {
  fetchZkProof,
  loadZkLoginParams,
  setupZkLoginParams,
} from '@/utils/zkLoginService';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const CHAT_PACKAGE_ID = process.env.EXPO_PUBLIC_CHAT_PACKAGE_ID || '';
const CHAT_ZK_SESSION_KEY = 'chaptr:chat-zk-session';

const HUMAN_MATCHES_KEY = 'chaptr:human-matches';

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

interface Message {
  id: string;
  text: string;
  sender: 'me' | 'them' | 'system';
  createdAt: string;
}

interface HumanMatch {
  matchId?: string | null;
  proposalId: string;
  participantOwner: string;
  participantTwinId: string | null;
  participantScoutRef: string | null;
  participantName: string;
  score: number;
  acceptedDigest: string;
  createdAt: string;
}
interface ChatZkSession {
  ephemeralKeyPair: any;
  maxEpoch: number;
  zkProof: any;
  addressSeed: string;
  userAddress: string;
}

const firstParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

const humanChatKey = (matchId: string) => `chaptr:human-chat:${matchId}`;

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const sameId = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const toPlainString = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value?.id && typeof value.id === 'string') return value.id;
  if (value === null || value === undefined) return '';
  return String(value);
};

const loadHumanMatch = async (matchId: string): Promise<HumanMatch | null> => {
  const raw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    return (
      parsed.find(
        (item) =>
          sameId(item?.matchId, matchId) ||
          item?.proposalId === matchId ||
          item?.participantTwinId === matchId ||
          sameAddress(item?.participantOwner, matchId),
      ) ?? null
    );
  } catch {
    return null;
  }
};

const getJwtForChatAction = async () => {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('Missing EXPO_PUBLIC_GOOGLE_CLIENT_ID');
  }

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

  if (result.type !== 'success') {
    throw new Error('Google sign-in was cancelled');
  }

  const idToken = result.params.id_token;
  if (!idToken) throw new Error('No id_token returned');

  return idToken;
};

const executeWithZkLoginSession = async (tx: any, session: ChatZkSession) => {
  tx.setSender(session.userAddress);

  const { bytes, signature: userSignature } = await tx.sign({
    client: suiClient,
    signer: session.ephemeralKeyPair,
  });

  const zkSignature = getZkLoginSignature({
    inputs: { ...(session.zkProof as any), addressSeed: session.addressSeed },
    maxEpoch: session.maxEpoch,
    userSignature,
  });

  return suiClient.executeTransactionBlock({
    transactionBlock: bytes,
    signature: zkSignature,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
};
const loadChainMessages = async (
  matchId: string,
  myOwner: string | null,
): Promise<Message[]> => {
  if (!CHAT_PACKAGE_ID) return [];

  const eventsResult = await suiClient.queryEvents({
    query: {
      MoveEventType: `${CHAT_PACKAGE_ID}::chat::MessageSent`,
    },
    limit: 50,
    order: 'descending',
  });

  const rows = eventsResult.data ?? [];
  const forMatch = rows.filter((event: any) => {
    const parsed = event.parsedJson ?? {};
    const eventMatchId = toPlainString(parsed.match_id ?? parsed.matchId);
    return sameId(eventMatchId, matchId);
  });

  const messages: Message[] = [];

  for (const [index, event] of forMatch.entries()) {
    const parsed: any = event.parsedJson ?? {};
    const blobId = toPlainString(parsed.blob_id ?? parsed.blobId);
    const sender = toPlainString(parsed.sender);

    try {
      const payload = await fetchJsonFromWalrus<{
        kind?: string;
        matchId?: string;
        text?: string;
        createdAt?: string;
        sender?: string;
      }>(blobId);

      if (!payload.text) continue;
      if (payload.matchId && !sameId(payload.matchId, matchId)) continue;

      messages.push({
        id: `${event.id?.txDigest ?? 'tx'}-${event.id?.eventSeq ?? index}`,
        text: payload.text,
        sender: sameAddress(payload.sender || sender, myOwner) ? 'me' : 'them',
        createdAt: payload.createdAt ?? new Date().toISOString(),
      });
    } catch {
      // Skip unreadable Walrus blobs.
    }
  }

  return messages.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
};

export default function HumanChatScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    name?: string | string[];
  }>();

  const matchId = firstParam(params.id) ?? 'unknown-match';
  const routeName = firstParam(params.name);

  const [zkSession, setZkSession] = useState<ChatZkSession | null>(null);
  const [match, setMatch] = useState<HumanMatch | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [myOwner, setMyOwner] = useState<string | null>(null);

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

  const refreshMessages = useCallback(async () => {
    try {
      setIsRefreshing(true);
  
      const owner = await AsyncStorage.getItem('chaptr:my-owner');
      setMyOwner(owner);
  
      const chainMessages = await loadChainMessages(matchId, owner);
  
      setMessages((current) => {
        const localMessages = current.filter((msg) => msg.id !== 'intro');
        const merged = [...localMessages];
  
        for (const chainMessage of chainMessages) {
          const alreadyExists = merged.some(
            (msg) =>
              msg.id === chainMessage.id ||
              (
                msg.text === chainMessage.text &&
                msg.sender === chainMessage.sender &&
                Math.abs(
                  new Date(msg.createdAt).getTime() -
                    new Date(chainMessage.createdAt).getTime(),
                ) < 10_000
              ),
          );
  
          if (!alreadyExists) {
            merged.push(chainMessage);
          }
        }
  
        merged.sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        );
  
        const nextMessages = [introMessage, ...merged];
        AsyncStorage.setItem(humanChatKey(matchId), JSON.stringify(nextMessages)).catch(console.warn);
        return nextMessages;
      });
    } catch (error) {
      console.warn('Failed to refresh human chat:', error);
    } finally {
      setIsRefreshing(false);
    }
  }, [introMessage, matchId]);

  useEffect(() => {
    const load = async () => {
      try {
        setIsLoading(true);

        const [savedMatch, savedChatRaw, owner] = await Promise.all([
          loadHumanMatch(matchId),
          AsyncStorage.getItem(humanChatKey(matchId)),
          AsyncStorage.getItem('chaptr:my-owner'),
        ]);

        setMatch(savedMatch);
        setMyOwner(owner);

        const restored = savedChatRaw ? JSON.parse(savedChatRaw) : null;
        setMessages(Array.isArray(restored) ? restored : [introMessage]);

        await refreshMessages();
      } catch (error) {
        console.warn('Failed to load human chat:', error);
        setMessages([introMessage]);
      } finally {
        setIsLoading(false);
      }
    };

    load();
  }, [introMessage, matchId, refreshMessages])
  useEffect(() => {
    if (isLoading) return;
  
    const interval = setInterval(() => {
      refreshMessages().catch(console.warn);
    }, 1000);
  
    return () => clearInterval(interval);
  }, [isLoading, refreshMessages]);;

  useEffect(() => {
    const timeout = setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 180);

    return () => clearTimeout(timeout);
  }, [messages]);

  const getChatZkSession = useCallback(async () => {
    if (zkSession) return zkSession;
  
    const cachedRaw = await AsyncStorage.getItem(CHAT_ZK_SESSION_KEY);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw);
        const { ephemeralKeyPair } = await loadZkLoginParams();
  
        const session: ChatZkSession = {
          ephemeralKeyPair,
          maxEpoch: Number(cached.maxEpoch),
          zkProof: cached.zkProof,
          addressSeed: cached.addressSeed,
          userAddress: cached.userAddress,
        };
  
        setZkSession(session);
        return session;
      } catch {
        await AsyncStorage.removeItem(CHAT_ZK_SESSION_KEY);
      }
    }
  
    const jwt = await getJwtForChatAction();
    const { ephemeralKeyPair, maxEpoch, randomness } = await loadZkLoginParams();
    const { zkProof, addressSeed, userAddress } = await fetchZkProof(
      jwt,
      ephemeralKeyPair,
      maxEpoch,
      randomness,
    );
  
    const expectedOwner = await AsyncStorage.getItem('chaptr:my-owner');
  
    if (!expectedOwner) {
      throw new Error('Missing local Chaptr identity. Sign in again.');
    }
  
    if (userAddress.toLowerCase() !== expectedOwner.toLowerCase()) {
      throw new Error("Selected Google account does not match this browser's Chaptr identity.");
    }
  
    const session: ChatZkSession = {
      ephemeralKeyPair,
      maxEpoch: Number(maxEpoch),
      zkProof,
      addressSeed,
      userAddress,
    };
  
    await AsyncStorage.setItem(
      CHAT_ZK_SESSION_KEY,
      JSON.stringify({
        maxEpoch: Number(maxEpoch),
        zkProof,
        addressSeed,
        userAddress,
      }),
    );
  
    setZkSession(session);
    return session;
  }, [zkSession]);

  const handleSend = async () => {
    const trimmed = inputText.trim();
    if (!trimmed || isSending) return;
  
    if (!CHAT_PACKAGE_ID) {
      Alert.alert('Chat not connected', 'Set EXPO_PUBLIC_CHAT_PACKAGE_ID and restart Expo.');
      return;
    }
  
    if (!myOwner) {
      Alert.alert('Not signed in', 'Create your Twin first to send messages.');
      return;
    }
  
    const createdAt = new Date().toISOString();
  
    const optimisticMessage: Message = {
      id: `pending-${Date.now()}`,
      text: trimmed,
      sender: 'me',
      createdAt,
    };
  
    try {
      setIsSending(true);
  
      const session = await getChatZkSession();
  
      setMessages((current) => [...current, optimisticMessage]);
      setInputText('');
  
      const payload = {
        version: 1,
        kind: 'chaptr-human-message',
        matchId,
        sender: myOwner,
        text: trimmed,
        createdAt,
      };
  
      const blobId = await uploadJsonToWalrus(payload);
      const tx = buildSendHumanMessageTx(matchId, blobId);
  
      await executeWithZkLoginSession(tx, session);
  
      const confirmedMessage: Message = {
        id: `sent-${Date.now()}`,
        text: trimmed,
        sender: 'me',
        createdAt,
      };
  
      setMessages((current) => {
        const withoutPending = current.filter((msg) => msg.id !== optimisticMessage.id);
        const next = [...withoutPending, confirmedMessage];
        AsyncStorage.setItem(humanChatKey(matchId), JSON.stringify(next)).catch(console.warn);
        return next;
      });
  
      setTimeout(() => {
        refreshMessages().catch(console.warn);
      }, 1000);
    } catch (err: any) {
      console.error('Send failed:', err);
  
      setMessages((current) => current.filter((msg) => msg.id !== optimisticMessage.id));
  
      Alert.alert('Send failed', err.message ?? 'Could not send message.');
    } finally {
      setIsSending(false);
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loading}>
          <ActivityIndicator color="#D94A8C" />
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
            <Text style={styles.backText}>{'< Back'}</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.name}>{displayName}</Text>
            <Text style={styles.mode}>Human Match</Text>
          </View>

          <TouchableOpacity
            onPress={refreshMessages}
            style={styles.headerAction}
            disabled={isRefreshing || isSending}
          >
            <Text style={styles.refreshText}>{isRefreshing ? 'Syncing' : 'Sync'}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.matchBanner}>
          <Text style={styles.bannerKicker}>Match Mode</Text>
          <Text style={styles.bannerText}>
            Twins made the introduction. Now the conversation is yours.
          </Text>
          <Text style={styles.syncStatus}>
            {CHAT_PACKAGE_ID ? 'Sui + Walrus sync active' : 'Chat package not connected'}
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
            editable={!isSending}
          />

          <TouchableOpacity
            style={[styles.sendButton, (!inputText.trim() || isSending) && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!inputText.trim() || isSending}
          >
            <LinearGradient
              colors={inputText.trim() && !isSending ? ['#D94A8C', '#7A3EB8'] : ['#2A2432', '#2A2432']}
              style={styles.sendGradient}
            >
              <Text style={styles.sendText}>{isSending ? 'Sending...' : 'Send'}</Text>
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
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
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
  headerAction: { width: 72, alignItems: 'flex-end' },
  refreshText: { color: '#A299A8', fontSize: 13, fontWeight: '800' },
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
  syncStatus: { color: '#93c5fd', fontSize: 11, marginTop: 8, fontWeight: '800' },
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