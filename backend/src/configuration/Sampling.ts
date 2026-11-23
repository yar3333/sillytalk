// The sampling block of ONE llm model — how the provider picks the next token
// when this model talks. It belongs to the model, not to a chat: a model is
// served with a set of parameters its own weights were tuned for, and the same
// temperature that reads well on one checkpoint is slop on another.
//
// Every field is optional and an absent field is NOT SENT AT ALL, so the
// provider applies its own default. That is the state the dialog shows as an
// empty field, and it is the right answer more often than a value copied from
// somebody else's setup.
export type ModelSampling = {
  // How flat the probability distribution is made before a word is drawn from
  // it. 1 leaves the model's own confidence alone; below it the likely word
  // wins almost every time (safe, predictable), above it rare words get their
  // chance (varied, and incoherent sooner).
  temperature?: number;
  // Nucleus sampling: the most likely words are kept until their combined
  // probability reaches this value, everything below is cut. 1 keeps whatever
  // temperature allows.
  topP?: number;
  // How many best candidate words survive at each step, cut by count rather
  // than by probability. 0/absent — no limit on the providers that read it.
  topK?: number;
  // Cuts a word whose probability is below this FRACTION of the best word's.
  // Unlike top-p it scales with the top candidate, so a high temperature cannot
  // drag the tail of the distribution in.
  minP?: number;
  // Raises the cost of a word the model already used, against echoing itself.
  // 1 = no penalty. llama.cpp / vLLM / Aphrodite / OpenRouter read this one.
  repetitionPenalty?: number;
};
