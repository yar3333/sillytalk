// How an image message stores its generation data: the prompt the picture was
// drawn with and the images it was drawn from. The same block is mirrored into
// the sidecar *.json next to the file (see ImageMetaFile) — the sidecar is the
// portable, hand-editable copy, the message the fast index the UI reads.
export type ImageGenerationData = {
  prompt?: string;
  // Reference images — identifiers, i.e. paths relative to the data folder.
  refs?: string[];
  negativePrompt?: string;
  // upload — the user attached the file; manual — the user asked for a draw
  // (the 🎨 mode); auto — drawn for the user's turn from the dialogue.
  source?: "upload" | "manual" | "auto";
  // The generator that produced it and the model that wrote the prompt.
  generator?: string;
  model?: string;
  width?: number;
  height?: number;
  steps?: number;
  createdAt?: string;
};

// The two kinds of a chat line.
//   "text"  — a line of the dialogue (the default when the field is absent).
//   "image" — an image card: one picture with its own description and
//             generation data. The user attaches one with 📎 (the text they
//             typed goes into the text message right before it), draws one in
//             the 🎨 mode, or asks for one on their turn. A character never
//             produces one.
export type MessageKind = "text" | "image";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  kind?: MessageKind;
  // A text message: the line itself. An image card: the optional description
  // of what is on the picture (its caption) — empty when there is none.
  text: string;
  // Image identifiers — paths relative to the data folder
  // ("chats/<chatId>/files/a-sunset-3f2a1c.png"). An image card holds exactly
  // one; a text message holds none (a picture is always its own card).
  images: string[];
  timestamp: number;
  error?: boolean;
  // Author of the message: for user — a persona (users/<id>), for assistant —
  // a character (characters/<id>). Messages keep their author at send time,
  // so switching active chat participants does not rewrite history. An image
  // card with no author is the user's own picture with no persona attached.
  characterId?: string;
  userId?: string;
  // The image card's generation data (absent on a card whose image the user
  // uploaded — an upload has no prompt of its own).
  generation?: ImageGenerationData;
  // Who is ON the picture: the cast refs of the people visible in it
  // ("char:alice", "user:carol"). The next picture of the same person is drawn
  // from this one, which is what keeps a face the same from picture to picture;
  // an upload can carry it too (the user says who is in their photo).
  depicts?: string[];
  // Generation status of the message's images (id -> status). Only the images
  // that are still being generated ("pending") or whose generation failed
  // ("failed") or was cancelled ("cancelled") are listed — an id that is
  // absent from the map is a ready image. The generation runs in the
  // background: the card is saved with its reserved id BEFORE the file exists.
  imageStatus?: Record<string, "pending" | "failed" | "cancelled">;
  // The reason a generated image is "failed" (id -> error text) — shown on the
  // broken-image placeholder.
  imageErrors?: Record<string, string>;
};

// The kind of a message. A message without the field is a text line — the
// field is optional so an ordinary reply stays small in the database.
export function messageKind(message: ChatMessage): MessageKind {
  return message.kind === "image" ? "image" : "text";
}

// Whether this line is an image card.
export function isImageMessage(message: ChatMessage): boolean {
  return messageKind(message) === "image";
}
