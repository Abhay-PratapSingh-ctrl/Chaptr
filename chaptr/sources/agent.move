module chaptr::agent {
    use std::string::String;
    use std::vector;
    use sui::event;
    use sui::object::{ID, UID};
    use sui::transfer;
    use sui::tx_context::TxContext;

    public struct DigitalTwin has key, store {
        id: UID,
        owner: address,
        vector_ref: String,
        is_active: bool,
    }
    const EAgentInactive: u64 = 1;

public struct TwinPool has key {
    id: UID,
    entries: vector<TwinPoolEntry>,
}

public struct TwinPoolEntry has store {
    twin_id: ID,
    owner: address,
    scout_ref: String,
    joined_at_epoch: u64,
}

public struct TwinRegistered has copy, drop {
    twin_id: ID,
    owner: address,
}

fun init(ctx: &mut TxContext) {
    let pool = TwinPool {
        id: object::new(ctx),
        entries: vector::empty<TwinPoolEntry>(),
    };

    transfer::share_object(pool);
}

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

    add_pool_entry(
        pool,
        twin_id,
        sender,
        scout_ref,
        ctx,
    );

    transfer::public_transfer(agent, sender);
}

public entry fun register_existing_agent(
    pool: &mut TwinPool,
    agent: &DigitalTwin,
    scout_ref: String,
    ctx: &TxContext,
) {
    assert!(agent.owner == ctx.sender(), 0);
    assert!(agent.is_active, EAgentInactive);

    add_pool_entry(
        pool,
        object::id(agent),
        agent.owner,
        scout_ref,
        ctx,
    );
}

    public entry fun deactivate_agent(agent: &mut DigitalTwin, ctx: &mut TxContext) {
        assert!(agent.owner == ctx.sender(), 0);
        agent.is_active = false;
    }

    public entry fun update_vector(agent: &mut DigitalTwin, new_ref: String, ctx: &mut TxContext) {
        assert!(agent.owner == ctx.sender(), 0);
        agent.vector_ref = new_ref;
    }
}