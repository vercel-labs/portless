import { describe, expect, test, vi } from "vitest";

const fsMock = vi.hoisted(() => ({ readFile: vi.fn() }));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  fsMock.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: fsMock.readFile };
});

describe("docs source cache", () => {
  test("retries after a transient read failure", async () => {
    const failure = new Error("transient read failure");
    fsMock.readFile.mockRejectedValueOnce(failure);
    const { loadDocsSource } = await import("./docs-source");

    await expect(loadDocsSource("/why")).rejects.toBe(failure);
    await expect(loadDocsSource("/why")).resolves.toMatchObject({ href: "/why" });
    expect(fsMock.readFile).toHaveBeenCalledTimes(2);
  });
});
