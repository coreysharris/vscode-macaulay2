import { Shell } from "./shellEmulator.js";

declare global {
  interface Window {
    macaulay2CompletionItems?: { label: string; kind: string }[];
    macaulay2Syntax?: {
      tokens?: { label: string; className: string; priority: number }[];
      patterns?: { source: string; className: string }[];
    };
    macaulay2ColorTheme?: string;
    macaulay2FocusInputOnLoad?: boolean;
    macaulay2TopLevelMode?: "webapp" | "standard";
  }
}

// @ts-ignore
const vscode = acquireVsCodeApi();

const outputElement = document.getElementById("terminal");

const supportedColorThemes = new Set(["classic", "light", "dark", "vscode"]);

function applyColorTheme(theme: string | undefined) {
  const colorTheme =
    theme && supportedColorThemes.has(theme) ? theme : "vscode";
  document.documentElement.dataset.macaulay2ColorTheme = colorTheme;
}

applyColorTheme(window.macaulay2ColorTheme);

window.addEventListener("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "output":
      myshell.displayOutput(message.data, message.stream == "stderr");
      if (outputElement) {
        outputElement.scrollTop = outputElement.scrollHeight;
      }
      // put focus back on editor:
      if (!myshell.openedHelp) vscode.postMessage({ type: "focus" });
      break;
    case "submittedInput":
      myshell.recordSubmittedInput(message.data || "");
      break;
    case "paste":
      myshell.receivePaste(message.data || "");
      break;
    case "settings":
      applyColorTheme(message.colorTheme);
      break;
  }
});

if (!outputElement) {
  throw new Error("Terminal output element not found.");
}

const myshell = new Shell(
  outputElement,
  (type, msg) => vscode.postMessage({ type: type, data: msg }),
  null,
  null,
  true,
  window.macaulay2CompletionItems || [],
  window.macaulay2Syntax || {},
  window.macaulay2FocusInputOnLoad !== false,
  window.macaulay2TopLevelMode === "standard" ? "standard" : "webapp",
);

console.log("Shell created.");
