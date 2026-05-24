const fs = require("fs");
const path = require("path");

const requiredAssets = [
  "media/webview.html",
  "media/main.js",
  "media/VectorGraphics.js",
  "media/minimal.css",
  "media/katex/katex.min.js",
  "media/katex/katex.min.css",
  "media/katex/contrib/auto-render.min.js",
  "media/iosevka-fixed-extended.woff2",
  "media/iosevka-fixed-extendedmedium.woff2",
  "media/Iosevka-LICENSE.md",
];

const missingAssets = requiredAssets.filter(
  (asset) => !fs.existsSync(path.join(__dirname, "..", asset)),
);

if (missingAssets.length > 0) {
  console.error(
    [
      "Missing webview assets required by the packaged extension:",
      ...missingAssets.map((asset) => `  - ${asset}`),
      "Run npm run compile from a checkout that includes the static media files.",
    ].join("\n"),
  );
  process.exit(1);
}
