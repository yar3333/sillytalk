export type Character = {
  id: string;
  name: string;
  // The whole card, the appearance included: the picture planner reads the
  // visual line out of it, because the generator has never heard the name.
  description: string;
};
