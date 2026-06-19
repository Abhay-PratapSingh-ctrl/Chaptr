import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { getZkLoginSignature } from '@mysten/sui/zklogin';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { writeFeedback } from '@/utils/safetyService';
import {
  formatScoutCapsuleForPrompt,
  rememberChatSignal,
  type ScoutCapsule,
} from '@/utils/twinMemory';
import { buildProposeMatchTx } from '@/utils/suiTransactions';
import { getJwtForTransaction, executeSponsoredZkLoginTransaction } from '@/utils/zkLoginService';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID || '';
const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';

const UNLOCKED_PROFILES_KEY = 'chaptr:unlocked-profiles';
const ACTIVE_PROPOSAL_KEY = 'chaptr:active-proposal';
const HUMAN_MATCHES_KEY = 'chaptr:human-matches';
const CHAT_FEEDBACK_KEY = 'chaptr:ai-chat-feedback';
const chatFeedbackKey = (profileId: string) => `${CHAT_FEEDBACK_KEY}:${profileId}`;

const sameAddress = (a?: string | null, b?: string | null) =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase());

const loadHumanMatchForProfile = async (profileId: string, owner: string) => {
  const raw = await AsyncStorage.getItem(HUMAN_MATCHES_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    return (
      parsed.find(
        (match) =>
          match?.proposalId === profileId ||
          match?.participantTwinId === profileId ||
          sameAddress(match?.participantOwner, owner),
      ) ?? null
    );
  } catch {
    return null;
  }
};
const chatKeyForProfile = (profileId: string) => `chaptr:chat:${profileId}`;

const suiClient = new SuiJsonRpcClient({
  url: getJsonRpcFullnodeUrl('testnet'),
  network: 'testnet',
});

const discovery = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
};

interface ScoutProfile {
  version: number;
  kind: string;
  displayName: string;
  age: number;
  location: string;
  bio: string;
  gender: string;
  interestedIn: string;
  lookingFor: string;
  communicationStyle: string;
  mustHave: string;
  dealBreaker: string;
  previewPhotoBlobId: string | null;
  createdAt: string;
  scoutCapsule?: ScoutCapsule;
}

interface Persona {
  name: string;
  age: number;
  location: string;
  bio: string;
  photoUrl: string;
  details: string[];
  systemPrompt: string;
}

interface Message {
  id: string;
  text: string;
  sender: 'user' | 'agent';
}

interface ActiveProposal {
  status: 'sent';
  proposalId?: string | null;
  candidateTwinId: string;
  candidateOwner: string;
  candidateScoutRef: string | null;
  candidateName: string;
  score: number;
  digest: string;
  createdAt: string;
}

const firstParam = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value);

const toPlainString = (value: any): string => {
  if (typeof value === 'string') return value;
  if (value?.id && typeof value.id === 'string') return value.id;
  if (value === null || value === undefined) return '';
  return String(value);
};

const extractProposalIdFromResult = (result: any): string | null => {
  const createdProposal = result.objectChanges?.find(
    (change: any) =>
      change.type === 'created' &&
      typeof change.objectType === 'string' &&
      change.objectType.endsWith('::matchmaker::MatchProposal'),
  );

  if (createdProposal?.objectId) return createdProposal.objectId;

  for (const event of result.events ?? []) {
    const parsed = event.parsedJson ?? {};
    const candidates = [
      parsed.proposalId,
      parsed.proposal_id,
      parsed.id,
      parsed.proposal?.id,
      parsed.proposal?.objectId,
    ];

    const found = candidates.map(toPlainString).find(Boolean);
    if (found) return found;
  }

  return null;
};

const blobUrl = (blobId: string) =>
  `${AGGREGATOR}/v1/blobs/${encodeURIComponent(blobId)}`;

const fallbackPhotoUrl = (seed: string) =>
  `https://api.dicebear.com/7.x/personas/png?seed=${encodeURIComponent(seed)}`;

const fetchScoutProfile = async (blobId: string): Promise<ScoutProfile> => {
  const response = await fetch(blobUrl(blobId));

  if (!response.ok) {
    throw new Error(`Walrus scout profile fetch failed: ${response.status}`);
  }

  return response.json();
};

const getJwtForProposal = async () => {
  return await getJwtForTransaction(true);
};

