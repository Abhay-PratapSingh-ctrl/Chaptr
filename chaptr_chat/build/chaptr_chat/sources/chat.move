module chaptr_chat::chat {
    use std::string::String;

    public struct MessageSent has copy, drop {
        match_id: address,
        sender: address,
        blob_id: String,
        sent_at: u64,
    }

    public entry fun send_message(
        match_id: address,
        blob_id: String,
        ctx: &mut TxContext,
    ) {
        sui::event::emit(MessageSent {
            match_id,
            sender: ctx.sender(),
            blob_id,
            sent_at: ctx.epoch(),
        });
    }
}
