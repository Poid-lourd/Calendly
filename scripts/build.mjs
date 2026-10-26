// Construit le serveur (dist/server.js) et les ressources navigateur (dist/public/assets).
// Les noms des ressources contiennent un hash, listé dans dist/manifest.json.
import { spawn } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import * as esbuild from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "public", "assets"), { recursive: true });

// Polices pour l'image de la signature de mail, rendue côté serveur.
await mkdir(path.join(dist, "fonts"), { recursive: true });
for (const weight of [400, 500, 600]) {
  for (const subset of ["latin", "latin-ext"]) {
    const file = `ibm-plex-sans-${subset}-${weight}-normal.woff`;
    await copyFile(path.join(root, "node_modules/@fontsource/ibm-plex-sans/files", file), path.join(dist, "fonts", file));
  }
}

const writeManifest = {
  name: "manifest",
  setup(build) {
    build.onEnd(async (result) => {
      if (!result.metafile) return;
      const manifest = {};
      for (const [out, meta] of Object.entries(result.metafile.outputs)) {
        if (!meta.entryPoint) continue;
        const name = path.basename(meta.entryPoint).replace(/\.ts$/, ".js");
        manifest[name] = "/assets/" + path.basename(out);
      }
      await writeFile(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
    });
  },
};

const clientOptions = {
  entryPoints: ["src/client/booking.ts", "src/client/admin.ts", "src/styles/app.css"],
  outdir: path.join(dist, "public", "assets"),
  entryNames: "[name]-[hash]",
  assetNames: "[name]-[hash]",
  bundle: true,
  minify: !watch,
  sourcemap: false,
  format: "iife",
  target: ["es2020", "chrome100", "firefox100", "safari15"],
  loader: { ".woff2": "file" },
  metafile: true,
  absWorkingDir: root,
  logLevel: "info",
  plugins: [writeManifest],
};

const serverOptions = {
  entryPoints: ["src/server.ts"],
  outfile: path.join(dist, "server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  absWorkingDir: root,
  logLevel: "info",
};

if (watch) {
  const client = await esbuild.context(clientOptions);
  const server = await esbuild.context(serverOptions);
  await Promise.all([client.rebuild(), server.rebuild()]);
  await Promise.all([client.watch(), server.watch()]);
  spawn(process.execPath, ["--watch", "--enable-source-maps", path.join(dist, "server.js")], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  await Promise.all([esbuild.build(clientOptions), esbuild.build(serverOptions)]);
}
