import * as fs from "fs";
import * as path from "path";

import { execFileSync } from "child_process";

export interface M2ExecutableResolution {
  executablePath: string;
  source: string;
  wslExecutablePath?: string;
  wslDistroName?: string;
}

export interface M2LaunchConfiguration {
  executablePath: string;
  args: string[];
  cwd?: string;
}

export type M2LaunchArgsConfiguration = string | undefined;

export function resolveM2Executable(
  configuredPath?: string,
): M2ExecutableResolution | undefined {
  const manualPath = normalizeConfiguredPath(configuredPath);
  if (manualPath) {
    const manualWslResolution = resolveManualWslExecutable(manualPath);
    if (manualWslResolution) {
      return manualWslResolution;
    }

    return { executablePath: manualPath, source: "setting" };
  }

  const fromPath = findCommandOnPath("M2");
  if (fromPath) {
    return { executablePath: fromPath, source: "PATH" };
  }

  if (process.platform === "win32") {
    const fromCygwinShell = resolveWithCygwinShell();
    if (fromCygwinShell) {
      return {
        executablePath: fromCygwinShell,
        source: "Cygwin shell",
      };
    }

    const fromKnownLocation = firstExistingExecutable(getWindowsCandidates());
    if (fromKnownLocation) {
      return {
        executablePath: fromKnownLocation,
        source: "common Windows install location",
      };
    }

    const fromWsl = resolveWithWsl();
    if (fromWsl) {
      return fromWsl;
    }

    return undefined;
  }

  const fromLoginShell = resolveWithLoginShell();
  if (fromLoginShell) {
    return {
      executablePath: fromLoginShell,
      source: "login shell PATH",
    };
  }

  const fromKnownLocation = firstExistingExecutable(getUnixCandidates());
  if (fromKnownLocation) {
    return {
      executablePath: fromKnownLocation,
      source: "common install location",
    };
  }

  return undefined;
}

export function getM2LaunchConfiguration(
  resolution: M2ExecutableResolution,
  args: string[],
  workingDir: string,
  additionalArgs: M2LaunchArgsConfiguration = "",
): M2LaunchConfiguration {
  const m2Args = [...args, ...normalizeM2LaunchArgs(additionalArgs)];

  if (resolution.wslExecutablePath) {
    return {
      executablePath: resolution.executablePath,
      args: [
        "--cd",
        windowsPathToWslPath(workingDir) || "~",
        "--exec",
        resolution.wslExecutablePath,
        ...m2Args,
      ],
    };
  }

  return {
    executablePath: resolution.executablePath,
    args: m2Args,
    cwd: workingDir,
  };
}

export function normalizeM2LaunchArgs(
  args: M2LaunchArgsConfiguration,
): string[] {
  if (!args?.trim()) {
    return [];
  }

  return splitM2LaunchArgs(args);
}

function splitM2LaunchArgs(args: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | undefined;
  let escaping = false;
  let tokenStarted = false;

  for (const char of args.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      tokenStarted = true;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        result.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping) {
    current += "\\";
  }
  if (tokenStarted) {
    result.push(current);
  }

  return result;
}

export function getM2ExecutableResolutionDetail(
  resolution: M2ExecutableResolution,
): string {
  if (resolution.wslExecutablePath) {
    return `${resolution.executablePath} --exec ${resolution.wslExecutablePath}`;
  }

  return resolution.executablePath;
}

export function windowsPathToWslPath(filePath: string): string {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const wslUncMatch = normalizedPath.match(
    /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i,
  );
  if (wslUncMatch) {
    return wslUncMatch[1] || "/";
  }

  const driveMatch = normalizedPath.match(/^([a-zA-Z]):\/?(.*)$/);
  if (!driveMatch) {
    return normalizedPath;
  }

  const [, drive, rest] = driveMatch;
  const suffix = rest ? `/${rest.replace(/^\/+/, "")}` : "";
  return `/mnt/${drive.toLowerCase()}${suffix}`;
}

