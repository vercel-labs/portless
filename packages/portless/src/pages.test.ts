import { describe, it, expect } from "vitest";
import { detectOS, renderCertPage } from "./pages.js";

describe("detectOS", () => {
  it("detects macOS from Safari User-Agent", () => {
    expect(
      detectOS(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
      )
    ).toBe("mac");
  });

  it("detects macOS from Chrome on Mac", () => {
    expect(
      detectOS(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      )
    ).toBe("mac");
  });

  it("detects Windows from Chrome User-Agent", () => {
    expect(
      detectOS(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      )
    ).toBe("windows");
  });

  it("detects Linux from Firefox User-Agent", () => {
    expect(detectOS("Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0")).toBe(
      "linux"
    );
  });

  it("detects iPhone as mac", () => {
    expect(
      detectOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")
    ).toBe("mac");
  });

  it("detects Android as linux", () => {
    expect(
      detectOS(
        "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36"
      )
    ).toBe("linux");
  });

  it("returns unknown for empty string", () => {
    expect(detectOS("")).toBe("unknown");
  });

  it("returns unknown for unrecognized User-Agent", () => {
    expect(detectOS("curl/8.1.2")).toBe("unknown");
  });

  it("detects macOS from a User-Agent containing 'darwin' (not confused by 'win' substring)", () => {
    expect(detectOS("SomeClient/darwin/23.0")).toBe("mac");
  });

  it("still detects Windows from win32 and win64", () => {
    expect(detectOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(detectOS("Mozilla/5.0 (Windows NT 10.0; Win32; x86)")).toBe("windows");
  });
});

describe("renderCertPage", () => {
  it("renders HTML with download link", () => {
    const html = renderCertPage("mac");
    expect(html).toContain('<a class="download-btn" href="/download">Download Certificate</a>');
  });

  it("includes macOS instructions when mac is detected", () => {
    const html = renderCertPage("mac");
    expect(html).toContain("Keychain Access");
    expect(html).toContain("security add-trusted-cert");
  });

  it("includes Windows instructions when windows is detected", () => {
    const html = renderCertPage("windows");
    expect(html).toContain("Install Certificate");
    expect(html).toContain("certutil");
  });

  it("includes Linux instructions when linux is detected", () => {
    const html = renderCertPage("linux");
    expect(html).toContain("update-ca-certificates");
    expect(html).toContain("update-ca-trust");
  });

  it("places detected OS tab first", () => {
    const html = renderCertPage("windows");
    const firstTabIdx = html.indexOf('class="os-tab active"');
    const windowsTabIdx = html.indexOf('data-os="windows"');
    const macTabIdx = html.indexOf('data-os="mac"');
    expect(firstTabIdx).toBeGreaterThan(-1);
    expect(windowsTabIdx).toBeLessThan(macTabIdx);
  });

  it("defaults to macOS first when OS is unknown", () => {
    const html = renderCertPage("unknown");
    const macTabIdx = html.indexOf('data-os="mac"');
    const windowsTabIdx = html.indexOf('data-os="windows"');
    expect(macTabIdx).toBeLessThan(windowsTabIdx);
    expect(html).not.toContain("Detected OS");
  });

  it("includes SSH hint", () => {
    const html = renderCertPage("mac");
    expect(html).toContain("portless cert");
    expect(html).toContain("ssh");
  });

  it("includes tab-switching JavaScript", () => {
    const html = renderCertPage("mac");
    expect(html).toContain("os-tab");
    expect(html).toContain("addEventListener");
  });

  it("contains all three OS panels regardless of detected OS", () => {
    const html = renderCertPage("mac");
    expect(html).toContain('data-os="mac"');
    expect(html).toContain('data-os="windows"');
    expect(html).toContain('data-os="linux"');
  });
});
