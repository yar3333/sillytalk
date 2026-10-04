export type LocalProgramSettings = {
  command: string;
  args: string[];
  maxInputImages: number; // how many references the generator supports (0 = unlimited)
  enabled?: boolean; // generator toggle (default true) — a disabled one is never used
};
