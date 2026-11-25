export type SupportedPlatform = "darwin" | "linux" | "win32";

export const SUPPORTED_PLATFORMS: readonly SupportedPlatform[] = ["darwin", "linux", "win32"];

export type TrustCapability =
  | { supported: true }
  | { supported: false; reason: string; hint: string };

export type LanMdnsCapability =
  | { supported: true }
  | { supported: false; reason: string; hint?: string };

export type ServiceCapability = { supported: true } | { supported: false; reason: string };

export type PlatformCapabilities = {
  platform: NodeJS.Platform;
  supported: boolean;
  trust: TrustCapability;
  lanMdns: LanMdnsCapability;
  service: ServiceCapability;
};

type PlatformEntry = Omit<PlatformCapabilities, "platform">;

const CAPABILITIES: Partial<Record<NodeJS.Platform, PlatformEntry>> = {
  darwin: {
    supported: true,
    trust: { supported: true },
    lanMdns: { supported: true },
    service: { supported: true },
  },
  linux: {
    supported: true,
    trust: { supported: true },
    lanMdns: { supported: true },
    service: { supported: true },
  },
  win32: {
    supported: true,
    trust: { supported: true },
    lanMdns: {
      supported: false,
      reason: "LAN mode (.local mDNS publishing) is not supported on Windows.",
      hint: "Use --tailscale, --ngrok, or --cloudflare to share apps from Windows.",
    },
    service: { supported: true },
  },
};

/** Return the platform capability table entry for the given Node.js platform. */
export function getPlatformCapabilities(
  platform: NodeJS.Platform = process.platform
): PlatformCapabilities {
  const entry = CAPABILITIES[platform];
  if (entry) return { platform, ...entry };

  return {
    platform,
    supported: false,
    trust: {
      supported: false,
      reason: `Automatic CA trust is not supported on ${platform}.`,
      hint: "Supported platforms are macOS, Linux, and Windows. Use --no-tls for plain HTTP or import ca.pem into your OS trust store manually.",
    },
    lanMdns: {
      supported: false,
      reason: `mDNS publishing is not supported on ${platform}.`,
    },
    service: {
      supported: false,
      reason: `Startup service installation is not supported on ${platform}.`,
    },
  };
}
