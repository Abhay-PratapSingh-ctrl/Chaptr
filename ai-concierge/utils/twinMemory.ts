import AsyncStorage from '@react-native-async-storage/async-storage';

export type TwinMemoryFact = {
  id: string;
  category: 'dating' | 'traits' | 'conversation' | 'values' | 'care' | 'boundaries' | 'voice';
  text: string;
  source: 'onboarding' | 'profile' | 'chat' | 'feedback';
  visibility: 'private' | 'scout' | 'never_share';
  confidence: number;
  createdAt: string;
  metadata?: Record<string, string | number>;
};

export type ScoutCapsule = {
  version: 1;
  kind: 'chaptr-scout-capsule';
  traits: string[];
  datingIntent?: string;
  datingPace?: string;
  conversationChemistry: string[];
  idealDateEnergy?: string;
  values: string[];
  careStyle?: string;
  boundaries: string[];
  communicationStyle?: string;
  mustHave?: string;
  dealBreaker?: string;
  voiceSample?: string;
  updatedAt: string;
};

const MEMORY_KEY = 'chaptr:twin-memory';
const CAPSULE_KEY = 'chaptr:my-scout-capsule';

const clean = (value?: string | null) => (value ?? '').trim();

const afterColon = (value?: string) => clean(value).replace(/^[^:]+:\s*/, '');

const splitList = (value?: string) =>
  afterColon(value)
    .split(/,|\n|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);

const fact = (
  id: string,
  category: TwinMemoryFact['category'],
  text: string,
  source: TwinMemoryFact['source'],
  visibility: TwinMemoryFact['visibility'],
  label: string,
  confidence = 0.8,
): TwinMemoryFact => ({
  id,
  category,
  text,
  source,
  visibility,
  confidence,
  createdAt: new Date().toISOString(),
  metadata: { label },
});

