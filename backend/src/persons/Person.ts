// A person (the persona card) is a users/<id>/ folder with user.json
// (name + persona description).
export type Person = {
  id: string;
  name: string;
  description: string;
  // How this persona looks, in English, written for an image generator (the
  // picture planner puts it in every prompt — the generator has never heard the
  // name). Absent — the planner has only the description and the avatar.
  look?: string;
};
