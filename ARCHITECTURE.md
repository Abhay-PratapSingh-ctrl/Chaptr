# 💜 Chaptr: The Agentic AI Matchmaking Protocol

Chaptr is a next-generation **AI-first matchmaking platform** built on the Sui blockchain. It bridges autonomous AI agents with on-chain identity, scoped permissions, and escrow-based matching.

---

## 🏛️ Architecture Overview

Chaptr is designed as a modular, three-layer system where each component has a distinct responsibility:

### High-Level System Flow
```mermaid
graph TD
    User((User)) -->|Create Profile| App[Chaptr Mobile - Expo/React Native]
    App -->|Mint Twin + Set Mandate| BC[(Sui Blockchain)]
    
    subgraph "Chaptr Core"
        Agent[agent.move - Identity]
        Mandate[mandate.move - Autonomy]
        Matchmaker[matchmaker.move - Escrow]
        Chat[chat.move - Events]
    end

    App -->|Scout Profiles| Agent
    App -->|A2A Conversations| AI[Groq LLaMA 3.1 8B]
    AI -->|Compatibility Report| App
    App -->|Propose Match| Matchmaker
    Matchmaker -->|Twin Escrow| BC
    
    App -->|Upload Blobs| Walrus[Walrus Testnet]
    App -->|Chat Messages| Chat
    Chat -->|Events| Walrus

    subgraph "Auth & Gas Layer"
        App -->|Google OAuth| Google[Google OAuth]
        App -->|ZK Proof| Enoki[Mysten Enoki]
        App -->|Gas Sponsorship| Shinami[Shinami API]
    end
```

### Component Breakdown

1. **Chaptr Mobile App (React Native)**: The "Command Center". Premium UI for profile setup, Twin training, scouting, A2A conversations, proposals, human chat, and reflection feedback.
2. **Smart Contracts (Sui Move)**: The "Protocol". On-chain identity (DigitalTwin NFTs), scoped autonomy (Mandates), physical escrow matching, and event-based messaging.
3. **AI Engine (Groq)**: The "Brain". Runs multi-turn A2A conversations between Digital Twins to assess compatibility autonomously.
4. **Twin Memory (TypeScript)**: The "Memory". 80 personality facts, Scout Capsules (public dating profiles), and feedback-driven learning loops.
5. **Walrus Storage**: The "Vault". Decentralized blob storage for scout capsules, personality vectors, A2A transcripts, chat messages, and safety reports.
6. **Shinami Gas Station**: The "Fuel". Invisible gas sponsorship for a completely gasless user experience via secure backend routing.

---

## 🔬 Technical Deep-Dive

### 1. Digital Twin Identity (`agent.move`)

The DigitalTwin is a Sui object with `key` and `store` abilities, making it transferable and **wrappable** by value into other objects.

```mermaid
graph LR
    subgraph "On-Chain"
        DT["DigitalTwin\nid · owner · vector_ref · is_active"]
        TP["TwinPool (shared)\nentries: vector of TwinPoolEntry"]
        TPE["TwinPoolEntry\ntwin_id · owner · scout_ref · joined_at_epoch"]
    end
    subgraph "Walrus"
        PV["Private Blob\nXOR-encrypted vectors"]
        SC["Scout Capsule\nPublic JSON profile"]
    end
    DT -->|vector_ref| PV
    TPE -->|scout_ref| SC
    TP -->|contains| TPE
```

**Key Functions:**
- `mint_agent_and_register(pool, private_ref, scout_ref)` — Primary onboarding: mint Twin + add to pool
- `update_scout_ref(pool, new_ref)` — Update public profile after Twin learning
- `update_vector(agent, new_ref)` — Update private personality data
- `deactivate_agent(agent)` — Soft delete

**Init**: Creates a single shared `TwinPool` object at package publish time.

### 2. Scoped Autonomy (`mandate.move`)

The Mandate defines **what a Twin can do autonomously**. It's deliberately **loosely coupled** from the DigitalTwin — no import, no reference. This is because when a Twin is locked in escrow (Match/Proposal), the Mandate must remain accessible in the wallet for updates.

```mermaid
graph TB
    M["Mandate Object"] --> S{Permission Check}
    S -->|may_scout = true| Scout["Browse TwinPool"]
    S -->|may_run_a2a = true| A2A["Run A2A Conversation"]
    S -->|may_propose = true| Propose["Auto-Propose if score ≥ min"]
    A2A --> Record["record_a2a_result()"]
    Record --> Event["A2AResultRecorded Event\nauto_proposed: bool"]
```

