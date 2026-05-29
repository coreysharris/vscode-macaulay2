const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const baseConfig = {
  bundle: true,
  sourcemap: !production,
  minify: production,
};

async function build() {
  const backendCtx = await esbuild.context({
    ...baseConfig,
    entryPoints: ["src/backend/extension.ts"],
    outfile: "out/extension.js",
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
  });

  const webviewCtx = await esbuild.context({
    ...baseConfig,
    entryPoints: ["src/webview/main.ts"],
    outfile: "media/main.js",
    platform: "browser",
    format: "esm",
  });

  copyKatex();

  if (watch) {
    await backendCtx.watch();
    await webviewCtx.watch();
    console.log("Watching for changes...");
  } else {
    await backendCtx.rebuild();
    await webviewCtx.rebuild();
    await backendCtx.dispose();
    await webviewCtx.dispose();
  }
}

function copyKatex() {
  const katexDist = path.join("node_modules", "katex", "dist");
  const dest = path.join("media", "katex");
  fs.mkdirSync(path.join(dest, "contrib"), { recursive: true });
  fs.cpSync(path.join(katexDist, "fonts"), path.join(dest, "fonts"), { recursive: true });
  fs.copyFileSync(path.join(katexDist, "katex.min.js"), path.join(dest, "katex.min.js"));
  fs.copyFileSync(path.join(katexDist, "katex.min.css"), path.join(dest, "katex.min.css"));
  fs.copyFileSync(
    path.join(katexDist, "contrib", "auto-render.min.js"),
    path.join(dest, "contrib", "auto-render.min.js"),
  );
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
