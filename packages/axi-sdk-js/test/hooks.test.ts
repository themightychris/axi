import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeCodexConfigUpdate,
  computeSessionStartHookUpdate,
  installSessionStartHooks,
  resolvePortableHookCommand,
  shouldInstallHooksForNodeAxiExecPath,
} from "../src/hooks.js";

describe("computeSessionStartHookUpdate", () => {
  it("installs a managed hook when no hooks exist", () => {
    const [updated, changed] = computeSessionStartHookUpdate(
      {},
      {
        marker: "gh-axi",
        command: "/usr/local/bin/gh-axi",
      },
    );

    expect(changed).toBe(true);
    expect(updated.hooks?.SessionStart).toEqual([
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: "/usr/local/bin/gh-axi",
            timeout: 10,
          },
        ],
      },
    ]);
  });

  it("preserves unrelated hook groups while adding a managed hook", () => {
    const [updated, changed] = computeSessionStartHookUpdate(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "/usr/local/bin/other" }],
            },
          ],
        },
      },
      {
        marker: "gh-axi",
        command: "/usr/local/bin/gh-axi",
      },
    );

    expect(changed).toBe(true);
    expect(updated.hooks?.SessionStart).toHaveLength(2);
    expect(updated.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      "/usr/local/bin/other",
    );
    expect(updated.hooks?.SessionStart?.[1]?.hooks?.[0]?.command).toBe(
      "/usr/local/bin/gh-axi",
    );
  });

  it("repairs a stale managed hook path in place", () => {
    const [updated, changed] = computeSessionStartHookUpdate(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "",
              hooks: [
                {
                  type: "command",
                  command: "/old/path/gh-axi",
                  timeout: 10,
                },
              ],
            },
          ],
        },
      },
      {
        marker: "gh-axi",
        command: "/new/path/gh-axi",
        timeoutSeconds: 15,
      },
    );

    expect(changed).toBe(true);
    expect(updated.hooks?.SessionStart?.[0]?.hooks?.[0]).toEqual({
      type: "command",
      command: "/new/path/gh-axi",
      timeout: 15,
    });
  });

  it("removes managed legacy codex hooks when migrating to SessionStart", () => {
    const [updated, changed] = computeSessionStartHookUpdate(
      {
        hooks: {
          session_start: [
            { type: "command", command: "/old/path/gh-axi" },
            { type: "command", command: "/usr/local/bin/other" },
          ],
        },
      },
      {
        marker: "gh-axi",
        command: "/new/path/gh-axi",
      },
    );

    expect(changed).toBe(true);
    expect(updated.hooks?.session_start).toEqual([
      { type: "command", command: "/usr/local/bin/other" },
    ]);
    expect(updated.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      "/new/path/gh-axi",
    );
  });

  it("is a no-op when the managed hook is already correct", () => {
    const settings = {
      hooks: {
        SessionStart: [
          {
            matcher: "",
            hooks: [
              {
                type: "command" as const,
                command: "/usr/local/bin/gh-axi",
                timeout: 10,
              },
            ],
          },
        ],
      },
    };

    const [updated, changed] = computeSessionStartHookUpdate(settings, {
      marker: "gh-axi",
      command: "/usr/local/bin/gh-axi",
    });

    expect(changed).toBe(false);
    expect(updated).toBe(settings);
  });
});

describe("computeCodexConfigUpdate", () => {
  it("creates a features section for empty config", () => {
    expect(computeCodexConfigUpdate("")).toEqual([
      "[features]\ncodex_hooks = true\n",
      true,
    ]);
  });

  it("adds codex_hooks inside an existing features section", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\nother = true\n",
    );

    expect(changed).toBe(true);
    expect(updated).toBe("[features]\nother = true\ncodex_hooks = true\n");
  });

  it("repairs codex_hooks when it is disabled", () => {
    const [updated, changed] = computeCodexConfigUpdate(
      "[features]\ncodex_hooks = false\n",
    );

    expect(changed).toBe(true);
    expect(updated).toBe("[features]\ncodex_hooks = true\n");
  });

  it("is a no-op when codex_hooks is already enabled", () => {
    const original = "[features]\ncodex_hooks = true\n";
    expect(computeCodexConfigUpdate(original)).toEqual([original, false]);
  });
});

