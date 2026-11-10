// The languages a picture's DESCRIPTION can be written in. The code is what the
// config stores; the name is what a model is told — an instruction reads "in
// Russian", never "in ru", and a model that is asked for a language tag may
// answer with the tag itself.
//
// This is a setting of the CAPTIONS only: the generation prompt is always
// English, because the generators (and the workflows behind them) were built
// around English prompts.
export interface PictureLanguage {
  code: string;
  name: string;
}

export const PICTURE_LANGUAGES: PictureLanguage[] = [
  { code: "en", name: "English" },
  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "de", name: "German" },
  { code: "fr", name: "French" },
  { code: "es", name: "Spanish" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "pl", name: "Polish" },
  { code: "tr", name: "Turkish" },
  { code: "zh", name: "Chinese" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
];

// What the app wrote before the setting existed — the language of a config
// without one.
export const DEFAULT_PICTURE_LANGUAGE = "en";

// The code a config value stands for: a known code (lower-cased), else
// undefined — a language the app cannot name is not a language it can ask for,
// so the field is dropped and the descriptions stay English.
export function normalizePictureLanguage(value: unknown): string | undefined {
  const code = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PICTURE_LANGUAGES.some((l) => l.code === code) ? code : undefined;
}

// What the model is told to write in. An absent or unknown code is English.
export function pictureLanguageName(code: string | undefined): string {
  const wanted = normalizePictureLanguage(code) ?? DEFAULT_PICTURE_LANGUAGE;
  return PICTURE_LANGUAGES.find((l) => l.code === wanted)!.name;
}
