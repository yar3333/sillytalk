export type Character = {
  id: string;
  name: string;
  description: string;
  // How this character looks, in English — the visual half of the card, written
  // for an image generator (face, hair, build, clothing). The picture planner
  // puts it in every prompt, because the generator has never heard the name;
  // absent — the planner has only the description and the photos to go by.
  look?: string;
};
