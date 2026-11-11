import { randomUUID } from "crypto";

// The file name of a picture the app is about to write. A picture is addressed
// by its id — the path relative to the data root — so the file name is the only
// part of that id a human ever reads, both in the picture browser and in a file
// listing. It is therefore made of the leading words of what the picture shows
// plus a short random suffix that keeps two pictures of one subject two files.
//
// Every folder a picture can live in (a chat's, a character's, a persona's)
// builds its name through this helper, so a picture in characters/alice/ reads
// the same way as one in chats/2026-…/.
//
// Stateless, so a class of statics (there is nothing to inject).
export class PictureName {
  // A file-name-safe English slug of up to five words: the leading words of the
  // prompt or name with everything that is not a letter or a digit dropped,
  // transliterated out of Cyrillic (a generation prompt reaches here already
  // translated, but a hand-named picture may not) and joined with "-".
  // Empty input falls back to `fallback`.
  static slug(text: string, fallback = "image"): string {
    const cyrillic: Record<string, string> = {
      а: "a",
      б: "b",
      в: "v",
      г: "g",
      д: "d",
      е: "e",
      ё: "e",
      ж: "zh",
      з: "z",
      и: "i",
      й: "y",
      к: "k",
      л: "l",
      м: "m",
      н: "n",
      о: "o",
      п: "p",
      р: "r",
      с: "s",
      т: "t",
      у: "u",
      ф: "f",
      х: "h",
      ц: "c",
      ч: "ch",
      ш: "sh",
      щ: "sch",
      ъ: "",
      ы: "y",
      ь: "",
      э: "e",
      ю: "yu",
      я: "ya",
    };
    const latin = [...text.toLowerCase()].map((ch) => (ch in cyrillic ? cyrillic[ch] : ch)).join("");
    const slug = latin
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0)
      .slice(0, 5)
      .join("-")
      .slice(0, 48)
      .replace(/^-+|-+$/g, "");
    return slug || (fallback && fallback !== text ? PictureName.slug(fallback, "image") : "") || "image";
  }

  // The unique file name for a new picture: the slug of the hint, a 6-hex suffix
  // so two pictures of the same subject never share a file, and the extension
  // (with the dot). `fallback` is what a hint with no usable word becomes.
  static fileName(nameHint: string, fallback = "image", extension = ".png"): string {
    return `${PictureName.slug(nameHint, fallback)}-${randomUUID().slice(0, 6)}${extension}`;
  }
}
