module chaptr::mandate {
    use std::string::String;
    use sui::event;

    // ─── Errors ───────────────────────────────────────────────────────────────
    const ENotOwner    : u64 = 0;
    const EA2ADisabled : u64 = 2;

    // ─── Object ───────────────────────────────────────────────────────────────

    /// Scoped Autonomy object. Lives in the user's wallet alongside their
    /// DigitalTwin. Defines what their Twin is permitted to do autonomously.
    ///
    /// Loose coupling: Mandate does not wrap or reference DigitalTwin directly.
    /// Reason: during a match, DigitalTwin is locked inside the Match object
    /// and unavailable. Mandate stays in the wallet and remains updatable
    /// regardless of match state. The app layer is responsible for checking
    /// match state before triggering autonomous actions.
    public struct Mandate has key, store {
        id: UID,
        owner: address,

        // ── Permission flags ──
        may_scout: bool,           // Twin may scan pool and score candidates
        may_run_a2a: bool,         // Twin may initiate Agent-to-Agent conversations
        may_propose: bool,         // Twin may auto-propose without human approval

        // ── Thresholds ────────
        min_score_to_propose: u8,  // Only auto-propose if A2A score >= this value

        // ── A2A state ─────────
        last_a2a_partner: address, // Owner address of the candidate Twin spoke with
        last_a2a_score: u8,        // Compatibility score from last A2A conversation
        a2a_transcript_ref: String, // Walrus blob ID of the A2A transcript
        a2a_report_ref: String,     // Walrus blob ID of the A2A compatibility report

        // ── Metadata ──────────
        created_at: u64,
        updated_at: u64,
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct MandateCreated has copy, drop {
        mandate_id: address,
        owner: address,
        may_scout: bool,
        may_run_a2a: bool,
        may_propose: bool,
        min_score_to_propose: u8,
    }

    public struct MandateUpdated has copy, drop {
        mandate_id: address,
        owner: address,
        may_scout: bool,
        may_run_a2a: bool,
        may_propose: bool,
        min_score_to_propose: u8,
    }

    public struct A2AResultRecorded has copy, drop {
        mandate_id: address,
        owner: address,
        partner: address,
        score: u8,
        transcript_ref: String,
        report_ref: String,
        auto_proposed: bool,  // true if score >= min_score_to_propose AND may_propose=true
    }

    // ─── Entry Functions ──────────────────────────────────────────────────────

    /// Mint a Mandate object and transfer it to the caller's wallet.
    /// Existing accounts call this once — no twin re-mint required.
    public entry fun create_mandate(
        may_scout: bool,
        may_run_a2a: bool,
        may_propose: bool,
        min_score_to_propose: u8,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();

        let mandate = Mandate {
            id: object::new(ctx),
            owner: sender,
            may_scout,
            may_run_a2a,
            may_propose,
            min_score_to_propose,
            last_a2a_partner: @0x0,
            last_a2a_score: 0,
            a2a_transcript_ref: std::string::utf8(b""),
            a2a_report_ref: std::string::utf8(b""),
            created_at: ctx.epoch(),
            updated_at: ctx.epoch(),
        };

        event::emit(MandateCreated {
            mandate_id: object::uid_to_address(&mandate.id),
            owner: sender,
            may_scout,
            may_run_a2a,
            may_propose,
            min_score_to_propose,
        });

        sui::transfer::public_transfer(mandate, sender);
    }

    /// Update permission flags and threshold.
    /// Called from the Twin Autonomy section in twin-training.tsx.
    public entry fun update_mandate(
        mandate: &mut Mandate,
        may_scout: bool,
        may_run_a2a: bool,
        may_propose: bool,
        min_score_to_propose: u8,
        ctx: &mut TxContext,
    ) {
        assert!(mandate.owner == ctx.sender(), ENotOwner);

        mandate.may_scout = may_scout;
        mandate.may_run_a2a = may_run_a2a;
        mandate.may_propose = may_propose;
        mandate.min_score_to_propose = min_score_to_propose;
        mandate.updated_at = ctx.epoch();

        event::emit(MandateUpdated {
            mandate_id: object::uid_to_address(&mandate.id),
            owner: ctx.sender(),
            may_scout,
            may_run_a2a,
            may_propose,
            min_score_to_propose,
        });
    }

    /// Record the result of an A2A conversation on-chain.
    /// Called by the app after:
    ///   1. runA2AConversation() completes in aiEngine.js
    ///   2. Transcript + report uploaded to Walrus
    ///   3. App has verified the user is NOT currently in a match
    ///
    /// The auto_proposed flag in the event tells the Activity Log
    /// whether a proposal was fired automatically after this A2A.
    public entry fun record_a2a_result(
        mandate: &mut Mandate,
        partner_owner: address,
        transcript_ref: String,
        report_ref: String,
        score: u8,
        ctx: &mut TxContext,
    ) {
        assert!(mandate.owner == ctx.sender(), ENotOwner);
        assert!(mandate.may_run_a2a, EA2ADisabled);

        mandate.last_a2a_partner = partner_owner;
        mandate.last_a2a_score = score;
        mandate.a2a_transcript_ref = transcript_ref;
        mandate.a2a_report_ref = report_ref;
        mandate.updated_at = ctx.epoch();

        let auto_proposed = mandate.may_propose && score >= mandate.min_score_to_propose;

        event::emit(A2AResultRecorded {
            mandate_id: object::uid_to_address(&mandate.id),
            owner: ctx.sender(),
            partner: partner_owner,
            score,
            transcript_ref,
            report_ref,
            auto_proposed,
        });
    }

    // ─── Read Helpers (for app-layer checks) ──────────────────────────────────

    /// Returns true if the Twin is allowed to scout the pool.
    public fun can_scout(mandate: &Mandate): bool {
        mandate.may_scout
    }

    /// Returns true if the Twin is allowed to run A2A conversations.
    public fun can_run_a2a(mandate: &Mandate): bool {
        mandate.may_run_a2a
    }

    /// Returns true if the Twin should auto-propose for a given score.
    /// App calls this after A2A completes to decide whether to fire propose_match.
    public fun should_auto_propose(mandate: &Mandate, score: u8): bool {
        mandate.may_propose && score >= mandate.min_score_to_propose
    }
}
