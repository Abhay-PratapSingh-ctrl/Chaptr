module chaptr::matchmaker {
    use std::string::String;
    use chaptr::agent::DigitalTwin;

    // ─── Errors ───────────────────────────────────────────────────────────────
    const ENotProposalTarget : u64 = 0;
    const ENotOwner          : u64 = 1;
    const EScoreTooLow       : u64 = 2;
    const ENotParticipant    : u64 = 3;

    const MIN_SCORE: u8 = 70;

    // ─── Objects ──────────────────────────────────────────────────────────────

    /// The Proposal acts as an Escrow. User A's agent is locked inside here.
    /// Once proposed, the DigitalTwin leaves User A's wallet — they cannot
    /// scout, run A2A, or propose to anyone else until this resolves.
    public struct MatchProposal has key, store {
        id: UID,
        from: address,
        to: address,
        agent_a: DigitalTwin,    // WRAPPED: User A's Twin held in escrow
        similarity_score: u8,
        message: String,
    }

    /// The active match. BOTH twins are locked inside this shared object.
    /// Neither participant can propose or run A2A while this exists —
    /// the chain enforces exclusivity because their DigitalTwin objects
    /// are physically not in their wallets.
    public struct Match has key, store {
        id: UID,
        participant_a: address,
        participant_b: address,
        agent_a: DigitalTwin,    // WRAPPED: User A's Twin
        agent_b: DigitalTwin,    // WRAPPED: User B's Twin
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

    // ─── Entry Functions ──────────────────────────────────────────────────────

    /// User A proposes. They pass their DigitalTwin by value — it leaves
    /// their wallet and is locked in escrow until accepted, rejected, or withdrawn.
    public entry fun propose_match(
        agent_a: DigitalTwin,
        to: address,
        similarity_score: u8,
        message: String,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(similarity_score >= MIN_SCORE, EScoreTooLow);

        let proposal = MatchProposal {
            id: object::new(ctx),
            from: sender,
            to,
            agent_a,
            similarity_score,
            message,
        };

        sui::event::emit(ProposalSent {
            proposal_id: object::uid_to_address(&proposal.id),
            from: sender,
            to,
            score: similarity_score,
        });

        sui::transfer::share_object(proposal);
    }

    /// User B accepts. They pass their DigitalTwin — both twins are now
    /// locked inside the Match object. Neither can be used elsewhere.
    public entry fun accept_proposal(
        proposal: MatchProposal,
        agent_b: DigitalTwin,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(proposal.to == sender, ENotProposalTarget);

        let MatchProposal { id, from, to, agent_a, similarity_score, message: _ } = proposal;
        object::delete(id);

        let new_match = Match {
            id: object::new(ctx),
            participant_a: from,
            participant_b: to,
            agent_a,
            agent_b,
            score: similarity_score,
            matched_at: ctx.epoch(),
        };

        sui::event::emit(MatchFormed {
            match_id: object::uid_to_address(&new_match.id),
            participant_a: from,
            participant_b: to,
            score: similarity_score,
        });

        sui::transfer::share_object(new_match);
    }

    /// User B rejects. Proposal is destroyed, User A's twin is returned to their wallet.
    public entry fun reject_proposal(
        proposal: MatchProposal,
        ctx: &mut TxContext,
    ) {
        assert!(proposal.to == ctx.sender(), ENotProposalTarget);

        let MatchProposal { id, from, to: _, agent_a, similarity_score: _, message: _ } = proposal;
        object::delete(id);

        sui::transfer::public_transfer(agent_a, from);
    }

    /// User A withdraws their proposal. Their twin is returned to their wallet.
    public entry fun withdraw_proposal(
        proposal: MatchProposal,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(proposal.from == sender, ENotOwner);

        let MatchProposal { id, from, to: _, agent_a, similarity_score: _, message: _ } = proposal;
        object::delete(id);

        sui::transfer::public_transfer(agent_a, from);
    }

    /// Either participant ends the match. Both twins are returned to their
    /// respective wallets — they are now free to scout and be proposed to again.
    public entry fun end_match(
        active_match: Match,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();
        assert!(
            active_match.participant_a == sender || active_match.participant_b == sender,
            ENotParticipant,
        );

        sui::event::emit(MatchEnded {
            match_id: object::uid_to_address(&active_match.id),
            ended_by: sender,
        });

        let Match {
            id,
            participant_a,
            participant_b,
            agent_a,
            agent_b,
            score: _,
            matched_at: _,
        } = active_match;
        object::delete(id);

        sui::transfer::public_transfer(agent_a, participant_a);
        sui::transfer::public_transfer(agent_b, participant_b);
    }
}
