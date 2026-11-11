// What a picture remembers about being drawn: the prompt it was drawn with and
// the images it was drawn from. This is a VIEW of the picture's row of the
// global images table (images/ImageMetaService.ts) — the row is the only copy,
// a chat line never keeps generation data of its own.
export type ImageGenerationData = {
  prompt?: string;
  // Reference images — identifiers, i.e. paths relative to the data folder.
  refs?: string[];
  negativePrompt?: string;
  // upload — somebody brought the file; manual — a picture that was ASKED FOR
  // in words (the 🎨 dialog, a character's [IMAGE_BY_PROMPT]); auto — a picture
  // the app drew on its own (the 📷 picture of the turn).
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
//   "text"  — a line of the dialogue (the default when the field is absent). It
//             carries the author's words and, when the author shows pictures,
//             those pictures too: they are part of the line, rendered right
//             under the words.
//   "image" — the NEUTRAL picture card: a message that is nothing but one
//             picture and belongs to nobody. Only the two controls that hand a
//             picture to the CONVERSATION make one (the 🖼 disk pick and the 📷
//             picture of the turn), and their files live in the chat's own
//             folder — which is what the id of the picture says out loud.
export type MessageKind = "text" | "image";

// What the app knows about ONE picture of a message: its caption, what it was
// drawn from, and who is on it. All of it is the picture's row of the global
// images table — the message only names the picture by its id, so a picture
// shown inside a line and a picture of a card are described by exactly one
// shape and one source.
export type PictureFacts = {
  // What is visible on the picture — the caption under it, the sentence a model
  // without vision is told in place of the picture.
  description?: string;
  // How it was made (absent for a file the user brought — an upload has no
  // prompt of its own).
  generation?: ImageGenerationData;
  // Who is ON the picture: the cast refs of the people visible in it
  // ("char:alice", "user:carol"). The next picture of the same person is drawn
  // from this one, which is what keeps a face the same from picture to picture;
  // an upload can carry it too (the user says who is in their photo).
  depicts?: string[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  kind?: MessageKind;
  // A line of the dialogue: the words themselves. On a neutral card it is that
  // picture's caption — the card has no words of its own, so the caption of its
  // row is what stands as its text.
  text: string;
  // Image identifiers — paths relative to the data folder
  // ("chats/<chatId>/a-sunset-3f2a1c.png"). Whose picture it is, is written in
  // the id itself: "characters/<id>/…" is a character's, "users/<id>/…" a
  // persona's, "chats/<id>/…" one the conversation owns. A line carries the
  // pictures its author shows (any number); a neutral card carries exactly one.
  images: string[];
  timestamp: number;
  error?: boolean;
  // Author of the message: for user — a persona (users/<id>), for assistant —
  // a character (characters/<id>). Messages keep their author at send time,
  // so switching active chat participants does not rewrite history. The neutral
  // card has no author, and that is the point: it is the conversation's own
  // picture, not something a person said.
  characterId?: string;
  userId?: string;
  // What is known about each picture of `images` (id -> its facts), filled from
  // the images table on every read and never stored in the message: the table
  // is the one place a picture's caption, prompt and cast are written.
  pictures?: Record<string, PictureFacts>;
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
