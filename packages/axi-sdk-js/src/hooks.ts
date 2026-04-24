import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

export interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string | null;
  hooks?: HookEntry[];
}

export interface HookSettings {
  hooks?: {
    SessionStart?: HookGroup[];
    session_start?: HookEntry[];
    [event: string]: HookGroup[] | HookEntry[] | undefined;
  };
  [key: string]: unknown;
}

export interface ManagedHookSpec {
  marker: string;
  command: string;
  timeoutSeconds?: number;
}

export interface NodeAxiExecPathPolicy {
  marker: string;
  binaryNames?: string[];
  distEntrypoints?: string[];
}

export interface InstallSessionStartHooksOptions {
  marker: string;
  execPath?: string;
  binaryNames?: string[];
  timeoutSeconds?: number;
  homeDir?: string;
  shouldInstall?: (execPath: string) => boolean;
  onError?: (message: string) => void;
}

export interface PortableHookCommandContext {
  pathEntries: string[];
  pathExtensions: string[];
  resolveRealPath: (absolutePath: string) => string | undefined;
}

function isManagedHook(hook: HookEntry | undefined, marker: string): boolean {
  return typeof hook?.command === "string" && hook.command.includes(marker);
}

export function computeSessionStartHookUpdate(
  settings: HookSettings,
  spec: ManagedHookSpec,
): [HookSettings, boolean] {
  const updated = structuredClone(settings);
  let changed = false;

  if (!updated.hooks) {
    updated.hooks = {};
    changed = true;
  }

  if (Array.isArray(updated.hooks.session_start)) {
    const legacyHooks = updated.hooks.session_start.filter(
      (hook) => !isManagedHook(hook, spec.marker),
    );

    if (legacyHooks.length !== updated.hooks.session_start.length) {
      changed = true;
      if (legacyHooks.length === 0) {
        delete updated.hooks.session_start;
      } else {
        updated.hooks.session_start = legacyHooks;
      }
    }
  }

  if (!Array.isArray(updated.hooks.SessionStart)) {
    updated.hooks.SessionStart = [];
    changed = true;
  }

  for (const group of updated.hooks.SessionStart) {
    if (!Array.isArray(group.hooks)) {
      continue;
    }

    for (const hook of group.hooks) {
      if (!isManagedHook(hook, spec.marker)) {
        continue;
      }

      const timeout = spec.timeoutSeconds ?? 10;
      const isCorrect =
        hook.command === spec.command &&
        hook.type === "command" &&
        hook.timeout === timeout;

      if (isCorrect && !changed) {
        return [settings, false];
      }

      hook.command = spec.command;
      hook.type = "command";
      hook.timeout = timeout;
      return [updated, true];
    }
  }

  updated.hooks.SessionStart.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: spec.command,
        timeout: spec.timeoutSeconds ?? 10,
      },
    ],
  });

  return [updated, true];
}

