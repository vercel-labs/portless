import { describe, it, expect } from "vitest";
import { escapeHtml, formatUrl, isErrnoException, parseHostname } from "./utils.js";

describe("escapeHtml", () => {
  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("escapes quotes", () => {
    expect(escapeHtml("\"hello\" & 'world'")).toBe("&quot;hello&quot; &amp; &#39;world&#39;");
  });

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("leaves safe text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("isErrnoException", () => {
  it("returns true for a Node.js system error", () => {
    const err = new Error("fail") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    expect(isErrnoException(err)).toBe(true);
  });

  it("returns false for a plain Error without code", () => {
    expect(isErrnoException(new Error("plain"))).toBe(false);
  });

  it("returns false for a string", () => {
    expect(isErrnoException("something")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isErrnoException(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isErrnoException(undefined)).toBe(false);
  });

  it("returns false for a plain object with code", () => {
    expect(isErrnoException({ code: "ENOENT", message: "fail" })).toBe(false);
  });

  it("returns false for an Error with a non-string code", () => {
    const err = new Error("fail");
    (err as unknown as Record<string, unknown>).code = 42;
    expect(isErrnoException(err)).toBe(false);
  });
});

describe("formatUrl", () => {
  it("omits port for standard HTTP port (80)", () => {
    expect(formatUrl("myapp.localhost", 80)).toBe("http://myapp.localhost");
  });

  it("includes port for non-standard ports", () => {
    expect(formatUrl("myapp.localhost", 1355)).toBe("http://myapp.localhost:1355");
    expect(formatUrl("myapp.localhost", 8080)).toBe("http://myapp.localhost:8080");
    expect(formatUrl("myapp.localhost", 3000)).toBe("http://myapp.localhost:3000");
  });
});

describe("parseHostname", () => {
  it("appends .localhost to simple name", () => {
    expect(parseHostname("myapp")).toBe("myapp.localhost");
  });

  it("preserves existing .localhost suffix", () => {
    expect(parseHostname("myapp.localhost")).toBe("myapp.localhost");
  });

  it("strips http:// protocol", () => {
    expect(parseHostname("http://myapp")).toBe("myapp.localhost");
  });

  it("strips https:// protocol", () => {
    expect(parseHostname("https://myapp")).toBe("myapp.localhost");
  });

  it("strips path after hostname", () => {
    expect(parseHostname("myapp/some/path")).toBe("myapp.localhost");
  });

  it("strips protocol and path", () => {
    expect(parseHostname("http://myapp.localhost/path")).toBe("myapp.localhost");
  });

  it("converts to lowercase", () => {
    expect(parseHostname("MyApp")).toBe("myapp.localhost");
  });

  it("handles subdomain-style names", () => {
    expect(parseHostname("api.myapp")).toBe("api.myapp.localhost");
  });

  it("handles hyphens", () => {
    expect(parseHostname("my-app")).toBe("my-app.localhost");
  });

  it("throws on empty input", () => {
    expect(() => parseHostname("")).toThrow("Hostname cannot be empty");
  });

  it("throws on whitespace-only input", () => {
    expect(() => parseHostname("   ")).toThrow("Hostname cannot be empty");
  });

  it("throws on invalid characters", () => {
    expect(() => parseHostname("my app")).toThrow("Invalid hostname");
  });

  it("throws on hostname starting with hyphen", () => {
    expect(() => parseHostname("-myapp")).toThrow("Invalid hostname");
  });

  it("throws on hostname ending with hyphen", () => {
    expect(() => parseHostname("myapp-")).toThrow("Invalid hostname");
  });

  it("throws on special characters", () => {
    expect(() => parseHostname("my@app")).toThrow("Invalid hostname");
  });

  it("throws on consecutive dots", () => {
    expect(() => parseHostname("my..app")).toThrow("consecutive dots are not allowed");
  });

  it("accepts numeric hostnames", () => {
    expect(parseHostname("123")).toBe("123.localhost");
  });

  it("handles protocol with .localhost already present", () => {
    expect(parseHostname("https://test.localhost")).toBe("test.localhost");
  });

  it("throws on label exceeding 63 characters", () => {
    const longLabel = "a".repeat(64);
    expect(() => parseHostname(longLabel)).toThrow("exceeds 63-character DNS limit");
  });

  it("accepts label at exactly 63 characters", () => {
    const label63 = "a".repeat(63);
    expect(parseHostname(label63)).toBe(`${label63}.localhost`);
  });

  it("throws when any label in multi-part hostname exceeds 63 characters", () => {
    const longLabel = "a".repeat(64);
    expect(() => parseHostname(`prefix.${longLabel}`)).toThrow("exceeds 63-character DNS limit");
  });

  describe("custom TLD", () => {
    it("appends custom TLD suffix", () => {
      expect(parseHostname("myapp", "test")).toBe("myapp.test");
    });

    it("preserves existing custom TLD suffix", () => {
      expect(parseHostname("myapp.test", "test")).toBe("myapp.test");
    });

    it("strips .localhost suffix when using a different TLD", () => {
      expect(parseHostname("myapp.localhost", "test")).toBe("myapp.test");
    });

    it("strips .localhost subdomain suffix when using a different TLD", () => {
      expect(parseHostname("api.myapp.localhost", "test")).toBe("api.myapp.test");
    });

    it("handles subdomain with custom TLD", () => {
      expect(parseHostname("api.myapp", "test")).toBe("api.myapp.test");
    });

    it("throws on empty input with custom TLD", () => {
      expect(() => parseHostname("", "test")).toThrow("Hostname cannot be empty");
    });

    it("throws on bare TLD suffix", () => {
      expect(() => parseHostname(".test", "test")).toThrow("Hostname cannot be empty");
    });

    it("validates characters with custom TLD", () => {
      expect(() => parseHostname("my app", "test")).toThrow("Invalid hostname");
    });

    it("works with dev TLD", () => {
      expect(parseHostname("myapp", "dev")).toBe("myapp.dev");
    });
  });
});
