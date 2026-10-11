export type Character = {
  id: string;
  name: string;
  description: string;
  // When true, the character may also reference the photos of the OTHER
  // characters in the chat and the active persona's photo (for [IMG:...|N]
  // references and [PHOTO:N] as-is sending). Defaults to false.
  accessAllImages?: boolean;
};
