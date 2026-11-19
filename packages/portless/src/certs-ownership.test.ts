import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSNICallback, ensureCerts } from "./certs.js";
import { fixOwnership } from "./utils.js";

vi.mock("./utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils.js")>();
  return {
    ...actual,
    fixOwnership: vi.fn(),
  };
});

describe("CA serial ownership", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "portless-ca-srl-test-"));
    vi.mocked(fixOwnership).mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hands ca.srl to fixOwnership when generating the server certificate", () => {
    ensureCerts(tmpDir);

    expect(fixOwnership).toHaveBeenCalledWith(path.join(tmpDir, "ca.srl"));
  });

  it("hands ca.srl to fixOwnership when generating a host certificate", async () => {
    const certs = ensureCerts(tmpDir);
    vi.mocked(fixOwnership).mockClear();

    const sniCallback = createSNICallback(
      tmpDir,
      fs.readFileSync(certs.certPath),
      fs.readFileSync(certs.keyPath)
    );
    await new Promise<void>((resolve, reject) => {
      sniCallback("app.localhost", (err) => (err ? reject(err) : resolve()));
    });

    expect(fixOwnership).toHaveBeenCalledWith(path.join(tmpDir, "ca.srl"));
  });
});
