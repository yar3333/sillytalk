// A person (the persona card) is a users/<id>/ folder with user.json
// (name + persona description).
export type Person = {
  id: string;
  name: string;
  // The whole card, the appearance included: the picture planner reads the
  // visual line out of it, because the generator has never heard the name.
  description: string;
};
