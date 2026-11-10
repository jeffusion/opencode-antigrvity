import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
if (process.platform !== "linux" || process.arch !== "x64" || !report?.header?.glibcVersionRuntime) {
  throw new Error("The standalone service must be built on Linux x86_64 with glibc");
}

const root = resolve(import.meta.dir, "..");
const outdir = join(root, "dist");
const koffiAddon = Bun.resolveSync("@koromix/koffi-linux-x64/linux_x64/koffi.node", root);
await mkdir(outdir, { recursive: true });

await Bun.build({
  entrypoints: [join(root, "src/service.ts")],
  env: "disable",
  compile: {
    outfile: join(outdir, "agy-api"),
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  plugins: [{
    name: "embed-koffi",
    setup(build) {
      // Bun can embed the addon when it resolves the binary directly.
      build.onResolve({ filter: /^koffi$/ }, () => ({ path: koffiAddon }));
    },
  }],
});
