export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images: string[];
  timestamp: number;
  error?: boolean;
  // Author of the message: for user — a persona (users/<id>), for assistant —
  // a character (characters/<id>). Messages keep their author at send time,
  // so switching active chat participants does not rewrite history.
  characterId?: string;
  userId?: string;
  // Prompts the message's images were generated with (file name -> prompt);
  // filled in when the model inserted an [IMG:...] tag in its reply.
  imagePrompts?: Record<string, string>;
  // References of each generated image (file name -> names in the chat files/).
  imageRefs?: Record<string, string[]>;
  // Generation status of the message's images (file name -> status). Only the
  // images that are still being generated ("pending") or whose generation
  // failed ("failed") or was cancelled ("cancelled") are listed — a name that
  // is absent from the map is a ready image. The generation runs in the
  // background: the reply is saved with the reserved file names BEFORE the
  // files exist.
  imageStatus?: Record<string, 'pending' | 'failed' | 'cancelled'>;
  // The reason a generated image is "failed" (file name -> error text) —
  // shown on the broken-image placeholder.
  imageErrors?: Record<string, string>;
};
