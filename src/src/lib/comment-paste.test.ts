import { describe, expect, it } from "vitest";
import {
  claimPastedFiles,
  extractPastedFiles,
  hasCommentContent,
  isEmptyCommentShell,
  isPasteClaimed,
} from "./comment-paste";

const fakeFile = (name: string) => ({ name }) as unknown as File;

function pasteEvent(items: { kind: string; file?: File | null }[] | null) {
  return {
    clipboardData:
      items === null
        ? null
        : { items: items.map((i) => ({ kind: i.kind, getAsFile: () => i.file ?? null })) },
  };
}

describe("extractPastedFiles", () => {
  it("returns nothing for a plain-text paste", () => {
    expect(extractPastedFiles(pasteEvent([{ kind: "string" }]))).toEqual([]);
  });

  it("returns nothing when there is no clipboard data at all", () => {
    expect(extractPastedFiles(pasteEvent(null))).toEqual([]);
  });

  it("returns every pasted file, ignoring text items in the same clipboard", () => {
    const a = fakeFile("a.png");
    const b = fakeFile("b.png");
    const files = extractPastedFiles(
      pasteEvent([{ kind: "string" }, { kind: "file", file: a }, { kind: "file", file: b }])
    );
    expect(files).toEqual([a, b]);
  });

  it("skips file items the browser can't materialize", () => {
    expect(extractPastedFiles(pasteEvent([{ kind: "file", file: null }]))).toEqual([]);
  });
});

describe("claimPastedFiles / isPasteClaimed", () => {
  it("claims a paste carrying an image, so the page-level fallback skips it", () => {
    const event = pasteEvent([{ kind: "file", file: fakeFile("image.png") }]);
    expect(isPasteClaimed(event)).toBe(false);
    expect(claimPastedFiles(event)).toHaveLength(1);
    expect(isPasteClaimed(event)).toBe(true);
  });

  it("never claims a text-only paste", () => {
    const event = pasteEvent([{ kind: "string" }]);
    expect(claimPastedFiles(event)).toEqual([]);
    expect(isPasteClaimed(event)).toBe(false);
  });

  it("leaves an unrelated paste (outside any comment) unclaimed — still a general attachment", () => {
    const inComment = pasteEvent([{ kind: "file", file: fakeFile("image.png") }]);
    const elsewhere = pasteEvent([{ kind: "file", file: fakeFile("image.png") }]);
    claimPastedFiles(inComment);
    expect(isPasteClaimed(elsewhere)).toBe(false);
  });
});

describe("hasCommentContent", () => {
  it("accepts text only", () => expect(hasCommentContent(false, 0)).toBe(true));
  it("accepts text + image", () => expect(hasCommentContent(false, 1)).toBe(true));
  it("accepts image only", () => expect(hasCommentContent(true, 1)).toBe(true));
  it("accepts several images with no text", () => expect(hasCommentContent(true, 3)).toBe(true));
  it("rejects a completely empty comment", () => expect(hasCommentContent(true, 0)).toBe(false));
});

describe("isEmptyCommentShell", () => {
  it("is true when an image-only comment lost every upload", () => {
    expect(isEmptyCommentShell(true, 2, 2)).toBe(true);
  });
  it("is false when at least one image made it", () => {
    expect(isEmptyCommentShell(true, 2, 1)).toBe(false);
  });
  it("is false when the comment still has text", () => {
    expect(isEmptyCommentShell(false, 1, 1)).toBe(false);
  });
  it("is false for a text-less comment with nothing attempted", () => {
    expect(isEmptyCommentShell(true, 0, 0)).toBe(false);
  });
});