describe("resolvePortableHookCommand", () => {
  const makeContext = (mapping: Record<string, string>) => ({
    pathEntries: ["/usr/local/bin", "/opt/homebrew/bin"],
    pathExtensions: [""],
    resolveRealPath: (p: string) => mapping[p],
  });

  it("returns the plain binary name when PATH resolves to the same file", () => {
    const exec = "/opt/homebrew/lib/node_modules/gh-axi/dist/bin/gh-axi.js";
    const context = makeContext({
      [exec]: exec,
      "/opt/homebrew/bin/gh-axi": exec,
    });

    expect(
      resolvePortableHookCommand(exec, ["gh-axi"], "gh-axi", context),
    ).toBe("gh-axi");
  });

  it("returns the absolute exec path when the binary is not on PATH", () => {
    const exec = "/opt/homebrew/lib/node_modules/gh-axi/dist/bin/gh-axi.js";
    const context = makeContext({ [exec]: exec });

    expect(
      resolvePortableHookCommand(exec, ["gh-axi"], "gh-axi", context),
    ).toBe(exec);
  });

  it("returns the absolute exec path when PATH resolves to a different file", () => {
    const exec = "/Users/me/src/gh-axi/dist/bin/gh-axi.js";
    const context = makeContext({
      [exec]: exec,
      "/usr/local/bin/gh-axi": "/other/install/gh-axi.js",
    });

    expect(
      resolvePortableHookCommand(exec, ["gh-axi"], "gh-axi", context),
    ).toBe(exec);
  });

  it("skips a binary name that doesn't contain the marker", () => {
    const exec = "/real/my-binary.js";
    const context = makeContext({
      [exec]: exec,
      "/usr/local/bin/my-binary": exec,
    });

    expect(
      resolvePortableHookCommand(exec, ["my-binary"], "custom-marker", context),
    ).toBe(exec);
  });

  it("tries multiple binary names and returns the first match", () => {
    const exec = "/real/gh-axi.js";
    const context = makeContext({
      [exec]: exec,
      "/usr/local/bin/gh-axi": exec,
    });

    expect(
      resolvePortableHookCommand(
        exec,
        ["nonexistent", "gh-axi"],
        "gh-axi",
        context,
      ),
    ).toBe("gh-axi");
  });

  it("tries multiple path extensions", () => {
    const exec = "/real/gh-axi.js";
    const context = {
      pathEntries: ["/usr/local/bin"],
      pathExtensions: ["", ".EXE", ".CMD"],
      resolveRealPath: (p: string) =>
        ({
          [exec]: exec,
          "/usr/local/bin/gh-axi.CMD": exec,
        })[p],
    };

    expect(
      resolvePortableHookCommand(exec, ["gh-axi"], "gh-axi", context),
    ).toBe("gh-axi");
  });

  it("returns exec path if execPath cannot be resolved", () => {
    const context = makeContext({});
    expect(
      resolvePortableHookCommand(
        "/missing/gh-axi.js",
        ["gh-axi"],
        "gh-axi",
        context,
      ),
    ).toBe("/missing/gh-axi.js");
  });

  it("returns exec path when no binary names are provided", () => {
    const exec = "/real/gh-axi.js";
    const context = makeContext({ [exec]: exec });
    expect(resolvePortableHookCommand(exec, [], "gh-axi", context)).toBe(exec);
  });
});

describe("shouldInstallHooksForNodeAxiExecPath", () => {
  it("rejects development TypeScript entrypoints", () => {
    expect(
      shouldInstallHooksForNodeAxiExecPath(
        "/Users/me/src/gh-axi/bin/gh-axi.ts",
        {
          marker: "gh-axi",
          binaryNames: ["gh-axi"],
          distEntrypoints: ["dist/bin/gh-axi.js"],
        },
      ),
    ).toBe(false);
  });

  it("accepts packaged dist entrypoints", () => {
    expect(
      shouldInstallHooksForNodeAxiExecPath(
        "/Users/me/src/gh-axi/dist/bin/gh-axi.js",
        {
          marker: "gh-axi",
          binaryNames: ["gh-axi"],
          distEntrypoints: ["dist/bin/gh-axi.js"],
        },
      ),
    ).toBe(true);
  });
});

describe("installSessionStartHooks (portable command)", () => {
  let tmp: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "axi-sdk-js-hooks-"));
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writes the plain binary name when a PATH symlink points at the exec file", () => {
    const home = join(tmp, "home");
    const pkgBin = join(tmp, "pkg", "dist", "bin");
    const pathDir = join(tmp, "path-bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(pkgBin, { recursive: true });
    mkdirSync(pathDir, { recursive: true });

    const execFile = join(pkgBin, "gh-axi.js");
    writeFileSync(execFile, "// stub\n", "utf-8");
    symlinkSync(execFile, join(pathDir, "gh-axi"));

    process.env.PATH = pathDir;

    installSessionStartHooks({
      marker: "gh-axi",
      execPath: execFile,
      binaryNames: ["gh-axi"],
      homeDir: home,
    });

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("gh-axi");
  });

  it("keeps the absolute exec path when the binary is not on PATH", () => {
    const home = join(tmp, "home");
    const pkgBin = join(tmp, "pkg", "dist", "bin");
    const pathDir = join(tmp, "path-bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(pkgBin, { recursive: true });
    mkdirSync(pathDir, { recursive: true });

    const execFile = join(pkgBin, "gh-axi.js");
    writeFileSync(execFile, "// stub\n", "utf-8");

    process.env.PATH = pathDir;

    installSessionStartHooks({
      marker: "gh-axi",
      execPath: execFile,
      binaryNames: ["gh-axi"],
      homeDir: home,
    });

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(execFile);
  });

  it("keeps the absolute exec path when PATH resolves to a different binary", () => {
    const home = join(tmp, "home");
    const pkgBin = join(tmp, "pkg", "dist", "bin");
    const otherBin = join(tmp, "other", "dist", "bin");
    const pathDir = join(tmp, "path-bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(pkgBin, { recursive: true });
    mkdirSync(otherBin, { recursive: true });
    mkdirSync(pathDir, { recursive: true });

    const execFile = join(pkgBin, "gh-axi.js");
    const otherFile = join(otherBin, "gh-axi.js");
    writeFileSync(execFile, "// stub\n", "utf-8");
    writeFileSync(otherFile, "// other\n", "utf-8");
    symlinkSync(otherFile, join(pathDir, "gh-axi"));

    process.env.PATH = pathDir;

    installSessionStartHooks({
      marker: "gh-axi",
      execPath: execFile,
      binaryNames: ["gh-axi"],
      homeDir: home,
    });

    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf-8"),
    );
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(execFile);
  });
});