const buildPersonaFromScout = (scout: ScoutProfile, ownerOrId: string): Persona => {
  const name = scout.displayName || 'This person';
  const photoUrl = scout.previewPhotoBlobId
    ? blobUrl(scout.previewPhotoBlobId)
    : fallbackPhotoUrl(ownerOrId || name);

  const details = [
    scout.lookingFor ? `Looking for ${scout.lookingFor}` : '',
    scout.communicationStyle ? `Likes ${scout.communicationStyle}` : '',
    scout.mustHave ? `Values ${scout.mustHave}` : '',
    scout.dealBreaker ? `Avoids ${scout.dealBreaker}` : '',
  ].filter(Boolean);

  const systemPrompt = `
You are ${name}'s Digital Twin inside Chaptr, an AI-first dating app.

You are not a generic assistant. You are a warm, conversational dating proxy for ${name}.
You should feel human-like, specific, and emotionally aware, but you must not falsely claim private details that are not in the profile.

Known profile:
- Name: ${name}
- Age: ${scout.age || 'unknown'}
- Location: ${scout.location || 'unknown'}
- Bio: ${scout.bio || 'not provided'}
- Gender: ${scout.gender || 'not provided'}
- Interested in: ${scout.interestedIn || 'not provided'}
- Looking for: ${scout.lookingFor || 'not provided'}
- Communication style: ${scout.communicationStyle || 'not provided'}
- Must-have: ${scout.mustHave || 'not provided'}
- Dealbreaker: ${scout.dealBreaker || 'not provided'}

Public-safe Scout Capsule:
${formatScoutCapsuleForPrompt(scout.scoutCapsule)}

How to speak:
- Sound like a smart dating-app conversation, not customer support.
- Reply in 2 to 5 natural sentences.
- Be specific using the profile details and Scout Capsule.
- If the user asks something not in the profile, do not say "I do not have hobbies because I am an AI."
- Instead say what the profile suggests, then ask a natural follow-up.
- Do not reveal private information beyond the profile.
- You may say "From what I know about ${name}..." when inferring.
`.trim();

  return {
    name,
    age: Number(scout.age) || 0,
    location: scout.location || '',
    bio: scout.bio || '',
    photoUrl,
    details: details.length > 0 ? details : ['Scout profile loaded from Walrus'],
    systemPrompt,
  };
};

const fallbackPersonaFor = (name?: string, seed = 'chaptr'): Persona => ({
  name: name || 'This Twin',
  age: 0,
  location: '',
  bio: 'Scout profile could not be loaded, so this agent is running in fallback mode.',
  photoUrl: fallbackPhotoUrl(seed),
  details: ['Fallback agent mode'],
  systemPrompt:
    'You are a Chaptr Digital Twin fallback agent. Explain that the scout profile could not be loaded, keep responses short, and ask the user to try again if needed.',
});

