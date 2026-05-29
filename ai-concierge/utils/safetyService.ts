import AsyncStorage from '@react-native-async-storage/async-storage';
import { uploadJsonToWalrus } from '@/utils/walrusService';
import {
  appendFeedbackToScoutCapsule,
  type TwinTrainingFeedback,
} from '@/utils/twinMemory';

const BLOCK_LIST_KEY = 'chaptr:block-list';
const HIDDEN_PROFILES_KEY = 'chaptr:hidden-profiles';
const REPORTS_KEY = 'chaptr:safety-reports';
const FEEDBACK_REFS_KEY = 'chaptr:feedback-refs';

export type BlockEntry = {
  twinId?: string | null;
  ownerAddress?: string | null;
  name?: string | null;
  reason: string;
  note?: string;
  matchId?: string | null;
  blobId?: string | null;
  createdAt: string;
};

export type SafetyReport = {
  version: 1;
  kind: 'chaptr-safety-report';
  matchId?: string | null;
  reporterOwner?: string | null;
  reportedOwner?: string | null;
  reportedTwinId?: string | null;
  reportedName?: string | null;
  reason: string;
  note?: string;
  createdAt: string;
  blobId?: string | null;
};

const normalize = (value?: string | null) => (value ?? '').trim().toLowerCase();

const readArray = async <T,>(key: string): Promise<T[]> => {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeArray = async <T,>(key: string, value: T[]) => {
  await AsyncStorage.setItem(key, JSON.stringify(value));
};

export const readBlockEntries = async (): Promise<BlockEntry[]> =>
  readArray<BlockEntry>(BLOCK_LIST_KEY);

export const readBlockedProfileKeys = async (): Promise<string[]> => {
  const entries = await readBlockEntries();

  return Array.from(
    new Set(
      entries
        .flatMap((entry) => [entry.twinId, entry.ownerAddress])
        .map(normalize)
        .filter(Boolean),
    ),
  );
};

export const readBlockList = async (): Promise<string[]> => {
  const entries = await readBlockEntries();
  return Array.from(new Set(entries.map((entry) => normalize(entry.ownerAddress)).filter(Boolean)));
};

export const readHiddenProfileIds = async (): Promise<string[]> =>
  readArray<string>(HIDDEN_PROFILES_KEY);

export const hideProfile = async (twinId: string) => {
  const current = await readHiddenProfileIds();
  const next = Array.from(new Set([...current, twinId].filter(Boolean)));
  await writeArray(HIDDEN_PROFILES_KEY, next);
  return next;
};

export const writeFeedback = async (feedback: TwinTrainingFeedback) => {
  const saved = await appendFeedbackToScoutCapsule(feedback);
  let blobId: string | null = null;

  try {
    blobId = await uploadJsonToWalrus({
      version: 1,
      kind: 'chaptr-training-feedback',
      feedback: saved,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('Feedback Walrus upload failed:', error);
  }

  if (blobId) {
    const refs = await readArray<string>(FEEDBACK_REFS_KEY);
    await writeArray(FEEDBACK_REFS_KEY, Array.from(new Set([blobId, ...refs])).slice(0, 50));
  }

  return { feedback: saved, blobId };
};

export const writeBlockEntry = async (input: {
  twinId?: string | null;
  ownerAddress?: string | null;
  name?: string | null;
  reason?: string;
  note?: string;
  matchId?: string | null;
}) => {
  const createdAt = new Date().toISOString();

  const entry: BlockEntry = {
    twinId: input.twinId ?? null,
    ownerAddress: input.ownerAddress ?? null,
    name: input.name ?? null,
    reason: input.reason || 'blocked',
    note: input.note,
    matchId: input.matchId ?? null,
    createdAt,
    blobId: null,
  };

  try {
    entry.blobId = await uploadJsonToWalrus({
      version: 1,
      kind: 'chaptr-block-entry',
      ...entry,
    });
  } catch (error) {
    console.warn('Block Walrus upload failed:', error);
  }

  const entryKeys = [entry.twinId, entry.ownerAddress].map(normalize).filter(Boolean);
  const current = await readBlockEntries();

  const next = [
    entry,
    ...current.filter((item) => {
      if (entryKeys.length === 0) return true;
      const itemKeys = [item.twinId, item.ownerAddress].map(normalize).filter(Boolean);
      return !itemKeys.some((key) => entryKeys.includes(key));
    }),
  ].slice(0, 200);

  await writeArray(BLOCK_LIST_KEY, next);

  if (entry.twinId) {
    await hideProfile(entry.twinId);
  }

  await writeFeedback({
    type: 'block',
    signal: entry.reason,
    targetTwinId: entry.twinId,
    targetOwner: entry.ownerAddress,
    targetName: entry.name,
    matchId: entry.matchId,
    note: entry.note,
  });

  return entry;
};

export const submitReport = async (input: {
  matchId?: string | null;
  reporterOwner?: string | null;
  reportedOwner?: string | null;
  reportedTwinId?: string | null;
  reportedName?: string | null;
  reason: string;
  note?: string;
}) => {
  const report: SafetyReport = {
    version: 1,
    kind: 'chaptr-safety-report',
    matchId: input.matchId ?? null,
    reporterOwner: input.reporterOwner ?? null,
    reportedOwner: input.reportedOwner ?? null,
    reportedTwinId: input.reportedTwinId ?? null,
    reportedName: input.reportedName ?? null,
    reason: input.reason || 'safety_report',
    note: input.note,
    createdAt: new Date().toISOString(),
    blobId: null,
  };

  try {
    report.blobId = await uploadJsonToWalrus(report);
  } catch (error) {
    console.warn('Safety report Walrus upload failed:', error);
  }

  const current = await readArray<SafetyReport>(REPORTS_KEY);
  await writeArray(REPORTS_KEY, [report, ...current].slice(0, 100));

  await writeFeedback({
    type: 'safety_report',
    signal: report.reason,
    targetTwinId: report.reportedTwinId,
    targetOwner: report.reportedOwner,
    targetName: report.reportedName,
    matchId: report.matchId,
    note: report.note,
  });

  return report;
};