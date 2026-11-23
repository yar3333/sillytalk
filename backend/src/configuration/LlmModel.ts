import { ModelSampling } from "./Sampling";

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
  // Reasoning level: a string — the level (one of reasoningLevels), sent as
  // reasoning_effort (OpenAI / llama.cpp) and reasoning.effort (OpenRouter);
  // false/absent — off, sent as chat_template_kwargs.enable_thinking=false
  // (the reliable cross-backend switch for a default-on model, e.g. Qwen).
  reasoning?: string | false;
  // The possible reasoning levels; absent — the default set
  // (low, medium, high, xhigh, max).
  reasoningLevels?: string[];
  // How this model is to pick its next token (see configuration/Sampling.ts).
  // A field left out is not sent, so the provider keeps its own default — which
  // is why the dialog shows every one of them empty rather than a guessed
  // number. It belongs to the model and not to a chat: whichever model a call
  // actually resolves to (the chat model, the one that sees pictures, the one
  // that plans them) carries its own block into that call.
  sampling?: ModelSampling;
};
