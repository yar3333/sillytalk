// A person (the persona card) is a users/<id>/ folder with user.json
// (name + persona description).
export type Person = {
  id: string;
  name: string;
  description: string;
};
