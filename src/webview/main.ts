import { Shell } from "./shellEmulator.js";

declare global {
  interface Window {
    macaulay2CompletionItems?: { label: string; kind: string }[];
  }
}

// @ts-ignore
const vscode = acquireVsCodeApi();

const outputElement = document.getElementById("terminal");

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
    case "paste":
      myshell.receivePaste(message.data || "");
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
);

console.log("Shell created.");
