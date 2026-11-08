import { describe, expect, test } from "bun:test";

const root = new URL("../", import.meta.url);

describe("Bun-only project tooling", () => {
  test("keeps Bun pinned and as the only package manager lockfile", async () => {
    const manifest = await Bun.file(new URL("package.json", root)).json();
    const version = manifest.packageManager.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1];

    expect(version).toBe("1.4.4");
    expect(manifest.engines).toEqual({ bun: ">=1.4.4" });

    const lockfiles = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];
    const present = await Promise.all(lockfiles.map(async (file) =>
      await Bun.file(new URL(file, root)).exists() ? file : undefined));
    expect(present.filter(Boolean)).toEqual(["bun.lock"]);
  });

  test("runs scripts and CI on the pinned Bun runtime", async () => {
    const manifest = await Bun.file(new URL("package.json", root)).json();
    const commands = Object.values(manifest.scripts) as string[];
    for (const command of commands) {
      expect(command).not.toMatch(/(?:^|[\s;&|])(?:node|npm|npx)(?:\s|$)/i);
    }
    expect(manifest.scripts.compile).toContain("bun run --bun tsc");
    expect(manifest.scripts.precompile).toBe("bun run scripts/clean.ts");
    expect(manifest.scripts.pretest).toBe("bun run compile");
    expect(manifest.scripts.check).toBe("bun run compile && bun test test");
    expect(manifest.scripts.prepublishOnly).toBe("bun run check");
    for (const script of ["build", "prepack", "prepare", "preinstall", "install", "postinstall"]) {
      expect(manifest.scripts).not.toHaveProperty(script);
    }
    for (const entry of Object.values(manifest.exports) as { import: string; default: string }[]) {
      for (const file of [entry.import, entry.default]) {
        expect(file).toStartWith("./src/");
        expect(await Bun.file(new URL(file, root)).exists()).toBe(true);
      }
    }

    const workflow = await Bun.file(new URL(".github/workflows/windows.yml", root)).text();
    const ciPins = [...workflow.matchAll(/bun-version:\s*([^\s]+)/g)].map((match) => match[1]);
    expect(ciPins.length).toBeGreaterThan(0);
    expect(ciPins.every((pin) => pin === "1.4.4")).toBe(true);

    const fakeAcp = await Bun.file(new URL("test/fixtures/fake-acp.mjs", root)).text();
    expect(fakeAcp.split("\n", 1)[0]).toBe("#!/usr/bin/env bun");
  });
});
