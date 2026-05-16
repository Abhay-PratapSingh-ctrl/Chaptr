module chaptr::agent {
    use std::string::String;
    use sui::object::UID;
    use sui::transfer;
    use sui::tx_context::TxContext;

    public struct DigitalTwin has key, store {
        id: UID,
        owner: address,
        vector_ref: String,
        is_active: bool,
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

    public entry fun deactivate_agent(agent: &mut DigitalTwin, ctx: &mut TxContext) {
        assert!(agent.owner == ctx.sender(), 0);
        agent.is_active = false;
    }

    public entry fun update_vector(agent: &mut DigitalTwin, new_ref: String, ctx: &mut TxContext) {
        assert!(agent.owner == ctx.sender(), 0);
        agent.vector_ref = new_ref;
    }
}