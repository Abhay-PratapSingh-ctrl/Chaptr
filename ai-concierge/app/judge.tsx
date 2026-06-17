/**
 * judge.tsx — Block 4.5 (v2)
 *
 * Telemetry Status Board for Sui Overflow judges.
 * Shows a clean ledger view: one entry per A2A conversation,
 * one per proposal, one per match. Dedup keys prevent duplicates.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Linking,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Modal,
} from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { readTelemetry, clearTelemetry, type TelemetryEvent } from '@/utils/telemetry';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUISCAN_BASE = 'https://suiscan.xyz/testnet/tx';
const POLL_INTERVAL = 2000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const openLink = (url: string) => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank');
  } else {
    Linking.openURL(url);
  }
};

const isTxDigest = (value: string): boolean =>
  typeof value === 'string' && /^[A-Za-z0-9+/]{32,64}={0,2}$/.test(value) && value.length >= 32;

const formatTime = (iso: string): string => {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
};

// ─── Section: Current Match ───────────────────────────────────────────────────

function CurrentMatchSection({ events }: { events: TelemetryEvent[] }) {
  const matchEvent = events.find((e) => e.event === 'match_formed');
  const acceptEvent = events.find(
    (e) => e.event === 'accept_result' && e.payload?.result === 'success',
  );
  const poolScan = events.find((e) => e.event === 'pool_scan_start');
  const isInMatch = poolScan?.payload?.isInActiveMatch === true;

  if (!matchEvent && !isInMatch) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>💞 Current Match</Text>
      {matchEvent ? (
        <View style={[styles.card, styles.matchCard]}>
          <View style={styles.cardRow}>
            <Text style={styles.matchIcon}>💍</Text>
            <View style={styles.cardContent}>
              <Text style={styles.matchTitle}>
                Match formed — {matchEvent.payload.proposer} ↔ {matchEvent.payload.accepter}
              </Text>
              <Text style={styles.cardDetail}>
                Score: {matchEvent.payload.score}% • {formatTime(matchEvent.timestamp)}
              </Text>
              {acceptEvent?.payload?.txDigest && isTxDigest(String(acceptEvent.payload.txDigest)) && (
                <TouchableOpacity
                  onPress={() => openLink(`${SUISCAN_BASE}/${acceptEvent.payload.txDigest}`)}
                >
                  <Text style={styles.txLink}>
                    🔗 {String(acceptEvent.payload.txDigest).slice(0, 16)}… → Suiscan ↗
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </View>
      ) : isInMatch ? (
        <View style={[styles.card, styles.matchCard]}>
          <View style={styles.cardRow}>
            <Text style={styles.matchIcon}>🔒</Text>
            <View style={styles.cardContent}>
              <Text style={styles.matchTitle}>Twin is currently locked in a match</Text>
              <Text style={styles.cardDetail}>
                On-chain proposals and accepts are paused. A2A intelligence continues.
              </Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

// ─── Section: A2A Conversations ───────────────────────────────────────────────

function A2ASection({ events }: { events: TelemetryEvent[] }) {
  const a2aEvents = events.filter((e) => e.event === 'a2a_complete');
  const [selectedChat, setSelectedChat] = useState<any>(null);

  if (a2aEvents.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>🤖 A2A Conversations</Text>
      <Text style={styles.sectionSubtitle}>
        {a2aEvents.length} conversation{a2aEvents.length !== 1 ? 's' : ''} completed
      </Text>

      {a2aEvents.map((evt) => {
        const pairKey = evt.dedupKey ? evt.dedupKey.replace('a2a_complete:', '') : `unknown-${Math.random()}`;
        const scoreColor =
          evt.payload.score >= 80 ? '#4ade80' : evt.payload.score >= 60 ? '#fbbf24' : '#f87171';
        
        // Use embedded transcript if available, otherwise fallback to message events
        const transcript = evt.payload.transcript || events
          .filter((e) => e.event === 'a2a_message' && e.dedupKey && e.dedupKey.startsWith(`a2a_msg:${pairKey}`))
          .sort((a, b) => (a.payload.messageIndex ?? 0) - (b.payload.messageIndex ?? 0))
          .map(m => ({
             role: m.payload.role,
             speaker: m.payload.speaker,
             message: m.payload.preview
          }));

        return (
          <TouchableOpacity
            key={evt.dedupKey || pairKey}
            style={styles.card}
            onPress={() => setSelectedChat({ ...evt.payload, transcript })}
            activeOpacity={0.8}
          >
            <View style={styles.cardRow}>
              <View style={[styles.scoreBadge, { backgroundColor: scoreColor + '20', borderColor: scoreColor + '40' }]}>
                <Text style={[styles.scoreBadgeText, { color: scoreColor }]}>
                  {evt.payload.score}%
                </Text>
              </View>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>
                  ↔ {evt.payload.candidateName || evt.payload.candidateOwner}
                </Text>
                <Text style={styles.cardDetail}>
                  {evt.payload.source === 'cache' ? '📦 Cached' : '⚡ Fresh Groq'} •{' '}
                  {evt.payload.messageCount ?? transcript.length ?? '?'} messages •{' '}
                  {evt.payload.recommendation === 'propose' ? '✅ Propose' : '❌ Pass'}
                </Text>
                {evt.payload.chemistry && (
                  <Text style={styles.cardSubtext} numberOfLines={1}>
                    💬 {evt.payload.chemistry}
                  </Text>
                )}
                {evt.payload.summary && (
                  <Text style={styles.cardSubtext} numberOfLines={1}>
                    📋 {evt.payload.summary}
                  </Text>
                )}
              </View>
              <Text style={styles.viewChatBtn}>View Chat</Text>
            </View>
            <Text style={styles.cardTimestamp}>{formatTime(evt.timestamp)}</Text>
          </TouchableOpacity>
        );
      })}

      {/* Chat Modal Popup */}
      <Modal visible={!!selectedChat} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Conversation w/ {selectedChat?.candidateName}</Text>
              <TouchableOpacity onPress={() => setSelectedChat(null)} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>✕</Text>
              </TouchableOpacity>
            </View>
            
            <ScrollView style={styles.modalScroll} showsVerticalScrollIndicator={false}>
              {selectedChat?.transcript?.map((msg: any, i: number) => (
                <View
                  key={i}
                  style={[
                    styles.messageBubble,
                    msg.role === 'twin_a' ? styles.bubbleA : styles.bubbleB,
                  ]}
                >
                  <Text style={styles.messageSpeaker}>{msg.speaker}'s Twin</Text>
                  <Text style={styles.messageText}>{msg.message || msg.preview}</Text>
                </View>
              ))}
              
              {selectedChat?.transcript?.length === 0 && (
                <Text style={styles.emptyChatText}>No messages available for this conversation.</Text>
              )}

              {/* Walrus refs in modal */}
              {(selectedChat?.transcriptRef || selectedChat?.reportRef) && (
                <View style={styles.refsContainer}>
                  {selectedChat?.transcriptRef && (
                    <Text style={styles.refText}>📜 Transcript: {selectedChat.transcriptRef}</Text>
                  )}
                  {selectedChat?.reportRef && (
                    <Text style={styles.refText}>📊 Report: {selectedChat.reportRef}</Text>
                  )}
                </View>
              )}
              <View style={{ height: 20 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Section: Proposals ───────────────────────────────────────────────────────

function ProposalSection({ events }: { events: TelemetryEvent[] }) {
  const proposeResults = events.filter((e) => e.event === 'propose_result');
  const proposeFired = events.filter((e) => e.event === 'propose_fired');

  // Merge fired + result by target
  const proposals = proposeFired.map((fired) => {
    const targetKey = fired.payload.target;
    const result = proposeResults.find((r) => r.payload.target === targetKey);
    return { fired, result };
  });

  if (proposals.length === 0 && proposeResults.length === 0) return null;

  const allProposals = proposals.length > 0 ? proposals : proposeResults.map((r) => ({ fired: null, result: r }));

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>🚀 Outbound Proposals</Text>
      <Text style={styles.sectionSubtitle}>
        {allProposals.length} proposal{allProposals.length !== 1 ? 's' : ''} sent
      </Text>

      {allProposals.map((p, i) => {
        const target = p.fired?.payload?.target || p.result?.payload?.target || '?';
        const score = p.fired?.payload?.score || p.result?.payload?.score || '?';
        const success = p.result?.payload?.result === 'success';
        const failed = p.result?.payload?.result === 'failed';
        const txDigest = p.result?.payload?.txDigest;

        return (
          <View key={`prop-${i}`} style={styles.card}>
            <View style={styles.cardRow}>
              <Text style={styles.proposalIcon}>{success ? '✅' : failed ? '❌' : '⏳'}</Text>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>Proposed to {target}</Text>
                <Text style={styles.cardDetail}>
                  Score: {score}% •{' '}
                  {success ? 'Accepted on-chain' : failed ? `Failed: ${p.result?.payload?.error || 'unknown'}` : 'Pending'}
                </Text>
                {txDigest && isTxDigest(String(txDigest)) && (
                  <TouchableOpacity onPress={() => openLink(`${SUISCAN_BASE}/${txDigest}`)}>
                    <Text style={styles.txLink}>
                      🔗 {String(txDigest).slice(0, 16)}… → Suiscan ↗
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
            <Text style={styles.cardTimestamp}>
              {formatTime(p.result?.timestamp || p.fired?.timestamp || '')}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Section: Accepts ─────────────────────────────────────────────────────────

function AcceptSection({ events }: { events: TelemetryEvent[] }) {
  const acceptResults = events.filter((e) => e.event === 'accept_result');

  if (acceptResults.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>🤝 Inbound Accepts</Text>
      <Text style={styles.sectionSubtitle}>
        {acceptResults.length} accept{acceptResults.length !== 1 ? 's' : ''} processed
      </Text>

      {acceptResults.map((evt, i) => {
        const success = evt.payload.result === 'success';
        return (
          <View key={`acc-${i}`} style={styles.card}>
            <View style={styles.cardRow}>
              <Text style={styles.proposalIcon}>{success ? '✅' : '❌'}</Text>
              <View style={styles.cardContent}>
                <Text style={styles.cardTitle}>
                  Accepted proposal from {evt.payload.proposer}
                </Text>
                <Text style={styles.cardDetail}>
                  Score: {evt.payload.score}% •{' '}
                  {success ? 'Match formed on-chain' : `Failed: ${evt.payload.error || 'unknown'}`}
                </Text>
              </View>
            </View>
            <Text style={styles.cardTimestamp}>{formatTime(evt.timestamp)}</Text>
          </View>
        );
      })}
    </View>
  );
}

// ─── Section: Agent Status ────────────────────────────────────────────────────

function AgentStatusSection({ events }: { events: TelemetryEvent[] }) {
  const poolScan = events.find((e) => e.event === 'pool_scan_start');
  const a2aPhase = events.find((e) => e.event === 'a2a_phase_start');
  const mandate = events.find((e) => e.event === 'mandate_check');

  if (!poolScan) return null;

  const p = poolScan.payload;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>🛡️ Agent Status</Text>
      <View style={styles.statusGrid}>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>Pool Size</Text>
          <Text style={styles.statusValue}>{p.totalInPool ?? '?'}</Text>
        </View>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>In Match</Text>
          <Text style={[styles.statusValue, { color: p.isInActiveMatch ? '#f87171' : '#4ade80' }]}>
            {p.isInActiveMatch ? 'Yes' : 'No'}
          </Text>
        </View>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>Mandate</Text>
          <Text style={[styles.statusValue, { color: p.mandateLoaded ? '#4ade80' : '#f87171' }]}>
            {p.mandateLoaded ? 'Loaded' : 'None'}
          </Text>
        </View>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>A2A</Text>
          <Text style={[styles.statusValue, { color: p.mayRunA2A ? '#4ade80' : '#64748b' }]}>
            {p.mayRunA2A ? 'Enabled' : 'Off'}
          </Text>
        </View>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>Candidates</Text>
          <Text style={styles.statusValue}>{a2aPhase?.payload?.candidateCount ?? '0'}</Text>
        </View>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>Propose</Text>
          <Text style={[styles.statusValue, { color: p.mayPropose ? '#4ade80' : '#64748b' }]}>
            {p.mayPropose ? 'Enabled' : 'Off'}
          </Text>
        </View>
      </View>
      <Text style={styles.statusTimestamp}>Last scan: {formatTime(poolScan.timestamp)}</Text>
    </View>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function JudgeDashboard() {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [isLive, setIsLive] = useState(true);

  useEffect(() => {
    if (!isLive) return;
    const poll = () => setEvents(readTelemetry());
    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isLive]);

  // Stats
  const stats = useMemo(() => {
    const a2a = events.filter((e) => e.event === 'a2a_complete').length;
    const proposals = events.filter((e) => e.event === 'propose_fired').length;
    const accepts = events.filter(
      (e) => e.event === 'accept_result' && e.payload?.result === 'success',
    ).length;
    const matches = events.filter((e) => e.event === 'match_formed').length;
    return { a2a, proposals, accepts, matches };
  }, [events]);

  const handleClear = useCallback(() => {
    clearTelemetry();
    setEvents([]);
  }, []);

  const handleClearCache = useCallback(async () => {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const cacheKeys = keys.filter(k => k.startsWith('chaptr:a2a-result:'));
      await AsyncStorage.multiRemove(cacheKeys);
      alert(`Cleared ${cacheKeys.length} cached A2A conversations.`);
    } catch (e) {
      console.warn('Failed to clear A2A cache:', e);
    }
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
              <Text style={styles.backBtnText}>← Back</Text>
            </TouchableOpacity>
            <Text style={styles.title}>🏛 Judge Dashboard</Text>
          </View>
          <View style={styles.headerRight}>
            <TouchableOpacity
              style={[styles.toggleBtn, isLive ? styles.toggleActive : styles.toggleInactive]}
              onPress={() => setIsLive(!isLive)}
            >
              {isLive && <View style={styles.liveDot} />}
              <Text style={[styles.toggleText, { color: isLive ? '#4ade80' : '#64748b' }]}>
                {isLive ? 'LIVE' : 'PAUSED'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.clearBtn, { borderColor: 'rgba(96,165,250,0.3)', backgroundColor: 'rgba(96,165,250,0.1)' }]} onPress={handleClearCache}>
              <Text style={[styles.clearBtnText, { color: '#60a5fa' }]}>Clear Cache</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.clearBtn} onPress={handleClear}>
              <Text style={styles.clearBtnText}>Clear Telemetry</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Stats Summary */}
        <View style={styles.statsBar}>
          <StatBox label="A2A Convos" value={stats.a2a} color="#60a5fa" />
          <StatBox label="Proposals" value={stats.proposals} color="#f59e0b" />
          <StatBox label="Accepts" value={stats.accepts} color="#a78bfa" />
          <StatBox label="Matches" value={stats.matches} color="#f472b6" />
        </View>

        {/* Empty state */}
        {events.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📡</Text>
            <Text style={styles.emptyTitle}>No telemetry events yet</Text>
            <Text style={styles.emptyBody}>
              Open the Morning Briefing to trigger autonomous agent activity.{'\n'}
              Events will appear here as a ledger — one entry per conversation,{'\n'}
              per proposal, per match.
            </Text>
          </View>
        ) : (
          <>
            {/* Current Match (top priority) */}
            <CurrentMatchSection events={events} />

            {/* A2A Conversations */}
            <A2ASection events={events} />

            {/* Outbound Proposals */}
            <ProposalSection events={events} />

            {/* Inbound Accepts */}
            <AcceptSection events={events} />

            {/* Agent Status (diagnostics) */}
            <AgentStatusSection events={events} />
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Stat Box Component ───────────────────────────────────────────────────────

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statNumber, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0c0a14' },
  container: { flex: 1, paddingHorizontal: 16 },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  backBtnText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  title: { color: '#f8fafc', fontSize: 20, fontWeight: '700', letterSpacing: -0.3 },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    gap: 6,
  },
  toggleActive: {
    backgroundColor: 'rgba(74,222,128,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.3)',
  },
  toggleInactive: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ade80' },
  toggleText: { fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  clearBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.2)',
  },
  clearBtnText: { color: '#f87171', fontSize: 12, fontWeight: '600' },

  // Stats Bar
  statsBar: {
    flexDirection: 'row',
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.06)',
  },
  statNumber: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  statLabel: {
    color: '#64748b',
    fontSize: 10,
    fontWeight: '600',
    marginTop: 2,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },

  // Sections
  section: { marginTop: 20 },
  sectionTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700', marginBottom: 4 },
  sectionSubtitle: { color: '#475569', fontSize: 12, marginBottom: 10 },

  // Cards
  card: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    padding: 14,
    marginBottom: 8,
  },
  matchCard: {
    borderColor: 'rgba(244,114,182,0.25)',
    backgroundColor: 'rgba(244,114,182,0.05)',
  },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardContent: { flex: 1 },
  cardTitle: { color: '#f1f5f9', fontSize: 14, fontWeight: '700' },
  cardDetail: { color: '#94a3b8', fontSize: 12, marginTop: 3 },
  cardSubtext: { color: '#64748b', fontSize: 11, marginTop: 4, fontStyle: 'italic' },
  cardTimestamp: { color: '#334155', fontSize: 10, marginTop: 8, textAlign: 'right' },

  // Match
  matchIcon: { fontSize: 24, marginTop: 2 },
  matchTitle: { color: '#f472b6', fontSize: 15, fontWeight: '700' },

  // Score Badge
  scoreBadge: {
    width: 48,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreBadgeText: { fontSize: 14, fontWeight: '800' },

  // Proposal / Accept icons
  proposalIcon: { fontSize: 20, marginTop: 2 },

  // Tx Link
  txLink: { color: '#60a5fa', fontSize: 12, fontWeight: '600', marginTop: 4 },

  // Transcript
  transcriptContainer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.05)',
  },
  transcriptTitle: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  messageBubble: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    marginBottom: 6,
    maxWidth: '85%',
  },
  bubbleA: {
    backgroundColor: 'rgba(96,165,250,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.15)',
    alignSelf: 'flex-start',
  },
  bubbleB: {
    backgroundColor: 'rgba(167,139,250,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(167,139,250,0.15)',
    alignSelf: 'flex-end',
  },
  messageSpeaker: { color: '#64748b', fontSize: 10, fontWeight: '600', marginBottom: 2 },
  messageText: { color: '#cbd5e1', fontSize: 12, lineHeight: 17 },

  // Walrus refs
  refsContainer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
  },
  refText: { color: '#475569', fontSize: 11, marginBottom: 3 },

  // Expand arrow -> View Chat Button
  viewChatBtn: {
    color: '#60a5fa',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: 'rgba(96,165,250,0.1)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    overflow: 'hidden',
    alignSelf: 'center',
  },

  // Modal Styles
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContainer: {
    width: '100%',
    maxWidth: 500,
    maxHeight: '80%',
    backgroundColor: '#110f1a',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    backgroundColor: 'rgba(255,255,255,0.02)',
  },
  modalTitle: { color: '#f8fafc', fontSize: 16, fontWeight: '700' },
  closeBtn: { padding: 4 },
  closeBtnText: { color: '#94a3b8', fontSize: 20, fontWeight: '400', lineHeight: 20 },
  modalScroll: { padding: 16 },
  emptyChatText: { color: '#64748b', fontSize: 13, textAlign: 'center', marginTop: 20 },

  // Status grid
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  statusItem: {
    width: '33.33%',
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.04)',
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.04)',
  },
  statusLabel: { color: '#475569', fontSize: 10, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3 },
  statusValue: { color: '#e2e8f0', fontSize: 16, fontWeight: '800', marginTop: 2 },
  statusTimestamp: { color: '#334155', fontSize: 10, marginTop: 6, textAlign: 'right' },

  // Empty state
  emptyState: { alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyIcon: { fontSize: 40, marginBottom: 16 },
  emptyTitle: { color: '#e2e8f0', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  emptyBody: { color: '#64748b', fontSize: 14, textAlign: 'center', lineHeight: 20 },
});
