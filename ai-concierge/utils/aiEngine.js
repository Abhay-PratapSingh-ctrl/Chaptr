// utils/aiEngine.js
// Central AI engine for Chaptr — A2A conversations, compatibility analysis.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { emitEvent } from './telemetry';

const GROQ_API_KEY = process.env.EXPO_PUBLIC_GROQ_API_KEY || '';
const GROQ_MODEL = 'llama-3.1-8b-instant';
const PUBLISHER = 'https://publisher.walrus-testnet.walrus.space';

// Cache key: scoped to the pair so each direction is independent
const a2aCacheKey = (myOwner, candidateOwner) =>
  `chaptr:a2a-result:${myOwner.toLowerCase()}:${candidateOwner.toLowerCase()}`;

export const getCachedA2AResult = async (myOwner, candidateOwner) => {
  try {
    const raw = await AsyncStorage.getItem(a2aCacheKey(myOwner, candidateOwner));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const clearA2ACache = async (myOwner, candidateOwner) => {
  try {
    await AsyncStorage.removeItem(a2aCacheKey(myOwner, candidateOwner));
  } catch { /* non-blocking */ }
};

const saveA2AResult = async (myOwner, candidateOwner, result) => {
  try {
    await AsyncStorage.setItem(
      a2aCacheKey(myOwner, candidateOwner),
      JSON.stringify({ ...result, cachedAt: new Date().toISOString() }),
    );
  } catch { /* non-blocking */ }
};

const extractBlobId = (result) =>
  result.newlyCreated?.blobObject?.blobId ?? result.alreadyCertified?.blobId ?? null;

const uploadJsonToWalrus = async (payload) => {
  const response = await fetch(`${PUBLISHER}/v1/blobs?epochs=50`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Walrus upload failed: ${response.status}`);
  const result = await response.json();
  const blobId = extractBlobId(result);
  if (!blobId) throw new Error('No blobId in Walrus response');
  return blobId;
};

const callGroq = async (prompt, maxTokens = 1000) => {
  if (!GROQ_API_KEY) throw new Error('Missing EXPO_PUBLIC_GROQ_API_KEY');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: maxTokens,
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? `Groq failed: ${response.status}`);
  return data?.choices?.[0]?.message?.content ?? '';
};

const buildTwinPersona = (profile, name) => {
  const parts = [
    `You are ${name}'s Digital Twin — an AI agent representing them in the dating process.`,
    profile.bio ? `Their bio: "${profile.bio}"` : null,
    profile.lookingFor ? `They are looking for: ${profile.lookingFor}` : null,
    profile.communicationStyle ? `Their communication style: ${profile.communicationStyle}` : null,
    profile.mustHave ? `Their must-have: ${profile.mustHave}` : null,
    profile.dealBreaker ? `Their deal-breaker: ${profile.dealBreaker}` : null,
    'Speak naturally and authentically on their behalf. Keep messages concise.',
  ];
  return parts.filter(Boolean).join('\n');
};

export const runA2AConversation = async (myProfile, candidateProfile) => {
  const myOwner = myProfile.owner;
  const candidateOwner = candidateProfile.owner;

  // ── TELEMETRY: A2A start ───────────────────────────────────────────────
  const pairKey = `${(myOwner ?? '').slice(0, 8)}:${(candidateOwner ?? '').slice(0, 8)}`;
  emitEvent('a2a_start', {
    myOwner: myOwner?.slice(0, 10) ?? null,
    candidateOwner: candidateOwner?.slice(0, 10) ?? null,
    candidateName: candidateProfile.displayName || 'Unknown',
  }, myOwner ?? '', `a2a_start:${pairKey}`);

  // ── Cache check — skip Groq entirely if already ran ──────────────────────
  if (myOwner && candidateOwner) {
    const cached = await getCachedA2AResult(myOwner, candidateOwner);
    if (cached) {
      console.log('[A2A] Cache hit for', candidateOwner.slice(0, 10));

      // ── TELEMETRY: A2A cache hit (complete immediately) ────────────────
      emitEvent('a2a_complete', {
        source: 'cache',
        candidateOwner: candidateOwner.slice(0, 10),
        candidateName: candidateProfile.displayName || 'Unknown',
        score: cached.score,
        summary: cached.summary || null,
        chemistry: cached.chemistry || null,
        recommendation: cached.recommendation,
        transcriptRef: cached.transcriptRef?.slice(0, 14) ?? null,
        reportRef: cached.reportRef?.slice(0, 14) ?? null,
        messageCount: cached.transcript?.length ?? 0,
        transcript: cached.transcript || [],
      }, myOwner, `a2a_complete:${pairKey}`);

      return cached;
    }
  }

  const myName = myProfile.displayName || 'Twin A';
  const candidateName = candidateProfile.displayName || 'Twin B';

  const twinAPersona = buildTwinPersona(myProfile, myName);
  const twinBPersona = buildTwinPersona(candidateProfile, candidateName);

  const transcript = [];

  // Twin A opens the conversation
  const opener = await callGroq(
    `${twinAPersona}\n\nYou are ${myName}'s Digital Twin reaching out to ${candidateName}'s Digital Twin to assess compatibility on behalf of your human.\n\nWrite a single opening message (2-3 sentences max). Be natural, curious, and genuine. Do not use quotation marks. Just write the message directly.`,
    150,
  );

  transcript.push({ role: 'twin_a', speaker: myName, message: opener.trim() });

  // ── TELEMETRY: first A2A message ─────────────────────────────────────
  emitEvent('a2a_message', {
    speaker: myName,
    role: 'twin_a',
    messageIndex: 0,
    preview: opener.trim().slice(0, 80),
  }, myOwner ?? '', `a2a_msg:${pairKey}:0`);

  // 3 exchanges back and forth
  for (let i = 0; i < 3; i++) {
    const conversationSoFar = transcript
      .map((t) => `${t.speaker}'s Twin: ${t.message}`)
      .join('\n\n');

    // Twin B responds
    const bResponse = await callGroq(
      `${twinBPersona}\n\nYou are ${candidateName}'s Digital Twin in a conversation with ${myName}'s Digital Twin.\n\nConversation so far:\n${conversationSoFar}\n\nWrite ${candidateName}'s Twin's next response (2-3 sentences). Be authentic to their profile. Do not use quotation marks. Just write the message directly.`,
      150,
    );

    transcript.push({ role: 'twin_b', speaker: candidateName, message: bResponse.trim() });

    // ── TELEMETRY: Twin B message ──────────────────────────────────────
    emitEvent('a2a_message', {
      speaker: candidateName,
      role: 'twin_b',
      messageIndex: transcript.length - 1,
      preview: bResponse.trim().slice(0, 80),
    }, myOwner ?? '', `a2a_msg:${pairKey}:${transcript.length - 1}`);

    // Twin A responds back (skip on last exchange)
    if (i < 2) {
      const conversationWithB = transcript
        .map((t) => `${t.speaker}'s Twin: ${t.message}`)
        .join('\n\n');

      const aResponse = await callGroq(
        `${twinAPersona}\n\nYou are ${myName}'s Digital Twin in a conversation with ${candidateName}'s Digital Twin.\n\nConversation so far:\n${conversationWithB}\n\nWrite ${myName}'s Twin's next response (2-3 sentences). Do not use quotation marks. Just write the message directly.`,
        150,
      );

      transcript.push({ role: 'twin_a', speaker: myName, message: aResponse.trim() });

      // ── TELEMETRY: Twin A response ────────────────────────────────────
      emitEvent('a2a_message', {
        speaker: myName,
        role: 'twin_a',
        messageIndex: transcript.length - 1,
        preview: aResponse.trim().slice(0, 80),
      }, myOwner ?? '', `a2a_msg:${pairKey}:${transcript.length - 1}`);
    }
  }

  // Generate compatibility report from the full conversation
  const conversationText = transcript
    .map((t) => `${t.speaker}'s Twin: ${t.message}`)
    .join('\n\n');

  const reportPrompt = `You are Chaptr's compatibility analyst.

Two Digital Twins just had this conversation on behalf of their humans:

${conversationText}

Profile A (${myName}):
- Looking for: ${myProfile.lookingFor || 'not specified'}
- Communication style: ${myProfile.communicationStyle || 'not specified'}
- Must-have: ${myProfile.mustHave || 'not specified'}
- Deal-breaker: ${myProfile.dealBreaker || 'not specified'}

Profile B (${candidateName}):
- Looking for: ${candidateProfile.lookingFor || 'not specified'}
- Communication style: ${candidateProfile.communicationStyle || 'not specified'}
- Must-have: ${candidateProfile.mustHave || 'not specified'}
- Deal-breaker: ${candidateProfile.dealBreaker || 'not specified'}

Return ONLY valid JSON. No markdown. No backticks.

{
  "score": 85,
  "summary": "One sentence about the compatibility outcome.",
  "chemistry": "One sentence about the conversational energy.",
  "redFlags": "One sentence about any concerns, or null if none.",
  "recommendation": "propose"
}

recommendation must be exactly "propose" or "pass".`;

  let reportData = {
    score: 75,
    summary: `${myName} and ${candidateName}'s Twins had a natural exchange.`,
    chemistry: 'The conversation flowed without friction.',
    redFlags: null,
    recommendation: 'propose',
  };

  try {
    const reportText = await callGroq(reportPrompt, 300);
    const cleaned = reportText.replace(/```json/g, '').replace(/```/g, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    const jsonStr = firstBrace !== -1 && lastBrace > firstBrace
      ? cleaned.slice(firstBrace, lastBrace + 1)
      : cleaned;
    const parsed = JSON.parse(jsonStr);
    reportData = {
      score: Math.max(0, Math.min(99, Math.round(Number(parsed.score) || 75))),
      summary: parsed.summary || reportData.summary,
      chemistry: parsed.chemistry || reportData.chemistry,
      redFlags: parsed.redFlags || null,
      recommendation: parsed.recommendation === 'pass' ? 'pass' : 'propose',
    };
  } catch (err) {
    console.warn('[A2A] Report generation failed, using fallback:', err);
  }

  // ── TELEMETRY: report generated ──────────────────────────────────────
  emitEvent('report_generated', {
    candidateName,
    score: reportData.score,
    recommendation: reportData.recommendation,
    chemistry: reportData.chemistry?.slice(0, 80) ?? null,
  }, myOwner ?? '', `report:${pairKey}`);

  // Upload transcript and report to Walrus
  const transcriptPayload = {
    version: 1,
    kind: 'chaptr-a2a-transcript',
    participants: { a: myName, b: candidateName },
    ownerA: myOwner || null,
    ownerB: candidateOwner || null,
    transcript,
    createdAt: new Date().toISOString(),
  };

  const reportPayload = {
    version: 1,
    kind: 'chaptr-a2a-report',
    participants: { a: myName, b: candidateName },
    ownerA: myOwner || null,
    ownerB: candidateOwner || null,
    report: reportData,
    messageCount: transcript.length,
    createdAt: new Date().toISOString(),
  };

  let transcriptRef = null;
  let reportRef = null;

  try {
    [transcriptRef, reportRef] = await Promise.all([
      uploadJsonToWalrus(transcriptPayload),
      uploadJsonToWalrus(reportPayload),
    ]);

    // ── TELEMETRY: Walrus upload success ──────────────────────────────
    emitEvent('walrus_upload', {
      candidateName,
      transcriptRef: transcriptRef?.slice(0, 14) ?? null,
      reportRef: reportRef?.slice(0, 14) ?? null,
      status: 'success',
    }, myOwner ?? '', `walrus:${pairKey}`);
  } catch (err) {
    console.warn('[A2A] Walrus upload failed (non-blocking):', err);

    // ── TELEMETRY: Walrus upload failed ──────────────────────────────
    emitEvent('walrus_upload', {
      candidateName,
      status: 'failed',
      error: err?.message || 'unknown',
    }, myOwner ?? '', `walrus:${pairKey}`);
  }

  const result = {
    transcript,
    score: reportData.score,
    summary: reportData.summary,
    chemistry: reportData.chemistry,
    redFlags: reportData.redFlags,
    recommendation: reportData.recommendation,
    transcriptRef,
    reportRef,
    candidateName,
    candidateOwner: candidateOwner || null,
  };

  // ── TELEMETRY: A2A complete (fresh Groq path) ────────────────────────
  emitEvent('a2a_complete', {
    source: 'groq',
    candidateOwner: candidateOwner?.slice(0, 10) ?? null,
    candidateName,
    score: reportData.score,
    recommendation: reportData.recommendation,
    summary: reportData.summary || null,
    chemistry: reportData.chemistry || null,
    transcriptRef: transcriptRef?.slice(0, 14) ?? null,
    reportRef: reportRef?.slice(0, 14) ?? null,
    messageCount: transcript.length,
    transcript: transcript,
  }, myOwner ?? '', `a2a_complete:${pairKey}`);

  // ── Persist to AsyncStorage so refresh doesn't re-run Groq ───────────────
  if (myOwner && candidateOwner) {
    await saveA2AResult(myOwner, candidateOwner, result);
  }

  return result;
};