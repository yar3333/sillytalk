// A person (the persona card) is a row of the `persons` table in the catalogs
// database (name + persona description), keyed by the id that is also the name
// of its folder under users/ (the home of its avatar).
export type Person = {
  id: string;
  name: string;
  // The whole card, the appearance included: the picture planner reads the
  // visual line out of it, because the generator has never heard the name.
  description: string;
};
