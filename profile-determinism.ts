/**
 * Hardware Profile Determinism
 * Maps credential email domains to consistent hardware specs (CPU cores, memory, GPU).
 * Same email always gets same hardware profile — reduces bot detection flags.
 */

export interface HardwareProfile {
  cores: number;
  memory: number;
  gpu: {
    vendor: string;
    renderer: string;
  };
}

const HARDWARE_PRESETS: HardwareProfile[] = [
  { cores: 4, memory: 8, gpu: { vendor: "Intel", renderer: "UHD Graphics 630" } },
  { cores: 6, memory: 8, gpu: { vendor: "Intel", renderer: "UHD Graphics 750" } },
  { cores: 8, memory: 16, gpu: { vendor: "NVIDIA", renderer: "GeForce GTX 1650" } },
  { cores: 8, memory: 16, gpu: { vendor: "Intel", renderer: "Iris Pro Graphics 580" } },
  { cores: 12, memory: 32, gpu: { vendor: "AMD", renderer: "Radeon RX 6600" } },
  { cores: 12, memory: 32, gpu: { vendor: "NVIDIA", renderer: "GeForce RTX 3060" } },
  { cores: 16, memory: 32, gpu: { vendor: "Intel", renderer: "Arc A770" } },
  { cores: 16, memory: 32, gpu: { vendor: "NVIDIA", renderer: "GeForce RTX 4060 Ti" } },
];

function hashEmailDomain(emailDomain: string): number {
  const domain = emailDomain.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    const char = domain.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

/**
 * Get the consistent hardware profile for a given email.
 * Same email always returns same hardware.
 */
export function getConsistentHardware(email: string): HardwareProfile {
  const domain = email.split("@")[1] || email;
  const hash = hashEmailDomain(domain);
  const index = hash % HARDWARE_PRESETS.length;
  return { ...HARDWARE_PRESETS[index] };
}

/**
 * Get the consistent hardware profile by email with logging.
 */
export function getConsistentHardwareWithLog(
  email: string,
  logFn?: (msg: string) => void
): HardwareProfile {
  const hw = getConsistentHardware(email);
  const msg = `Hardware determinism: ${email.split("@")[1] || email} → ${hw.cores}c/${hw.memory}GB ${hw.gpu.vendor} ${hw.gpu.renderer}`;
  if (logFn) logFn(msg);
  return hw;
}

/**
 * Extract CLI args for hardware profile (GPU vendor/renderer).
 * These get added to CloakBrowser launch args.
 */
export function getHardwareArgs(profile: HardwareProfile): string[] {
  const args: string[] = [];
  if (profile.gpu.vendor === "NVIDIA") {
    args.push("--use-angle=opengl");
  } else if (profile.gpu.vendor === "AMD") {
    args.push("--use-angle=vulkan");
  } else {
    args.push("--use-angle=d3d11");
  }
  return args;
}

/**
 * Extract navigator.hardwareConcurrency and navigator.deviceMemory spoofs.
 */
export function getNavigatorOverrides(profile: HardwareProfile) {
  return {
    hardwareConcurrency: profile.cores,
    deviceMemory: profile.memory,
  };
}

