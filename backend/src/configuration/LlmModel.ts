// llmModels entry value: the provider connection. The object key is the
// model's name inside the app (displayed); the id field is the identifier
// sent to the provider in the request.
export type LlmModel = {
  id: string; // ID sent to the provider (the id field of the llmModels entry)
  baseUrl: string;
  apiKey?: string; // API key directly
  envKey?: string; // name of an env var holding the key (takes priority over apiKey)
  contextSize: number;
  supportsImages: boolean;
  // Reasoning level: false/absent — off (nothing is sent to the provider), a
  // string — the level (one of reasoningLevels), sent as reasoning_effort
  // (OpenAI / llama.cpp) and reasoning.effort (OpenRouter).
  reasoning?: string | false;
  // The possible reasoning levels; absent — the default set
  // (low, medium, high, xhigh, max).
  reasoningLevels?: string[];
};
