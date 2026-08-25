import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

export type AdbDiscovery = {
  command: string;
  source: "CONFIGURED" | "ANDROID_SDK" | "LOCAL_ANDROID_SDK" | "WINGET" | "USER_PLATFORM_TOOLS" | "DOWNLOADS" | "LISTENER_FOLDER" | "WORKSPACE" | "PATH";
  detected: boolean;
};

type DiscoveryOptions = {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  cwd?: string;
  scriptPath?: string;
  exists?: (path: string) => boolean;
  readDirectory?: (path: string) => string[];
};

export function discoverAdbCommand(options: DiscoveryOptions = {}): AdbDiscovery {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cwd = resolve(options.cwd || process.cwd());
  const scriptDirectory = dirname(resolve(options.scriptPath || process.argv[1] || cwd));
  const fileExists = options.exists || existsSync;
  const readDirectory = options.readDirectory || ((path: string) => readdirSync(path));
  const executable = platform === "win32" ? "adb.exe" : "adb";
  const home = env.USERPROFILE || env.HOME || homedir();
  const configured = env.LOCAL_PAYMENT_ADB_PATH?.trim();

  if (configured) return { command: configured, source: "CONFIGURED", detected: fileExists(configured) };

  const candidates: Array<{ path: string; source: Exclude<AdbDiscovery["source"], "CONFIGURED" | "PATH"> }> = [];
  for (const sdkRoot of [env.ANDROID_SDK_ROOT, env.ANDROID_HOME]) {
    if (sdkRoot?.trim()) candidates.push({ path: resolve(sdkRoot, "platform-tools", executable), source: "ANDROID_SDK" });
  }
  const localAppData = env.LOCALAPPDATA || (platform === "win32" ? resolve(home, "AppData", "Local") : "");
  if (localAppData) candidates.push({ path: resolve(localAppData, "Android", "Sdk", "platform-tools", executable), source: "LOCAL_ANDROID_SDK" });
  if (platform === "win32" && localAppData) {
    candidates.push({ path: resolve(localAppData, "Microsoft", "WinGet", "Links", executable), source: "WINGET" });
    const packages = resolve(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const name of readDirectory(packages)) {
        if (name.toLocaleLowerCase("en-US").startsWith("google.platformtools_")) {
          candidates.push({ path: resolve(packages, name, "platform-tools", executable), source: "WINGET" });
        }
      }
    } catch { /* WinGet is optional. */ }
  }
  candidates.push(
    { path: resolve(home, "platform-tools", executable), source: "USER_PLATFORM_TOOLS" },
    { path: resolve(home, "Downloads", "platform-tools", executable), source: "DOWNLOADS" },
    { path: resolve(scriptDirectory, "platform-tools", executable), source: "LISTENER_FOLDER" },
    { path: resolve(scriptDirectory, executable), source: "LISTENER_FOLDER" },
    { path: resolve(cwd, "platform-tools", executable), source: "WORKSPACE" },
    { path: resolve(cwd, executable), source: "WORKSPACE" },
  );

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = platform === "win32" ? candidate.path.toLocaleLowerCase("en-US") : candidate.path;
    if (seen.has(key)) continue;
    seen.add(key);
    if (fileExists(candidate.path)) return { command: candidate.path, source: candidate.source, detected: true };
  }
  return { command: "adb", source: "PATH", detected: false };
}

export function adbDiscoveryLabel(source: AdbDiscovery["source"]) {
  return ({
    CONFIGURED: "configured ADB path",
    ANDROID_SDK: "Android SDK environment",
    LOCAL_ANDROID_SDK: "Android Studio SDK",
    WINGET: "WinGet Platform-Tools package",
    USER_PLATFORM_TOOLS: "user platform-tools folder",
    DOWNLOADS: "Downloads/platform-tools",
    LISTENER_FOLDER: "listener folder",
    WORKSPACE: "current workspace",
    PATH: "system PATH",
  } as const)[source];
}
