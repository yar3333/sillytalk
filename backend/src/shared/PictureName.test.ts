import { PictureName } from "./PictureName";

// The name of a picture file is read in a chat card, in a picture id and in a
// folder listing, so it has to stay short, readable and free of what a file name
// cannot hold — the same shape for a chat's, a character's and a persona's
// pictures, which is why one helper owns it.

describe("slug", () => {
  it("keeps 2–5 english words", () => {
    expect(PictureName.slug("A red fox sitting on a snowy fence")).toBe("a-red-fox-sitting-on");
  });

  it("transliterates cyrillic", () => {
    expect(PictureName.slug("рыжая лиса в снегу")).toBe("ryzhaya-lisa-v-snegu");
  });

  it("falls back when nothing of the hint survives", () => {
    expect(PictureName.slug("!!! ??? —")).toBe("image");
    expect(PictureName.slug("")).toBe("image");
    expect(PictureName.slug("   ", "photo")).toBe("photo");
  });

  it("never lets one long word run past the limit", () => {
    expect(PictureName.slug("supercalifragilisticexpialidociously").length).toBeLessThanOrEqual(48);
  });

  it("strips what a file name cannot carry", () => {
    expect(PictureName.slug("a/b:c*?\"<>|")).toBe("a-b-c");
  });
});

describe("fileName", () => {
  it("is the slug, a unique suffix and the extension", () => {
    expect(PictureName.fileName("A red boat at dusk")).toMatch(/^a-red-boat-at-dusk-[0-9a-f]{6}\.png$/);
  });

  it("keeps the extension of the picture it names", () => {
    expect(PictureName.fileName("photo", "photo", ".jpg")).toMatch(/^photo-[0-9a-f]{6}\.jpg$/);
  });

  it("never names the same file twice", () => {
    expect(PictureName.fileName("a boat")).not.toBe(PictureName.fileName("a boat"));
  });

  it("is one path segment whatever the hint says", () => {
    // A hint arrives from a model's plan or from a file the user picked: slashes
    // and dots in it must not turn the name into a path or a hidden file.
    const name = PictureName.fileName("../../etc/passwd");
    expect(name).not.toContain("/");
    expect(name.startsWith(".")).toBe(false);
    expect(name.endsWith(".png")).toBe(true);
  });
});