export function wslPathToWindowsPath(
  filePath: string,
  distroName?: string,
  wslHostExecutablePath?: string,
): string | undefined {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const driveMatch = normalizedPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (driveMatch) {
    const [, drive, rest] = driveMatch;
    return `${drive.toUpperCase()}:\\${rest ? rest.replace(/\//g, "\\") : ""}`;
  }

  if (!isUnixAbsolutePath(normalizedPath)) {
    return undefined;
  }

  const wslPath = wslHostExecutablePath
    ? resolveWslWindowsPath(wslHostExecutablePath, normalizedPath)
    : undefined;
  if (wslPath) {
    return wslPath;
  }

  if (!distroName) {
    return undefined;
  }

  const suffix =
    normalizedPath === "/" ? "\\" : normalizedPath.replace(/\//g, "\\");
  return `\\\\wsl$\\${distroName}${suffix}`;
}

function normalizeConfiguredPath(configuredPath?: string): string | undefined {
  const trimmed = configuredPath?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveManualWslExecutable(
  configuredPath: string,
): M2ExecutableResolution | undefined {
  if (process.platform !== "win32" || !isUnixAbsolutePath(configuredPath)) {
    return undefined;
  }

  const wslPath = findWslExecutable();
  if (!wslPath) {
    return undefined;
  }

  return {
    executablePath: wslPath,
    source: "setting via WSL",
    wslExecutablePath: configuredPath,
    wslDistroName: resolveWslDistroName(wslPath),
  };
}

function resolveWithLoginShell(): string | undefined {
  const shell = getEnv("SHELL");
  if (!shell || !path.isAbsolute(shell) || !fs.existsSync(shell)) {
    return undefined;
  }

  const resolved = runShellCommand(shell, ["-l", "-c", "command -v M2"]);
  if (resolved && isExecutableFile(resolved)) {
    return resolved;
  }

  return undefined;
}

function resolveWithCygwinShell(): string | undefined {
  const bashCandidates = [
    findCommandOnPath("bash"),
    ...getWindowsCandidateRoots().map((root) =>
      path.join(root, "bin", "bash.exe"),
    ),
  ];

  for (const bashPath of dedupe(bashCandidates)) {
    if (!bashPath || !isExecutableFile(bashPath)) {
      continue;
    }

    const resolved = runShellCommand(bashPath, [
      "-lc",
      'if command -v M2 >/dev/null 2>&1; then cygpath -wa "$(command -v M2)"; fi',
    ]);
    if (resolved && isExecutableFile(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

function resolveWithWsl(): M2ExecutableResolution | undefined {
  const wslPath = findWslExecutable();
  if (!wslPath) {
    return undefined;
  }

  const resolved = runShellCommand(
    wslPath,
    ["--exec", "sh", "-lc", "command -v M2"],
    5000,
  );
  const wslExecutablePath = normalizeShellOutputPath(resolved);
  if (!wslExecutablePath || !isUnixAbsolutePath(wslExecutablePath)) {
    return undefined;
  }

  return {
    executablePath: wslPath,
    source: "WSL",
    wslExecutablePath,
    wslDistroName: resolveWslDistroName(wslPath),
  };
}

function resolveWslDistroName(wslPath: string): string | undefined {
  const envDistroName = normalizeShellOutputPath(
    runShellCommand(
      wslPath,
      ["--exec", "sh", "-lc", 'printf "%s" "$WSL_DISTRO_NAME"'],
      5000,
    ),
  );
  if (envDistroName) {
    return envDistroName;
  }

  const windowsRoot = resolveWslWindowsPath(wslPath, "/");
  const rootMatch = windowsRoot?.match(
    /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/i,
  );
  return rootMatch?.[1];
}

function resolveWslWindowsPath(
  wslHostExecutablePath: string,
  filePath: string,
): string | undefined {
  return normalizeShellOutputPath(
    runShellCommand(
      wslHostExecutablePath,
      ["--exec", "wslpath", "-w", filePath],
      5000,
    ),
  );
}

function findWslExecutable(): string | undefined {
  return firstExistingExecutable([
    findCommandOnPath("wsl"),
    getWindowsSystemExecutable("wsl.exe"),
  ]);
}

function runShellCommand(
  shellPath: string,
  args: string[],
  timeout?: number,
): string | undefined {
  try {
    const output = execFileSync(shellPath, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function normalizeShellOutputPath(
  output: string | undefined,
): string | undefined {
  return output
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function findCommandOnPath(command: string): string | undefined {
  for (const candidate of getPathCandidates(command)) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getPathCandidates(command: string): string[] {
  if (isPathLike(command)) {
    return expandWindowsExecutableNames(command);
  }

  const pathValue = getEnv("PATH");
  if (!pathValue) {
    return [];
  }

  const candidates: string[] = [];
  for (const dir of pathValue.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) {
      continue;
    }

    for (const name of expandWindowsExecutableNames(command)) {
      candidates.push(path.join(trimmed, name));
    }
  }

  return dedupe(candidates);
}

function getUnixCandidates(): string[] {
  if (process.platform === "darwin") {
    return ["/opt/homebrew/bin/M2", "/usr/local/bin/M2"];
  }

  return [];
}

function getWindowsCandidates(): string[] {
  const candidates: string[] = [];
  for (const root of getWindowsCandidateRoots()) {
    candidates.push(path.join(root, "bin", "M2.exe"));
  }

  return dedupe(candidates);
}

function getWindowsCandidateRoots(): string[] {
  const roots = new Set<string>();
  const systemDrive = getEnv("SystemDrive") || "C:";
  const baseRoots = [
    systemDrive,
    getEnv("ProgramFiles"),
    getEnv("ProgramFiles(x86)"),
  ];

  for (const baseRoot of baseRoots) {
    if (!baseRoot) {
      continue;
    }

    roots.add(path.join(baseRoot, "cygwin64"));
    roots.add(path.join(baseRoot, "cygwin"));
    roots.add(path.join(baseRoot, "tools", "cygwin64"));
    roots.add(path.join(baseRoot, "tools", "cygwin"));
  }

  return Array.from(roots);
}

function getWindowsSystemExecutable(
  executableName: string,
): string | undefined {
  const systemRoot =
    getEnv("SystemRoot") || path.join(getEnv("SystemDrive") || "C:", "Windows");
  return path.join(systemRoot, "System32", executableName);
}

function expandWindowsExecutableNames(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }

  const extension = path.extname(command);
  if (extension) {
    return [command];
  }

  const pathext = getEnv("PATHEXT");
  const extensions = pathext
    ? pathext
        .split(";")
        .map((value) => value.trim())
        .filter(Boolean)
    : [".COM", ".EXE", ".BAT", ".CMD"];

  const candidates = [command];
  for (const ext of extensions) {
    candidates.push(command + ext.toLowerCase());
    candidates.push(command + ext.toUpperCase());
  }

  return dedupe(candidates);
}

function firstExistingExecutable(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) {
      return false;
    }

    if (process.platform === "win32") {
      return true;
    }

    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isPathLike(value: string): boolean {
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function isUnixAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function getEnv(name: string): string | undefined {
  if (process.platform !== "win32") {
    return process.env[name];
  }

  const lowerName = name.toLowerCase();
  for (const key of Object.keys(process.env)) {
    if (key.toLowerCase() === lowerName) {
      return process.env[key];
    }
  }

  return undefined;
}

function dedupe(values: Array<string | undefined>): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (value) {
      result.add(value);
    }
  }
  return Array.from(result);
}