export function computeCodexConfigUpdate(content: string): [string, boolean] {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.length === 0 ? "" : content;

  if (normalized.trim().length === 0) {
    return [`[features]${newline}codex_hooks = true${newline}`, true];
  }

  const lines = normalized.split(/\r?\n/);
  const updated = [...lines];
  let inFeatures = false;
  let sawFeatures = false;

  for (let index = 0; index < updated.length; index++) {
    const line = updated[index];
    const section = line.match(/^\s*(\[{1,2})([^\]]+)(\]{1,2})\s*(?:#.*)?$/);

    if (section) {
      const isTableHeader =
        (section[1] === "[" && section[3] === "]") ||
        (section[1] === "[[" && section[3] === "]]");
      if (!isTableHeader) {
        continue;
      }

      const sectionName = section[2].trim();
      if (inFeatures) {
        updated.splice(index, 0, "codex_hooks = true");
        return [updated.join(newline), true];
      }

      inFeatures = sectionName === "features";
      sawFeatures ||= inFeatures;
      continue;
    }

    if (!inFeatures) {
      continue;
    }

    const flag = line.match(/^\s*codex_hooks\s*=\s*(true|false)\s*(?:#.*)?$/);
    if (!flag) {
      continue;
    }

    if (flag[1] === "true") {
      return [content, false];
    }

    updated[index] = line.replace(/false/, "true");
    return [updated.join(newline), true];
  }

  if (sawFeatures) {
    const suffix = normalized.endsWith(newline) ? "" : newline;
    return [`${normalized}${suffix}codex_hooks = true${newline}`, true];
  }

  const separator = normalized.endsWith(newline)
    ? newline
    : `${newline}${newline}`;
  return [
    `${normalized}${separator}[features]${newline}codex_hooks = true${newline}`,
    true,
  ];
}

export function resolvePortableHookCommand(
  execPath: string,
  binaryNames: string[],
  marker: string,
  context: PortableHookCommandContext,
): string {
  if (binaryNames.length === 0) {
    return execPath;
  }

  const resolvedExec = context.resolveRealPath(execPath);
  if (!resolvedExec) {
    return execPath;
  }

  for (const name of binaryNames) {
    if (!name.includes(marker)) {
      continue;
    }
    for (const dir of context.pathEntries) {
      if (!dir) continue;
      for (const ext of context.pathExtensions) {
        const candidate = join(dir, `${name}${ext}`);
        const resolvedCandidate = context.resolveRealPath(candidate);
        if (resolvedCandidate && resolvedCandidate === resolvedExec) {
          return name;
        }
      }
    }
  }

  return execPath;
}

function buildDefaultPortableCommandContext(): PortableHookCommandContext {
  const rawPath = process.env.PATH ?? process.env.Path ?? "";
  const pathEntries = rawPath.split(delimiter).filter(Boolean);
  const pathExtensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  return {
    pathEntries,
    pathExtensions,
    resolveRealPath: (absolutePath) => {
      try {
        const stat = statSync(absolutePath);
        if (!stat.isFile()) {
          return undefined;
        }
        return realpathSync(absolutePath);
      } catch {
        return undefined;
      }
    },
  };
}

export function shouldInstallHooksForNodeAxiExecPath(
  execPath: string,
  policy: NodeAxiExecPathPolicy,
): boolean {
  const normalized = resolve(execPath).replaceAll("\\", "/");
  if (!normalized.includes(policy.marker) || normalized.endsWith(".ts")) {
    return false;
  }

  const fileName = basename(normalized);
  if (policy.binaryNames?.includes(fileName)) {
    return true;
  }

  return (
    policy.distEntrypoints?.some((entrypoint) =>
      normalized.endsWith(entrypoint.replaceAll("\\", "/")),
    ) ?? false
  );
}

export function installSessionStartHooks(
  options: InstallSessionStartHooksOptions,
): void {
  const execPath = resolve(options.execPath ?? process.argv[1] ?? "");
  if (!execPath) {
    return;
  }

  if (options.shouldInstall && !options.shouldInstall(execPath)) {
    return;
  }

  const command = resolvePortableHookCommand(
    execPath,
    options.binaryNames ?? [],
    options.marker,
    buildDefaultPortableCommandContext(),
  );

  const home = options.homeDir ?? homedir();
  const jsonTargets = [
    join(home, ".claude", "settings.json"),
    join(home, ".codex", "hooks.json"),
  ];
  const codexConfigPath = join(home, ".codex", "config.toml");

  for (const target of jsonTargets) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      const current = existsSync(target)
        ? (JSON.parse(readFileSync(target, "utf-8")) as HookSettings)
        : {};
      const [updated, changed] = computeSessionStartHookUpdate(current, {
        marker: options.marker,
        command,
        timeoutSeconds: options.timeoutSeconds,
      });

      if (changed) {
        writeFileSync(target, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onError?.(`${target}: ${message}`);
    }
  }

  try {
    mkdirSync(dirname(codexConfigPath), { recursive: true });
    const current = existsSync(codexConfigPath)
      ? readFileSync(codexConfigPath, "utf-8")
      : "";
    const [updated, changed] = computeCodexConfigUpdate(current);

    if (changed) {
      writeFileSync(codexConfigPath, updated, "utf-8");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onError?.(`${codexConfigPath}: ${message}`);
  }
}