**Mandate Fields:**
| Field | Type | Description |
|-------|------|-------------|
| `may_scout` | `bool` | Twin can browse profiles |
| `may_run_a2a` | `bool` | Twin can initiate AI conversations |
| `may_propose` | `bool` | Twin can auto-propose matches |
| `min_score_to_propose` | `u8` | Minimum score threshold (70–99) |
| `last_a2a_partner` | `address` | Last A2A conversation partner |
| `last_a2a_score` | `u8` | Last A2A compatibility score |
| `a2a_transcript_ref` | `String` | Walrus blob ID of conversation transcript |
| `a2a_report_ref` | `String` | Walrus blob ID of compatibility report |

### 3. Escrow-Based Matching (`matchmaker.move`)

This is the most architecturally significant module. It uses **physical object wrapping as an exclusivity mechanism**.

```mermaid
sequenceDiagram
    participant A as User A (Wallet)
    participant P as MatchProposal (Shared)
    participant M as Match (Shared)
    participant B as User B (Wallet)
    
    A->>P: propose_match(twin_a, target=B, score, msg)
    Note over A: ⚠️ Twin A leaves wallet
    Note over P: Twin A locked in escrow
    
    alt Target Accepts
        B->>M: accept_proposal(proposal, twin_b)
        Note over B: ⚠️ Twin B leaves wallet
        Note over M: Both twins locked
        Note over A,B: Human Chat unlocked
        A->>M: end_match() OR B->>M: end_match()
        M->>A: Twin A returned
        M->>B: Twin B returned
    else Target Rejects
        B->>P: reject_proposal(proposal)
        P->>A: Twin A returned
    else Proposer Withdraws
        A->>P: withdraw_proposal(proposal)
        P->>A: Twin A returned
    end
```

**Constants:**
- `MIN_SCORE: u8 = 70` — Minimum similarity score to propose

**Why this works:** The `store` ability on `DigitalTwin` allows it to be consumed by value and embedded as a field in `MatchProposal` and `Match`. When your Twin is inside a proposal, it **literally doesn't exist in your wallet** — making double-proposals impossible at the object model level, not just application logic.

### 4. Event-Only Messaging (`chat.move`)

The chat module is deliberately minimal — a separate package with zero on-chain state:

```move
public entry fun send_message(match_id: address, blob_id: String, ctx: &mut TxContext) {
    event::emit(MessageSent {
        match_id,
        sender: ctx.sender(),
        blob_id,
        sent_at: tx_context::epoch(ctx),
    });
}
```

- **No objects created** — chat history is reconstructed by indexing `MessageSent` events
- **Message content on Walrus** — only the blob ID is emitted on-chain
- **No access control** — the app layer validates that the sender is a match participant
- **Separate package** — no dependency on `chaptr`, `match_id` is a raw address

### 5. zkLogin Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant A as Chaptr App
    participant G as Google OAuth
    participant E as Enoki API
    participant S as Sui Testnet

    U->>A: Tap "Connect with Google"
    A->>S: getEpoch()
    S-->>A: currentEpoch
    A->>A: Generate Ed25519 ephemeral keypair
    A->>A: maxEpoch = currentEpoch + 2
    A->>A: Generate randomness + nonce
    A->>A: Store keys in SecureStore
    A->>G: OAuth redirect (nonce in request)
    G-->>A: JWT (id_token)
    A->>E: GET /zklogin (JWT header)
    E-->>A: { salt, address }
    A->>E: POST /zklogin/zkp (JWT + ephemeral key)
    E-->>A: { proofPoints, addressSeed }
    A->>A: Store proof + Sui address
    Note over A,S: Ready to sign transactions with ZK signature
```

**Key Design Decisions:**
- **Epoch-bound sessions**: `maxEpoch = currentEpoch + 2` (~2 days), after which re-auth is needed
- **Platform-adaptive storage**: `expo-secure-store` on native, `localStorage` on web
- **Gasless Transactions**: Shinami Gas Station sponsors all transactions via a secure backend route (`/api/sponsor`), shielding users from gas fees and eliminating the need for a faucet.

### 6. A2A Conversation Pipeline (`aiEngine.js`)

```mermaid
flowchart LR
    A["Cache\nCheck"] -->|Miss| B["Build\nPersonas"]
    A -->|Hit| F["Return\nCached"]
    B --> C["7-Message\nConversation"]
    C --> D["Compatibility\nReport"]
    D --> E["Store\nResults"]
    
    C -.->|"Groq API\nLLaMA 3.1 8B\nTemp 0.7"| C
    D -.->|"JSON: score, summary,\nchemistry, redFlags,\nrecommendation"| D
    E -.->|"Parallel:\n· Transcript → Walrus\n· Report → Walrus\n· Result → AsyncStorage"| E
