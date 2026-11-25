export type SupportedPlatform = "darwin" | "linux" | "win32";

export const SUPPORTED_PLATFORMS: readonly SupportedPlatform[] = ["darwin", "linux", "win32"];

export type MdnsPublisherSpec = {
  command: string;
  probeArgs: string[];
  missingReason: string;
  buildArgs: (fqdn: string, name: string, port: number, ip: string) => string[];
};

export type TrustCapability =
  | { supported: true; method: "macos-keychain" | "linux-ca-store" | "windows-certutil" }
  | { supported: false; reason: string; hint: string };

export type LanMdnsCapability =
  | { supported: true; publisher: MdnsPublisherSpec }
  | { supported: false; reason: string; hint?: string };

export type ServiceCapability =
  | { supported: true; manager: "launchd" | "systemd" | "task-scheduler" }
  | { supported: false; reason: string };

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
    trust: { supported: true, method: "macos-keychain" },
    lanMdns: {
      supported: true,
      publisher: {
        command: "dns-sd",
        probeArgs: ["-h"],
        missingReason: "dns-sd not found",
        buildArgs: (fqdn, name, port, ip) => [
          "-P",
          name,
          "_http._tcp",
          "local",
          port.toString(),
          fqdn,
          ip,
        ],
      },
    },
    service: { supported: true, manager: "launchd" },
  },
  linux: {
    supported: true,
    trust: { supported: true, method: "linux-ca-store" },
    lanMdns: {
      supported: true,
      publisher: {
        command: "avahi-publish-address",
        probeArgs: ["--help"],
        missingReason:
          "avahi-publish-address not found. Install avahi-utils: sudo apt install avahi-utils",
        buildArgs: (fqdn, _name, _port, ip) => ["-f", "-R", fqdn, ip],
      },
    },
    service: { supported: true, manager: "systemd" },
  },
  win32: {
    supported: true,
    trust: { supported: true, method: "windows-certutil" },
    lanMdns: {
      supported: false,
      reason: "LAN mode (.local mDNS publishing) is not supported on Windows.",
      hint: "Use --tailscale, --ngrok, or --cloudflare to share apps from Windows.",
    },
    service: { supported: true, manager: "task-scheduler" },
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
