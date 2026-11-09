// A character is a row of the `characters` table in the catalogs database,
// keyed by the id that is also the name of its folder under characters/ (the
// home of its photos/ set and its avatar).
export type Character = {
  id: string;
  name: string;
  // The whole card, the appearance included: the picture planner reads the
  // visual line out of it, because the generator has never heard the name.
  description: string;
};