```

**Persona Construction:** The system prompt for each Twin is built from their Scout Capsule — bio, lookingFor, communicationStyle, mustHave, dealBreaker.

**Conversation Structure:** Twin A opener (150 tokens) → 3 rounds of Twin B response + Twin A response → 7 total messages.

**Report Parsing:** Robust JSON extraction with fallback defaults if parsing fails. Score range 0–99, recommendation is "propose" or "pass".

### 7. Twin Memory & Scout Capsules (`twinMemory.ts`)

The memory system manages 80 personality facts that feed into a publishable Scout Capsule:

```mermaid
flowchart TD
    O["Onboarding\n9 questions"] -->|buildOnboardingMemoryFacts| F["Memory Facts\nmax 80"]
    P["Profile Setup\nbio, values, prefs"] -->|buildProfileMemoryFacts| F
    C["Chat Signals\n'I am/like/want'"] -->|rememberChatSignal| F
    R["Reflection Feedback\naccuracy, blocks"] -->|appendFeedback| F
    
    F -->|buildScoutCapsule| SC["Scout Capsule\n(private, with feedback)"]
    SC -->|buildPublicSafe| PSC["Published Scout Capsule\n(no feedback, + training summary)"]
    PSC -->|uploadToWalrus| W["Walrus Blob"]
    W -->|blobId| Chain["TwinPoolEntry.scout_ref"]
```

**Memory Fact Categories:** `dating`, `traits`, `conversation`, `values`, `care`, `boundaries`, `voice`

**Visibility Levels:** `scout` (public in capsule), `private` (local only), `never_share` (excluded from everything)

**Feedback Loop:** Blocks, reports, match reflections, and accuracy ratings all feed back as training signals, creating a continuous learning loop for the Twin.

---

## 📊 Data Storage Map

| Data | Local (AsyncStorage) | On-Chain (Sui) | Walrus |
|------|---------------------|----------------|--------|
| zkLogin keys | SecureStore ✅ | — | — |
| Profile data | `chaptr:profile` | — | — |
| Memory facts | `chaptr:twin-memory` (80) | — | — |
| Scout Capsule | `chaptr:my-scout-capsule` | `TwinPoolEntry.scout_ref` | ✅ JSON |
| Private vectors | — | `DigitalTwin.vector_ref` | ✅ Encrypted |
| A2A results | Cached per-pair | `Mandate.a2a_*_ref` | ✅ Transcript + Report |
| Match state | `chaptr:human-matches` | `Match` shared object | — |
| Chat messages | — | `MessageSent` events | ✅ Blobs |
| Block list | `chaptr:block-list` (200) | — | ✅ Entries |
| Safety reports | `chaptr:safety-reports` (100) | — | ✅ Reports |

---

## 🔐 Security Model

| Layer | Mechanism | Protection |
|-------|----------|-----------|
| **Authentication** | zkLogin (ZK proofs) | Google identity never revealed on-chain |
| **Key Storage** | expo-secure-store | Hardware-encrypted on native devices |
| **Matching** | Object wrapping (escrow) | Double-proposals cryptographically impossible |
| **Contract Access** | Owner assertions | All mutations check `sender == owner` |
| **Score Threshold** | `MIN_SCORE = 70` | Enforced on-chain, clamped 70–99 client-side |
| **Privacy** | Dual blob architecture | Public scout data separated from encrypted private data |
| **Content Safety** | Block/report + feedback | Walrus persistence + Twin training integration |

---

## ⚙️ Deployment

| Resource | Address / ID |
|----------|-------------|
| `chaptr` package | `0x715ce4a6a2180c22f89243a2e1a0eca5ed0ad1b33a9fda2a6986f538ce4ca31c` |
| `chaptr_chat` package | `0xa767f4fb74ede5adade9001f18bb159206d30b4f2dc77ec36b2b73a62eb401b4` |
| TwinPool (shared object) | `0x5ca4a4db5dbb17c841dd61417cc9cb035bde33323eceb27848f1752267384653` |
| Chain | Sui Testnet (`4c78adac`) |
| Walrus Publisher | `publisher.walrus-testnet.walrus.space` |
| Walrus Aggregator | `aggregator.walrus-testnet.walrus.space` |

---

<p align="center">
  <b>Built with 💜 on Sui · Powered by Walrus · Secured by zkLogin</b>
</p>