export const loadTwinMemoryFacts = async (): Promise<TwinMemoryFact[]> => {
  const raw = await AsyncStorage.getItem(MEMORY_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const upsertTwinMemoryFacts = async (
  facts: TwinMemoryFact[],
): Promise<TwinMemoryFact[]> => {
  const current = await loadTwinMemoryFacts();
  const byId = new Map(current.map((item) => [item.id, item]));

  facts.forEach((item) => {
    if (item.text.trim()) byId.set(item.id, item);
  });

  const next = Array.from(byId.values()).slice(-80);
  await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(next));
  return next;
};

export const saveLocalScoutCapsule = async (capsule: ScoutCapsule) => {
  await AsyncStorage.setItem(CAPSULE_KEY, JSON.stringify(capsule));
};

export const loadLocalScoutCapsule = async (): Promise<ScoutCapsule | null> => {
  const raw = await AsyncStorage.getItem(CAPSULE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const buildOnboardingMemoryFacts = (
  answers: string[],
  questions: { text: string }[],
): TwinMemoryFact[] =>
  answers
    .map((answer, index) => {
      const value = clean(answer);
      if (!value) return null;

      const question = questions[index]?.text ?? 'Onboarding answer';

      const configs = [
        ['dating', 'datingIntent', 'Dating intent'],
        ['traits', 'traits', 'Self-described traits'],
        ['dating', 'datingPace', 'Dating pace'],
        ['conversation', 'conversationChemistry', 'Conversation chemistry'],
        ['dating', 'idealDateEnergy', 'Ideal first date energy'],
        ['values', 'values', 'Person they click with'],
        ['care', 'careStyle', 'Care style'],
        ['boundaries', 'boundaries', 'Green flags and hard noes'],
        ['voice', 'voiceSample', 'Voice sample'],
      ] as const;

      const [category, label, prefix] = configs[index] ?? ['voice', `answer-${index}`, question];

      return fact(
        `onboarding:${index}`,
        category,
        `${prefix}: ${value}`,
        'onboarding',
        'scout',
        label,
      );
    })
    .filter(Boolean) as TwinMemoryFact[];

export const buildProfileMemoryFacts = (input: {
  bio: string;
  lookingFor: string;
  communicationStyle: string;
  mustHave: string;
  dealBreaker: string;
}): TwinMemoryFact[] =>
  [
    fact('profile:bio', 'voice', `Bio: ${input.bio}`, 'profile', 'scout', 'bio'),
    fact(
      'profile:looking-for',
      'dating',
      `Looking for: ${input.lookingFor}`,
      'profile',
      'scout',
      'datingIntent',
    ),
    fact(
      'profile:communication',
      'conversation',
      `Communication style: ${input.communicationStyle}`,
      'profile',
      'scout',
      'communicationStyle',
    ),
    fact('profile:must-have', 'values', `Must-have: ${input.mustHave}`, 'profile', 'scout', 'mustHave'),
    fact(
      'profile:deal-breaker',
      'boundaries',
      `Dealbreaker: ${input.dealBreaker}`,
      'profile',
      'scout',
      'dealBreaker',
    ),
  ].filter((item) => afterColon(item.text).length > 0);

export const buildScoutCapsule = (facts: TwinMemoryFact[]): ScoutCapsule => {
  const publicFacts = facts.filter((item) => item.visibility === 'scout');
  const byLabel = (label: string) =>
    afterColon(publicFacts.find((item) => item.metadata?.label === label)?.text);

  return {
    version: 1,
    kind: 'chaptr-scout-capsule',
    traits: splitList(byLabel('traits')),
    datingIntent: byLabel('datingIntent') || undefined,
    datingPace: byLabel('datingPace') || undefined,
    conversationChemistry: splitList(byLabel('conversationChemistry')),
    idealDateEnergy: byLabel('idealDateEnergy') || undefined,
    values: [byLabel('values'), byLabel('mustHave')].filter(Boolean).slice(0, 4),
    careStyle: byLabel('careStyle') || undefined,
    boundaries: [byLabel('boundaries'), byLabel('dealBreaker')].filter(Boolean).slice(0, 4),
    communicationStyle: byLabel('communicationStyle') || undefined,
    mustHave: byLabel('mustHave') || undefined,
    dealBreaker: byLabel('dealBreaker') || undefined,
    voiceSample: byLabel('voiceSample') || byLabel('bio') || undefined,
    updatedAt: new Date().toISOString(),
  };
};

export const formatScoutCapsuleForPrompt = (capsule?: ScoutCapsule | null) => {
  if (!capsule) return 'No public-safe Scout Capsule is available yet.';

  return [
    capsule.traits.length ? `Traits: ${capsule.traits.join(', ')}` : '',
    capsule.datingIntent ? `Dating intent: ${capsule.datingIntent}` : '',
    capsule.datingPace ? `Dating pace: ${capsule.datingPace}` : '',
    capsule.conversationChemistry.length
      ? `Conversation chemistry: ${capsule.conversationChemistry.join(', ')}`
      : '',
    capsule.idealDateEnergy ? `Ideal date energy: ${capsule.idealDateEnergy}` : '',
    capsule.values.length ? `Values: ${capsule.values.join(' | ')}` : '',
    capsule.careStyle ? `Care style: ${capsule.careStyle}` : '',
    capsule.boundaries.length ? `Boundaries: ${capsule.boundaries.join(' | ')}` : '',
    capsule.communicationStyle ? `Communication style: ${capsule.communicationStyle}` : '',
    capsule.voiceSample ? `Voice sample: ${capsule.voiceSample.slice(0, 360)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

export const rememberChatSignal = async (message: string, peerId: string) => {
  const text = clean(message);
  const lower = text.toLowerCase();

  const looksPersonal =
    /\b(i am|i'm|i like|i love|i want|i prefer|for me|my|i feel|i value|i need|i hate|i don't)\b/.test(
      lower,
    );

  if (!looksPersonal || text.endsWith('?') || text.length < 18) return;

  await upsertTwinMemoryFacts([
    fact(
      `chat:${peerId}:${Date.now()}`,
      'conversation',
      `User shared in chat: ${text}`,
      'chat',
      'private',
      'chatSignal',
      0.45,
    ),
  ]);
};