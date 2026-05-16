module chaptr::matchmaker {
    use std::string::String;
    // IMPORT THE DIGITAL TWIN
    use chaptr::agent::DigitalTwin;

    // ─── Errors ───────────────────────────────────────────────────────────────
    const ENotProposalTarget : u64 = 0;
    const ENotOwner          : u64 = 1;
    const EScoreTooLow       : u64 = 2;
    const ENotParticipant    : u64 = 3;

    const MIN_SCORE: u8 = 70;

    // ─── Objects ──────────────────────────────────────────────────────────────

    /// The Proposal acts as an Escrow. User A's agent is locked inside here.
    public struct MatchProposal has key, store {
        id: UID,
        from: address,
        to: address,
        agent_a: DigitalTwin,    // <-- WRAPPED: User A's Agent is held in escrow
        similarity_score: u8,
        message: String,
    }

    /// The active date. BOTH agents are locked inside this shared object.
    public struct Match has key, store {
        id: UID,
        participant_a: address,
        participant_b: address,
        agent_a: DigitalTwin,    // <-- WRAPPED: User A's Agent
        agent_b: DigitalTwin,    // <-- WRAPPED: User B's Agent
        score: u8,
        matched_at: u64,
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct ProposalSent has copy, drop {
        proposal_id: address,
        from: address,
        to: address,
        score: u8,
    }

    public struct MatchFormed has copy, drop {
        match_id: address,
        participant_a: address,
        participant_b: address,
        score: u8,
    }

    public struct MatchEnded has copy, drop {
        match_id: address,
        ended_by: address,
    }

    // ─── Functions ────────────────────────────────────────────────────────────

    /// User A proposes. They must pass their actual DigitalTwin object (by value) to lock it.
    public entry fun propose_match(
        agent_a: DigitalTwin, // <-- Takes ownership of the agent!
        to: address,
        similarity_score: u8,
        message: String,
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        assert!(similarity_score >= MIN_SCORE, EScoreTooLow);

        let proposal = MatchProposal {
            id: object::new(ctx),
            from: sender,
            to,
            agent_a, // Escrow the agent
            similarity_score,
            message,
        };

        sui::event::emit(ProposalSent {
            proposal_id: object::uid_to_address(&proposal.id),
            from: sender,
            to,
            score: similarity_score,
        });

        // The proposal is shared so User B can accept/reject, and User A can withdraw
        sui::transfer::share_object(proposal);
    }

    /// User B accepts. They must pass their DigitalTwin to complete the lockdown.
    public entry fun accept_proposal(
        proposal: MatchProposal,
        agent_b: DigitalTwin, // <-- User B brings their agent to be locked
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        assert!(proposal.to == sender, ENotProposalTarget);

        // Unpack the proposal to get User A's locked agent
        let MatchProposal { id, from, to, agent_a, similarity_score, message: _ } = proposal;
        object::delete(id);

        let new_match = Match {
            id: object::new(ctx),
            participant_a: from,
            participant_b: to,
            agent_a, // Lock A
            agent_b, // Lock B
            score: similarity_score,
            matched_at: ctx.epoch(),
        };

        sui::event::emit(MatchFormed {
            match_id: object::uid_to_address(&new_match.id),
            participant_a: from,
            participant_b: to,
            score: similarity_score,
        });

        // The Match is shared so either party can choose to end it later
        sui::transfer::share_object(new_match);
    }

    /// User B rejects. The proposal is destroyed and User A's agent is returned.
    public entry fun reject_proposal(
        proposal: MatchProposal,
        ctx: &mut TxContext
    ) {
        assert!(proposal.to == ctx.sender(), ENotProposalTarget);
        
        let MatchProposal { id, from, to: _, agent_a, similarity_score: _, message: _ } = proposal;
        object::delete(id);
        
        // Return the escrowed agent back to User A's wallet
        sui::transfer::public_transfer(agent_a, from);
    }

    /// User A withdraws their proposal. Their agent is returned.
    public entry fun withdraw_proposal(
        proposal: MatchProposal,
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        assert!(proposal.from == sender, ENotOwner);

        let MatchProposal { id, from, to: _, agent_a, similarity_score: _, message: _ } = proposal;
        object::delete(id);
        
        // Return the escrowed agent back to User A's wallet
        sui::transfer::public_transfer(agent_a, from);
    }

    /// Either user can end the date. The match is destroyed and BOTH agents are returned.
    public entry fun end_match(
        active_match: Match,
        ctx: &mut TxContext
    ) {
        let sender = ctx.sender();
        assert!(
            active_match.participant_a == sender || active_match.participant_b == sender, 
            ENotParticipant
        );

        sui::event::emit(MatchEnded {
            match_id: object::uid_to_address(&active_match.id),
            ended_by: sender,
        });

        // Unpack the match
        let Match { id, participant_a, participant_b, agent_a, agent_b, score: _, matched_at: _ } = active_match;
        object::delete(id);

        // Unwrap and return both agents to their rightful owners so they can date again
        sui::transfer::public_transfer(agent_a, participant_a);
        sui::transfer::public_transfer(agent_b, participant_b);
    }
}