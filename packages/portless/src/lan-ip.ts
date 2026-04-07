import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

const PROBE_HOST = "1.1.1.1";
const PROBE_PORT = 53;
const NO_ROUTE_IP = "0.0.0.0";

function isIPv4Family(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

function parseMac(macStr: string): number[] {
  return macStr
    .split(":")
    .slice(0, 16)
    .map((seq) => parseInt(seq, 16));
}

/**
 * Mirrors lan-network isInternal() for a matched interface row.
 * See https://github.com/kitten/lan-network/blob/main/src/network.ts
 */
function isInternalInterface(iname: string, macStr: string, internal: boolean): boolean {
  if (internal) {
    return true;
  }
  const mac = parseMac(macStr);
  if (mac.every((x) => !x)) {
    return true;
  }
  if (mac[0] === 0 && mac[1] === 21 && mac[2] === 93) {
    return true;
  }
  if (iname.includes("vEthernet") || /^bridge\d+$/.test(iname)) {
    return true;
  }
  return false;
}

/**
 * UDP connect to a public address to learn the local IPv4 used for the default route.
 */
export function probeDefaultRouteIPv4(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createSocket({ type: "udp4", reuseAddr: true });
    socket.on("error", (error) => {
      socket.close();
      socket.unref();
      reject(error);
    });
    socket.connect(PROBE_PORT, PROBE_HOST, () => {
      const addr = socket.address();
      socket.close();
      socket.unref();
      if (addr && "address" in addr && addr.address && addr.address !== NO_ROUTE_IP) {
        resolve(addr.address);
      } else {
        reject(new Error("No route to host"));
      }
    });
  });
}

function findInterfaceRowForIp(ip: string): {
  iname: string;
  address: string;
  mac: string;
  internal: boolean;
} | null {
  const ifs = networkInterfaces();
  for (const iname of Object.keys(ifs)) {
    const entries = ifs[iname];
    if (!entries) continue;
    for (const e of entries) {
      if (!isIPv4Family(e.family)) continue;
      if (e.address !== ip) continue;
      return { iname, address: e.address, mac: e.mac, internal: e.internal };
    }
  }
  return null;
}

/**
 * Detect the local network IP address used for the default IPv4 route.
 * Returns null if there is no route, the address is loopback-only, or the NIC is treated as internal.
 */
export async function getLocalNetworkIp(): Promise<string | null> {
  try {
    const ip = await probeDefaultRouteIPv4();
    if (ip === "127.0.0.1") {
      return null;
    }
    const row = findInterfaceRowForIp(ip);
    if (!row) {
      return null;
    }
    if (row.address === "127.0.0.1") {
      return null;
    }
    if (isInternalInterface(row.iname, row.mac, row.internal)) {
      return null;
    }
    return row.address;
  } catch {
    return null;
  }
}
