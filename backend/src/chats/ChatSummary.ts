import { Chat } from "./Chat";

// Summary for the chat list: lastMessageAt is computed on the fly from the
// last message (0 for an empty chat); createdAt/updatedAt are not stored.
export type ChatSummary = Omit<Chat, 'messages'> & {
  messageCount: number;
  lastMessageAt: number;
};
