import { Chat } from "./Chat";

// Summary for the chat list: lastMessageAt is computed on the fly from the
// last message (0 for an empty chat); updatedAt is not stored (the name and
// createdAt are — they are what a chat row carries).
export type ChatSummary = Omit<Chat, 'messages'> & {
  messageCount: number;
  lastMessageAt: number;
};