const readUnlockedProfileIds = async () => {
  const raw = await AsyncStorage.getItem(UNLOCKED_PROFILES_KEY);
  if (!raw) return [];

  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

export default function ChatScreen() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    scoutRef?: string | string[];
    name?: string | string[];
    owner?: string | string[];
    score?: string | string[];
    mode?: string | string[];
    proposalId?: string | string[];
  }>();
  const profileId = firstParam(params.id) ?? 'unknown-profile';
  const scoutRef = firstParam(params.scoutRef);
  const routeName = firstParam(params.name);
  const owner = firstParam(params.owner) ?? profileId;
  const mode = firstParam(params.mode);
  const isProposalReview = mode === 'proposal-review';
  const parsedScore = Number(firstParam(params.score) ?? 86);
  const routeScore = Number.isFinite(parsedScore) ? parsedScore : 86;

  const [persona, setPersona] = useState<Persona | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [userMessageCount, setUserMessageCount] = useState(0);
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [isLoadingPersona, setIsLoadingPersona] = useState(true);
  const [isRestoringChat, setIsRestoringChat] = useState(true);
  const [isProposing, setIsProposing] = useState(false);
  const [activeProposal, setActiveProposal] = useState<ActiveProposal | null>(null);
  
  const [chatFeedbackSubmitted, setChatFeedbackSubmitted] = useState(false);
  const [isWritingChatFeedback, setIsWritingChatFeedback] = useState(false);

  const flatListRef = useRef<FlatList<Message> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(ACTIVE_PROPOSAL_KEY)
      .then((raw) => setActiveProposal(raw ? JSON.parse(raw) : null))
      .catch(console.warn);
  }, []);

  useEffect(() => {
    let cancelled = false;
  
    setChatFeedbackSubmitted(false);
  
    AsyncStorage.getItem(chatFeedbackKey(profileId))
      .then((saved) => {
        if (!cancelled) setChatFeedbackSubmitted(Boolean(saved));
      })
      .catch(console.warn);
  
    return () => {
      cancelled = true;
    };
  }, [profileId]);
  useEffect(() => {
    let cancelled = false;

    loadHumanMatchForProfile(profileId, owner)
      .then((match) => {
        if (!match || cancelled) return;

        router.replace({
          pathname: '/human-chat/[id]' as any,
          params: {
            id: match.proposalId,
            name: match.participantName,
          },
        });
      })
      .catch(console.warn);

    return () => {
      cancelled = true;
    };
  }, [owner, profileId]);

  useEffect(() => {
    let cancelled = false;

    const loadPersona = async () => {
      try {
        setIsLoadingPersona(true);

        if (!scoutRef) {
          setPersona(fallbackPersonaFor(routeName, owner));
          return;
        }

        const scout = await fetchScoutProfile(scoutRef);

        if (!cancelled) {
          setPersona(buildPersonaFromScout(scout, owner));
        }
      } catch (error) {
        console.warn('Failed to load scout profile:', error);

        if (!cancelled) {
          setPersona(fallbackPersonaFor(routeName, owner));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPersona(false);
        }
      }
    };

    loadPersona();

    return () => {
      cancelled = true;
    };
  }, [owner, routeName, scoutRef]);

  const introMessage = useMemo<Message>(
    () => ({
      id: 'intro',
      text: persona
        ? `Hi, I'm ${persona.name}'s Digital Twin. My job is to check compatibility before I introduce you to the real ${persona.name}. What should I know about you?`
        : 'Hi, I am loading this Digital Twin...',
      sender: 'agent',
    }),
    [persona],
  );

  useEffect(() => {
    if (!persona || isLoadingPersona) return;

    const restoreChat = async () => {
      try {
        setIsRestoringChat(true);

        const [savedMessagesRaw, unlockedIds] = await Promise.all([
          AsyncStorage.getItem(chatKeyForProfile(profileId)),
          readUnlockedProfileIds(),
        ]);

        const restoredMessages = savedMessagesRaw ? JSON.parse(savedMessagesRaw) : null;
        const safeMessages = Array.isArray(restoredMessages) ? restoredMessages : [introMessage];

        setMessages(safeMessages);
        setUserMessageCount(safeMessages.filter((msg) => msg.sender === 'user').length);
        setIsUnlocked(unlockedIds.includes(profileId));
        setInputText('');
        setIsTyping(false);
      } catch (error) {
        console.warn('Failed to restore chat:', error);
        setMessages([introMessage]);
        setUserMessageCount(0);
        setIsUnlocked(false);
      } finally {
        setIsRestoringChat(false);
      }
    };

    restoreChat();
  }, [introMessage, isLoadingPersona, persona, profileId]);

  useEffect(() => {
    if (isRestoringChat || messages.length === 0) return;

    AsyncStorage.setItem(chatKeyForProfile(profileId), JSON.stringify(messages)).catch((error) =>
      console.warn('Failed to save chat:', error),
    );
  }, [isRestoringChat, messages, profileId]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 200);

    return () => clearTimeout(timeout);
  }, [messages, isTyping]);

  const unlockProfile = async () => {
    if (isUnlocked) return;

    setIsUnlocked(true);

    const unlockedIds = await readUnlockedProfileIds();
    const nextUnlockedIds = Array.from(new Set([...unlockedIds, profileId]));

    await AsyncStorage.setItem(UNLOCKED_PROFILES_KEY, JSON.stringify(nextUnlockedIds));
  };

  const generateGeminiResponse = async (chatHistory: Message[]) => {
    try {
      if (!persona) throw new Error('Persona is still loading');
      if (!GEMINI_API_KEY) throw new Error('Missing EXPO_PUBLIC_GEMINI_API_KEY');

      const firstUserIndex = chatHistory.findIndex((msg) => msg.sender === 'user');
      const apiHistory = firstUserIndex === -1 ? [] : chatHistory.slice(firstUserIndex);

      const contents = apiHistory.map((msg) => ({
        role: msg.sender === 'user' ? 'user' : 'model',
        parts: [{ text: msg.text }],
      }));

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: persona.systemPrompt }],
            },
            contents,
            generationConfig: {
              temperature: 0.85,
              maxOutputTokens: 320,
            },
          }),
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error?.message ?? `Gemini request failed: ${response.status}`);
      }

      const text = data?.candidates?.[0]?.content?.parts
        ?.map((part: any) => part.text)
        .filter(Boolean)
        .join('\n\n');

      if (!text) throw new Error('No text returned from Gemini');

      const cleaned = text.trim();

      if (cleaned.length < 40) {
        return `Let me answer that properly. From what I know about ${persona.name}, they seem to care about consistency, clarity, and effort that shows up in actions. I would ask them what that looks like in daily life, because that answer will tell you much more than a polished bio.`;
      }

      return cleaned;
    } catch (error) {
      console.error('Gemini API Error:', error);
      
      const groqKey = process.env.EXPO_PUBLIC_GROQ_FALLBACK_API_KEY || process.env.EXPO_PUBLIC_GROQ_API_KEY;
      if (groqKey && persona) {
        try {
          console.log('Attempting Groq fallback for chat...');
          
          const firstUserIndex = chatHistory.findIndex((msg) => msg.sender === 'user');
          const apiHistory = firstUserIndex === -1 ? [] : chatHistory.slice(firstUserIndex);
          
          const groqMessages = [
            { role: 'system', content: persona.systemPrompt },
            ...apiHistory.map(msg => ({
              role: msg.sender === 'user' ? 'user' : 'assistant',
              content: msg.text
            }))
          ];

          const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${groqKey}`,
            },
            body: JSON.stringify({
              model: 'llama-3.1-8b-instant',
              messages: groqMessages,
              temperature: 0.85,
              max_tokens: 320,
            }),
          });
          
          const groqData = await groqResponse.json();
          if (!groqResponse.ok) throw new Error(groqData?.error?.message ?? `Groq fallback failed: ${groqResponse.status}`);
          
          const groqText = groqData?.choices?.[0]?.message?.content;
          if (groqText) {
            const cleanedGroq = groqText.trim();
            if (cleanedGroq.length >= 40) return cleanedGroq;
          }
        } catch (groqError) {
          console.warn('Groq fallback also failed:', groqError);
        }
      }

      return 'I had trouble reading the signal for a second. Ask me that again?';
    }
  };

  const handleSend = async () => {
    const trimmedText = inputText.trim();

    if (!trimmedText || isTyping || !persona) return;

    const userMsg: Message = {
      id: `${Date.now()}`,
      text: trimmedText,
      sender: 'user',
    };

    const nextMessages = [...messages, userMsg];
    const nextUserMessageCount = userMessageCount + 1;

    setMessages(nextMessages);
    setInputText('');
    setIsTyping(true);
    setUserMessageCount(nextUserMessageCount);
    rememberChatSignal(trimmedText, profileId).catch(console.warn);

    if (nextUserMessageCount >= 3) {
      await unlockProfile();
    }

    const agentReplyText = await generateGeminiResponse(nextMessages);

    const agentMsg: Message = {
      id: `${Date.now() + 1}`,
      text: agentReplyText,
      sender: 'agent',
    };

    setMessages((prev) => [...prev, agentMsg]);
    setIsTyping(false);
  };

  const handleChatFeedback = async (signal: 'good_fit' | 'not_for_me') => {
    if (!persona || isWritingChatFeedback) return;
  
    try {
      setIsWritingChatFeedback(true);
  
      await writeFeedback({
        type: 'ai_chat',
        signal,
        targetTwinId: profileId,
        targetOwner: owner,
        targetName: persona.name,
        score: routeScore,
      });
  
      await AsyncStorage.setItem(chatFeedbackKey(profileId), signal);
      setChatFeedbackSubmitted(true);
    } catch (error) {
      console.warn('Chat feedback failed:', error);
      Alert.alert('Feedback failed', 'Could not save this signal. Try again later.');
    } finally {
      setIsWritingChatFeedback(false);
    }
  };
  const handleProposeMatch = async () => {
    if (!persona || isProposing) return;

    if (activeProposal) {
      Alert.alert(
        'Focus Mode Active',
        `Your Twin is already focused on ${activeProposal.candidateName}. Withdraw or finish that proposal before proposing again.`,
      );
      return;
    }

    try {
      setIsProposing(true);

      const [myTwinId, myOwner] = await Promise.all([
        AsyncStorage.getItem('chaptr:my-twin-id'),
        AsyncStorage.getItem('chaptr:my-owner'),
      ]);

      if (!myTwinId) throw new Error('No local Twin ID found. Create your agent again.');
      if (!myOwner) throw new Error('No local owner address found. Create your agent again.');

      if (!owner || owner === profileId) {
        throw new Error('Candidate owner address is missing.');
      }

      const jwt = await getJwtForProposal();

      const tx = buildProposeMatchTx(
        myTwinId,
        owner,
        routeScore,
        `Focus proposal to ${persona.name}. The recipient can talk to my Twin before accepting.`,
      );

      const result = await executeSponsoredZkLoginTransaction(tx, myOwner, jwt);

      const proposalId = extractProposalIdFromResult(result);

      console.log('Proposal tx digest:', result.digest);
      console.log('Proposal object id:', proposalId);

      const proposalState: ActiveProposal = {
        status: 'sent',
        proposalId,
        candidateTwinId: profileId,
        candidateOwner: owner,
        candidateScoutRef: scoutRef ?? null,
        candidateName: persona.name,
        score: routeScore,
        digest: result.digest,
        createdAt: new Date().toISOString(),
      };

      await AsyncStorage.setItem(ACTIVE_PROPOSAL_KEY, JSON.stringify(proposalState));
      setActiveProposal(proposalState);

      Alert.alert(
        'Focus Mode Started',
        `${persona.name} can now review your proposal and talk to your Twin before accepting.\n\nTx: ${result.digest.slice(0, 18)}...`,
        [{ text: 'OK', onPress: () => router.replace('/(tabs)') }],
      );
    } catch (error: any) {
      console.error('Propose match failed:', error);
      Alert.alert('Proposal failed', error.message ?? 'Could not propose match.');
    } finally {
      setIsProposing(false);
    }
  };

  if (isLoadingPersona || isRestoringChat || !persona) {
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator color="#D94A8C" />
          <Text style={styles.loadingText}>
            {isLoadingPersona ? 'Loading Digital Twin...' : 'Restoring chat...'}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const proposeDisabled = isProposing || Boolean(activeProposal);

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.flex}
      >
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={styles.backButton}>
            <Text style={styles.backText}>← Back</Text>
          </TouchableOpacity>

          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerName}>{persona.name}</Text>
            <View style={styles.aiBadge}>
              <Text style={styles.aiBadgeText}>AI TWIN</Text>
            </View>
          </View>

          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.lockBanner}>
          {isUnlocked ? (
            <LinearGradient
              colors={['rgba(74, 222, 128, 0.1)', 'rgba(74, 222, 128, 0.05)']}
              style={styles.bannerGradient}
            >
              <Text style={styles.unlockedText}>Personality unlocked. Human profile available.</Text>
            </LinearGradient>
          ) : (
            <Text style={styles.lockedText}>
              Vibe Check: Send {Math.max(3 - userMessageCount, 0)} more messages to unlock human photos.
            </Text>
          )}
        </View>

        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.chatContainer}
          renderItem={({ item }) => (
            <View
              style={[
                styles.bubbleWrapper,
                item.sender === 'user' ? styles.wrapperUser : styles.wrapperAgent,
              ]}
            >
              <View
                style={[
                  styles.bubble,
                  item.sender === 'user' ? styles.bubbleUser : styles.bubbleAgent,
                ]}
              >
                <Text style={styles.bubbleText}>{item.text}</Text>
              </View>
            </View>
          )}
          ListFooterComponent={
            isTyping ? (
              <View style={[styles.bubbleWrapper, styles.wrapperAgent]}>
                <View style={[styles.bubble, styles.bubbleAgent, styles.typingBubble]}>
                  <ActivityIndicator size="small" color="#D94A8C" />
                  <Text style={styles.typingText}>Agent is analyzing...</Text>
                </View>
              </View>
            ) : null
          }
        />
        {isUnlocked && !chatFeedbackSubmitted ? (
  <View style={styles.chatFeedbackBox}>
    <Text style={styles.chatFeedbackTitle}>Did this conversation feel worth your time?</Text>
    <View style={styles.chatFeedbackActions}>
      <TouchableOpacity
        style={styles.chatFeedbackButton}
        onPress={() => handleChatFeedback('good_fit')}
        disabled={isWritingChatFeedback}
      >
        <Text style={styles.chatFeedbackText}>Yes, more like this</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.chatFeedbackButtonMuted}
        onPress={() => handleChatFeedback('not_for_me')}
        disabled={isWritingChatFeedback}
      >
        <Text style={styles.chatFeedbackTextMuted}>No, not for me</Text>
      </TouchableOpacity>
    </View>
  </View>
) : null}
        {isUnlocked && (
          <View style={styles.unlockedActions}>
            <TouchableOpacity
              onPress={() => setShowProfileModal(true)}
              style={styles.viewProfileButton}
              activeOpacity={0.9}
            >
              <Text style={styles.viewProfileText}>View Human Profile</Text>
            </TouchableOpacity>

            {isProposalReview ? (
              <TouchableOpacity
                onPress={() => router.push('/proposals' as Href)}
                style={styles.proposeContainer}
                activeOpacity={0.9}
              >
                <LinearGradient
                  colors={['#4ade80', '#1f8f54']}
                  style={styles.proposeGradient}
                >
                  <Text style={styles.proposeText}>Back to Proposal</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                onPress={handleProposeMatch}
                style={[styles.proposeContainer, proposeDisabled && styles.proposeDisabled]}
                activeOpacity={0.9}
                disabled={proposeDisabled}
              >
                <LinearGradient
                  colors={proposeDisabled ? ['#2A2432', '#2A2432'] : ['#D94A8C', '#7A3EB8']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.proposeGradient}
                >
                  <Text style={styles.proposeText}>
                    {isProposing
                      ? 'Starting Focus Mode...'
                      : activeProposal
                        ? 'Twin Already Focused'
                        : 'Propose Human Match'}
                  </Text>
                </LinearGradient>
              </TouchableOpacity>
            )}
          </View>
        )}

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder="Ask this Twin anything..."
            placeholderTextColor="#6D6175"
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={240}
          />

          <TouchableOpacity
            style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
            onPress={handleSend}
            disabled={!inputText.trim() || isTyping}
          >
            <Text style={styles.sendButtonText}>Send</Text>
          </TouchableOpacity>
        </View>

        <Modal
          visible={showProfileModal}
          animationType="slide"
          transparent
          onRequestClose={() => setShowProfileModal(false)}
        >
          <View style={styles.modalBackdrop}>
            <View style={styles.profileModal}>
              <ScrollView showsVerticalScrollIndicator={false}>
                <Image source={{ uri: persona.photoUrl }} style={styles.profileImage} />

                <View style={styles.profileModalContent}>
                  <View style={styles.profileModalHeader}>
                    <Text style={styles.profileModalName}>
                      {persona.name}{persona.age > 0 ? `, ${persona.age}` : ''}
                    </Text>
                    <View style={styles.zkBadgeModal}>
                      <Text style={styles.zkBadgeModalText}>ZK</Text>
                    </View>
                  </View>

                  {persona.location ? (
                    <Text style={styles.profileModalLocation}>{persona.location}</Text>
                  ) : null}

                  <Text style={styles.profileModalBio}>{persona.bio}</Text>

                  <View style={styles.detailList}>
                    {persona.details.map((detail) => (
                      <View key={detail} style={styles.detailPill}>
                        <Text style={styles.detailPillText}>{detail}</Text>
                      </View>
                    ))}
                  </View>

                  <TouchableOpacity
                    onPress={() => setShowProfileModal(false)}
                    style={styles.closeProfileButton}
                  >
                    <Text style={styles.closeProfileText}>Close</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0B10' },
  flex: { flex: 1 },

  loadingContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 },
  loadingText: { color: '#A299A8', fontSize: 14 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2432',
  },
  backButton: { paddingVertical: 4, paddingRight: 12 },
  backText: { color: '#D94A8C', fontSize: 15, fontWeight: '600' },
  headerTitleContainer: { flex: 1, alignItems: 'center', gap: 6 },
  headerName: { color: '#FDFBF7', fontSize: 18, fontWeight: '800' },
  aiBadge: {
    borderWidth: 1,
    borderColor: 'rgba(217, 74, 140, 0.45)',
    backgroundColor: 'rgba(217, 74, 140, 0.12)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  aiBadgeText: { color: '#D94A8C', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  headerSpacer: { width: 64 },

  lockBanner: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2432',
  },
  bannerGradient: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  unlockedText: { color: '#4ade80', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  lockedText: { color: '#A299A8', fontSize: 13, textAlign: 'center', lineHeight: 18 },

  chatContainer: { paddingHorizontal: 16, paddingVertical: 14, gap: 10 },
  bubbleWrapper: { maxWidth: '82%' },
  wrapperUser: { alignSelf: 'flex-end' },
  wrapperAgent: { alignSelf: 'flex-start' },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleUser: {
    backgroundColor: '#D94A8C',
    borderBottomRightRadius: 4,
  },
  bubbleAgent: {
    backgroundColor: '#1E1826',
    borderWidth: 1,
    borderColor: '#2A2432',
    borderBottomLeftRadius: 4,
  },
  bubbleText: { color: '#FDFBF7', fontSize: 15, lineHeight: 21 },
  typingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minWidth: 140,
  },
  typingText: { color: '#A299A8', fontSize: 13 },

  unlockedActions: {
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 10,
  },
  viewProfileButton: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#1E1826',
    paddingVertical: 12,
    alignItems: 'center',
  },
  viewProfileText: { color: '#FDFBF7', fontSize: 14, fontWeight: '700' },
  proposeContainer: { borderRadius: 12, overflow: 'hidden' },
  proposeDisabled: { opacity: 0.72 },
  proposeGradient: { paddingVertical: 14, alignItems: 'center' },
  proposeText: { color: '#FDFBF7', fontSize: 15, fontWeight: '800' },

  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#2A2432',
    backgroundColor: '#0D0B10',
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
  sendButton: {
    borderRadius: 12,
    backgroundColor: '#D94A8C',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sendButtonDisabled: { opacity: 0.45 },
  sendButtonText: { color: '#FDFBF7', fontSize: 14, fontWeight: '800' },

  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(13, 11, 16, 0.72)',
    justifyContent: 'flex-end',
  },
  profileModal: {
    maxHeight: '88%',
    backgroundColor: '#141018',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2A2432',
  },
  profileImage: { width: '100%', height: 280, backgroundColor: '#2A2432' },
  profileModalContent: { padding: 18, gap: 12 },
  profileModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  profileModalName: { color: '#FDFBF7', fontSize: 24, fontWeight: '800', flex: 1 },
  zkBadgeModal: {
    borderWidth: 1,
    borderColor: '#4ade80',
    backgroundColor: 'rgba(74, 222, 128, 0.12)',
    borderRadius: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  zkBadgeModalText: { color: '#4ade80', fontSize: 10, fontWeight: '800' },
  profileModalLocation: { color: '#A299A8', fontSize: 14 },
  profileModalBio: { color: '#D8D0D8', fontSize: 15, lineHeight: 22 },
  detailList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  detailPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2A2432',
    backgroundColor: '#1E1826',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  detailPillText: { color: '#A299A8', fontSize: 12 },
  closeProfileButton: {
    marginTop: 8,
    borderRadius: 12,
    backgroundColor: '#2A2432',
    paddingVertical: 14,
    alignItems: 'center',
  },
  closeProfileText: { color: '#FDFBF7', fontSize: 15, fontWeight: '700' },
  chatFeedbackBox: {
    marginHorizontal: 16,
    marginBottom: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(217,74,140,0.28)',
    backgroundColor: 'rgba(217,74,140,0.06)',
    padding: 12,
    gap: 10,
  },
  chatFeedbackTitle: { color: '#FDFBF7', fontSize: 13, fontWeight: '900' },
  chatFeedbackActions: { flexDirection: 'row', gap: 8 },
  chatFeedbackButton: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: '#D94A8C',
    paddingVertical: 10,
    alignItems: 'center',
  },
  chatFeedbackButtonMuted: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#302840',
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingVertical: 10,
    alignItems: 'center',
  },
  chatFeedbackText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  chatFeedbackTextMuted: { color: '#C8C0CE', fontSize: 12, fontWeight: '900' },
});