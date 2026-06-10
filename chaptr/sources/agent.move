module chaptr::agent {
    use std::string::String;
    use std::vector;
    use sui::event;
    use sui::object::{ID, UID};
    use sui::transfer;
    use sui::tx_context::TxContext;

    // ─── Errors ───────────────────────────────────────────────────────────────
    const ENotOwner      : u64 = 0;
    const EAgentInactive : u64 = 1;
    const EEntryNotFound : u64 = 2;

    // ─── Objects ──────────────────────────────────────────────────────────────

    public struct DigitalTwin has key, store {
        id: UID,
        owner: address,
        vector_ref: String,   // private encrypted Walrus blob ref
        is_active: bool,
    }

    public struct TwinPool has key {
        id: UID,
        entries: vector<TwinPoolEntry>,
    }

    public struct TwinPoolEntry has store {
        twin_id: ID,
        owner: address,
        scout_ref: String,    // public Walrus scout profile blob ref
        joined_at_epoch: u64,
    }

    // ─── Events ───────────────────────────────────────────────────────────────

    public struct TwinRegistered has copy, drop {
        twin_id: ID,
        owner: address,
    }

    public struct ScoutRefUpdated has copy, drop {
        owner: address,
        new_scout_ref: String,
    }

    public struct PoolEntryRemoved has copy, drop {
        owner: address,
        twin_id: ID,
    }

    // ─── Init ─────────────────────────────────────────────────────────────────

    fun init(ctx: &mut TxContext) {
        let pool = TwinPool {
            id: object::new(ctx),
            entries: vector[],
        };
        transfer::share_object(pool);
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    fun add_pool_entry(
        pool: &mut TwinPool,
        twin_id: ID,
        owner: address,
        scout_ref: String,
        ctx: &TxContext,
    ) {
        vector::push_back(
            &mut pool.entries,
            TwinPoolEntry {
                twin_id,
                owner,
                scout_ref,
                joined_at_epoch: ctx.epoch(),
            },
        );

        event::emit(TwinRegistered {
            twin_id,
            owner,
        });
    }

    // ─── Entry Functions ──────────────────────────────────────────────────────

    /// Mint a DigitalTwin and immediately register it in the pool.
    /// Called during first-time profile setup.
    public entry fun mint_agent_and_register(
        pool: &mut TwinPool,
        private_ref: String,
        scout_ref: String,
        ctx: &mut TxContext,
    ) {
        let sender = ctx.sender();

        let agent = DigitalTwin {
            id: object::new(ctx),
            owner: sender,
            vector_ref: private_ref,
            is_active: true,
        };

        let twin_id = object::id(&agent);
        add_pool_entry(pool, twin_id, sender, scout_ref, ctx);
        transfer::public_transfer(agent, sender);
    }

    /// Mint a standalone DigitalTwin without registering in the pool.
    public entry fun mint_agent(vector_ref: String, ctx: &mut TxContext) {
        let sender = ctx.sender();
        let agent = DigitalTwin {
            id: object::new(ctx),
            owner: sender,
            vector_ref,
            is_active: true,
        };
        transfer::public_transfer(agent, sender);
    }

    /// Re-register an existing twin into the pool.
    /// Used when the Walrus scout blob has expired and been re-uploaded.
    public entry fun register_existing_agent(
        pool: &mut TwinPool,
        agent: &DigitalTwin,
        scout_ref: String,
        ctx: &TxContext,
    ) {
        assert!(agent.owner == ctx.sender(), ENotOwner);
        assert!(agent.is_active, EAgentInactive);

        add_pool_entry(
            pool,
            object::id(agent),
            agent.owner,
            scout_ref,
            ctx,
        );
    }

    /// Update the scout_ref on ALL pool entries belonging to the sender.
    /// Called after re-uploading a trained scout capsule to Walrus.
    /// Covers edge case where owner has multiple entries (e.g. Abhay's duplicate).
public entry fun update_scout_ref(
    pool: &mut TwinPool,
    new_scout_ref: String,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    let entries = &mut pool.entries;
    let len = vector::length(entries);
    let mut i = 0;
    let mut found = false;

    while (i < len) {
        let entry = vector::borrow_mut(entries, i);
        if (entry.owner == sender) {
            entry.scout_ref = new_scout_ref;
            found = true;
        };
        i = i + 1;
    };

    assert!(found, EEntryNotFound);

    event::emit(ScoutRefUpdated {
        owner: sender,
        new_scout_ref,
    });
}

    /// Remove the FIRST pool entry belonging to the sender.
    /// Used to clean up stale/duplicate pool entries (e.g. expired blob entries).
    /// Call multiple times to remove multiple stale entries one by one.
public entry fun remove_pool_entry(
    pool: &mut TwinPool,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    let entries = &mut pool.entries;
    let len = vector::length(entries);
    let mut i = 0;

    while (i < len) {
        let entry = vector::borrow(entries, i);
        if (entry.owner == sender) {
            let removed = vector::remove(entries, i);
            let TwinPoolEntry { twin_id, owner: _, scout_ref: _, joined_at_epoch: _ } = removed;

            event::emit(PoolEntryRemoved {
                owner: sender,
                twin_id,
            });

            return
        };
        i = i + 1;
    };

    abort EEntryNotFound
}

    /// Update the private vector ref on the DigitalTwin object itself.
    /// Called when re-training produces a new private Walrus blob.
    public entry fun update_vector(
        agent: &mut DigitalTwin,
        new_ref: String,
        ctx: &mut TxContext,
    ) {
        assert!(agent.owner == ctx.sender(), ENotOwner);
        agent.vector_ref = new_ref;
    }

    /// Deactivate a twin. Prevents it from being re-registered in the pool.
    public entry fun deactivate_agent(
        agent: &mut DigitalTwin,
        ctx: &mut TxContext,
    ) {
        assert!(agent.owner == ctx.sender(), ENotOwner);
        agent.is_active = false;
    }
}
