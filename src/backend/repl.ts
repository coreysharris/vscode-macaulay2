import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { spawn, ChildProcess } from "child_process";
import {
  CodeRunStatusMarker,
  getSubmittedCodeRange,
} from "./codeRunStatus";
import {
  getM2ExecutableResolutionDetail,
  getM2LaunchConfiguration,
  M2LaunchArgsConfiguration,
  resolveM2Executable,
} from "./executablePath";
import { registerM2ExecutableSwitcher } from "./executableSwitcher";

let g_context: vscode.ExtensionContext | undefined;
let g_panel: vscode.WebviewPanel | undefined;
let g_terminal: vscode.Terminal | undefined;
let g_terminalProcess: ChildProcess | undefined;
let g_getWebviewCompletionItems:
  | (() => Promise<WebviewCompletionItem[]>)
  | undefined;
let proc: ChildProcess | undefined;
let procWorkingDir: string | undefined;
let procInterruptWithInput = false;
let shouldRestoreEditorFocusAfterWebviewOutput = false;
let editorToRestoreAfterWebviewOutput: vscode.TextEditor | undefined;
type PendingRunMarker = {
  marker: CodeRunStatusMarker;
  submittedText: string;
  observedSubmittedInput: boolean;
};

const pendingWebviewRunMarkers = new Map<string, PendingRunMarker>();
let nextWebviewRunMarkerId = 1;
const pendingTerminalRunMarkers = new Map<string, PendingRunMarker>();
let nextTerminalRunMarkerId = 1;
const webAppEndTag = String.fromCharCode(18);
const webAppCellEndTag = String.fromCharCode(20);
const webAppPromptTag = String.fromCharCode(14);

type WebviewOutputChunk = {
  data: string;
  stream?: "stderr";
};

const webviewOutputQueue: WebviewOutputChunk[] = [];
let isDrainingWebviewOutput = false;

type WebviewCompletionItem = {
  label: string;
  kind: string;
};
type WebviewColorTheme = "classic" | "light" | "dark" | "vscode";
type WebviewTopLevelMode = "webapp" | "standard";
type WebviewSyntaxClass =
  | "keyword"
  | "operator"
  | "function"
  | "class-name"
  | "constant";
type WebviewSyntaxToken = {
  label: string;
  className: WebviewSyntaxClass;
  priority: number;
};
type WebviewSyntaxPattern = {
  source: string;
  className: WebviewSyntaxClass;
};
type WebviewSyntax = {
  tokens: WebviewSyntaxToken[];
  patterns: WebviewSyntaxPattern[];
};

type HelpPanelState = {
  panel: vscode.WebviewPanel;
  currentFilePath: string;
};

const helpPanels = new Set<HelpPanelState>();

// In WebApp mode, some help pages fail while processing example output.
// Keep native help where it works, and fall back to the top documentation node.
// Also expand ordinary method functions through their installed methods when
// `code f` has no direct source body to show. WebApp also calls realpath while
// converting source-location links, but macOS realpath rejects paths containing
// #L anchors; render FilePosition links directly so code output keeps its
// styled Hypertext form. WebApp also overrides some texMath methods through
// html, which can recurse back into texMath; restore direct LaTeX paths for
// affected core types.
export function getM2StartupPatch(): string {
  return [
    "try (",
    "local toURLFun, urlEncodeFun, htmlLiteralFun;",
    'toURLFun = value ((Core#"private dictionary")#"toURL");',
    'urlEncodeFun = value ((Core#"private dictionary")#"urlEncode");',
    'htmlLiteralFun = value ((Core#"private dictionary")#"htmlLiteral");',
    'html FilePosition := p -> concatenate("<samp><a href=\\"", htmlLiteralFun (urlEncodeFun (toURLFun p)), "\\">", htmlLiteralFun (toString p), "</a></samp>");',
    ') else printerr "warning: VS Code FilePosition HTML fallback could not be installed";',
    "try (",
    "vscodeM2ExtensionOriginalCodeFunction = lookup(code, Function);",
    "code MethodFunction := f -> (",
    "m := methods f;",
    "if #m > 0 then code m else vscodeM2ExtensionOriginalCodeFunction f);",
    ') else printerr "warning: VS Code code fallback could not be installed";',
    "try (",
    "vscodeM2ExtensionOriginalCodeMethodFunctionWithOptions = lookup(code, MethodFunctionWithOptions);",
    "code MethodFunctionWithOptions := f -> (",
    "m := methods f;",
    "if #m > 0 then code m else vscodeM2ExtensionOriginalCodeMethodFunctionWithOptions f);",
    ') else printerr "warning: VS Code code MethodFunctionWithOptions fallback could not be installed";',
    'try (local lit; lit = value (Core#"private dictionary")#"texMathLiteral"; texMath Type := x -> "\\\\texttt{" | lit toString x | "}") else printerr "warning: VS Code texMath Type fallback could not be installed";',
    'try (local lit; lit = value (Core#"private dictionary")#"texMathLiteral"; texMath Ring := x -> if x.?texMath then x.texMath else "\\\\texttt{" | lit toString x | "}") else printerr "warning: VS Code texMath Ring fallback could not be installed";',
    "try (",
    "local tag, rawdoc, rawtag, pkg, fkey, rawTable, had, old, result, k, fetchAny, oldDocumentTag;",
    "vscodeM2ExtensionOriginalDocHelp = lookup(help#0, DocumentTag);",
    "vscodeM2ExtensionTopHelp = tag -> (",
    'fetchAny = value (Core#"private dictionary")#"fetchAnyRawDocumentation";',
    "rawdoc = fetchAny tag;",
    "if rawdoc === null then return vscodeM2ExtensionOriginalDocHelp tag;",
    "rawtag = rawdoc.DocumentTag;",
    "pkg = package rawtag;",
    "fkey = format rawtag;",
    'rawTable = pkg#"raw documentation";',
    "had = rawTable#?fkey;",
    "if had then old = rawTable#fkey;",
    "rawTable#fkey = selectKeys(rawdoc, k -> k =!= Description);",
    'oldDocumentTag = value ((Core#"private dictionary")#"currentDocumentTag");',
    '((Core#"private dictionary")#"currentDocumentTag") <- rawtag;',
    "result = try vscodeM2ExtensionOriginalDocHelp rawtag else (",
    '((Core#"private dictionary")#"currentDocumentTag") <- oldDocumentTag;',
    "if had then rawTable#fkey = old else remove(rawTable, fkey);",
    'error "VS Code help fallback failed while rendering the top documentation node");',
    '((Core#"private dictionary")#"currentDocumentTag") <- oldDocumentTag;',
    "if had then rawTable#fkey = old else remove(rawTable, fkey);",
    "result);",
    "help#0 DocumentTag := tag -> try vscodeM2ExtensionOriginalDocHelp tag else vscodeM2ExtensionTopHelp tag;",
    ') else printerr "warning: VS Code help fallback could not be installed"',
  ].join(" ");
}

function getM2StartupExpression(): string {
  return getM2StartupPatch();
}

export function outputHasM2CompletionSignal(output: string): boolean {
  return (
    output.indexOf(webAppCellEndTag) >= 0 ||
    /(^|\r?\n+)i+\d+ : $/.test(output)
  );
}

function outputHasWebAppPrompt(output: string, startIndex = 0): boolean {
  return output.indexOf(webAppPromptTag, startIndex) >= 0;
}

function normalizeM2OutputForRunDetection(output: string): string {
  return output.replace(/\r/g, "");
}

export function outputHasWebAppPromptAfterSubmittedInput(
  output: string,
  submittedText: string,
  observedSubmittedInput = false,
): boolean {
  output = normalizeM2OutputForRunDetection(output);
  const inputIndex = output.indexOf(submittedText);
  if (inputIndex >= 0) {
    const completionStartIndex = inputIndex + submittedText.length;
    return (
      outputHasWebAppPrompt(output, completionStartIndex) ||
      output.indexOf(webAppCellEndTag, completionStartIndex) >= 0 ||
      /(^|\n+)i+\d+ : $/.test(output.substring(completionStartIndex))
    );
  }
  return (
    observedSubmittedInput &&
    (outputHasWebAppPrompt(output) || outputHasM2CompletionSignal(output))
  );
}

function outputHasSubmittedInput(output: string, submittedText: string): boolean {
  return normalizeM2OutputForRunDetection(output).indexOf(submittedText) >= 0;
}

function outputHasStandardM2Prompt(output: string, startIndex = 0): boolean {
  return /(^|\n+)i+\d+ : /.test(
    normalizeM2OutputForRunDetection(output).substring(startIndex),
  );
}

export function outputHasTerminalPromptAfterSubmittedInput(
  output: string,
  submittedText: string,
  observedSubmittedInput = false,
): boolean {
  output = normalizeM2OutputForRunDetection(output);
  const inputIndex = output.indexOf(submittedText);
  if (inputIndex >= 0) {
    return outputHasStandardM2Prompt(output, inputIndex + submittedText.length);
  }
  return observedSubmittedInput && outputHasStandardM2Prompt(output);
}

export function splitM2OutputForWebview(output: string): string[] {
  if (output.length === 0) {
    return [];
  }

  if (
    output.indexOf(webAppEndTag) < 0 &&
    output.indexOf(webAppCellEndTag) < 0
  ) {
    return output.match(/[^\n]*\n|[^\n]+/g) || [];
  }

  const chunks: string[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index++) {
    const char = output[index];
    if (char !== webAppEndTag && char !== webAppCellEndTag) {
      continue;
    }

    let end = index + 1;
    if (output[end] === "\r") end++;
    if (output[end] === "\n") end++;
    chunks.push(output.substring(start, end));
    start = end;
    index = end - 1;
  }

  if (start < output.length) {
    chunks.push(output.substring(start));
  }
  return chunks;
}

export function getM2WebviewProcessArgs(
  startupExpression: string,
  topLevelMode: WebviewTopLevelMode = "webapp",
): string[] {
  const args = ["--webapp", "-e", startupExpression];
  if (topLevelMode === "standard") args.push("-e", "topLevelMode = Standard");
  return args;
}

export function getM2TerminalProcessArgs(startupExpression: string): string[] {
  return ["-e", startupExpression];
}

type ProcessLaunch = {
  executablePath: string;
  args: string[];
  interruptWithInput?: boolean;
};

type TerminalProcessLaunch = ProcessLaunch & {
  echoesInput: boolean;
  interruptWithInput: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getM2WebviewPtyLaunch(
  executablePath: string,
  args: string[],
): ProcessLaunch {
  if (process.platform === "linux") {
    return {
      executablePath: "script",
      args: [
        "-E",
        "never",
        "-qfec",
        [executablePath, ...args].map(shellQuote).join(" "),
        "/dev/null",
      ],
      interruptWithInput: true,
    };
  }

  return { executablePath, args };
}

function getM2LaunchArgs(): M2LaunchArgsConfiguration {
  return vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("launchArgs", "");
}

function getWebviewColorTheme(): WebviewColorTheme {
  const configuredTheme = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("webviewColorTheme", "vscode");
  return configuredTheme === "light" ||
    configuredTheme === "dark" ||
    configuredTheme === "classic"
    ? configuredTheme
    : "vscode";
}

function getWebviewTopLevelMode(): WebviewTopLevelMode {
  const configuredMode = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("webviewTopLevelMode", "webapp");
  return configuredMode === "standard" ? "standard" : "webapp";
}

function postWebviewSettings() {
  if (!g_panel) return;

  g_panel.webview.postMessage({
    type: "settings",
    colorTheme: getWebviewColorTheme(),
  });
}

function getM2ExecutableResolution() {
  const configuredPath = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("executablePath");
  const resolution = resolveM2Executable(configuredPath);
  if (!resolution) {
    const action = "Open Settings";
    vscode.window
      .showErrorMessage(
        "Could not locate the Macaulay2 executable automatically. Install Macaulay2 so the M2 command is available natively or in WSL, or set 'macaulay2.executablePath' manually.",
        action,
      )
      .then((selectedAction) => {
        if (selectedAction === action) {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "macaulay2.executablePath",
          );
        }
      });
    return undefined;
  }

  console.log(
    `Using M2 executable from ${resolution.source}: ${getM2ExecutableResolutionDetail(
      resolution,
    )}`,
  );
  return resolution;
}

function getM2WorkingDir(): string {
  let workingDir: string;
  const activeEditor = vscode.window.activeTextEditor;

  if (activeEditor && activeEditor.document.uri.scheme === "file") {
    // Use the directory of the currently active file
    workingDir = path.dirname(activeEditor.document.uri.fsPath);
    console.log(`Starting M2 in current file directory: ${workingDir}`);
  } else if (
    vscode.workspace.workspaceFolders &&
    vscode.workspace.workspaceFolders.length > 0
  ) {
    // Use the first workspace folder
    workingDir = vscode.workspace.workspaceFolders[0].uri.fsPath;
    console.log(`Starting M2 in workspace root: ${workingDir}`);
  } else {
    // Fallback to process.cwd()
    workingDir = process.cwd();
    console.log(`Starting M2 in process working directory: ${workingDir}`);
  }

  return workingDir;
}

function normalizeM2Input(text: string): string {
  // TODO: remove this ... (make sure stuff copied from editor has \n) and fix ctrl-C
  // Filter out empty lines and send to terminal
  var lines = text.split(/\r?\n/);
  lines = lines.filter((line) => line !== "");
  text = lines.join("\n");

  if (!text.endsWith("\n")) {
    text = text + "\n";
  }
  return text;
}

export function isM2BlankOrCommentOnly(text: string): boolean {
  return text
    .split(/\r?\n/)
    .every((line) => line.trim().length === 0 || line.trimStart().startsWith("--"));
}

function startM2() {
  const resolution = getM2ExecutableResolution();
  if (!resolution) {
    return;
  }
  const workingDir = getM2WorkingDir();
  const launch = getM2LaunchConfiguration(
    resolution,
    getM2WebviewProcessArgs(getM2StartupExpression(), getWebviewTopLevelMode()),
    workingDir,
    getM2LaunchArgs(),
  );
  const webviewLaunch = getM2WebviewPtyLaunch(
    launch.executablePath,
    launch.args,
  );

  // Spawn M2 directly (no shell) so signals like SIGINT reach the M2 process.
  // Previously we used a shell with `2>&1` which merged stderr/stdout but prevented
  // SIGINT from interrupting the actual M2 process. Listening to both stdout and
  // stderr separately preserves output while allowing interrupts to work.
  const child = spawn(webviewLaunch.executablePath, webviewLaunch.args, {
    cwd: launch.cwd,
  });
  proc = child;
  procInterruptWithInput = webviewLaunch.interruptWithInput === true;
  console.log("M2 process started (pid=", child.pid, ")");

  procWorkingDir = workingDir;

  child.stdout.on("data", (data) => {
    const output = data.toString();
    completePendingWebviewRunMarkers(output);
    if (g_panel) postM2OutputToWebview(output);
  });

  child.stderr.on("data", (data) => {
    // forward stderr as output too
    const output = data.toString();
    console.log("M2 stderr:", output);
    if (g_panel) postM2OutputToWebview(output, "stderr");
  });

  child.on("error", (err) => {
    console.error("M2 process error:", err);
    disposePendingWebviewRunMarkers();
    if (g_panel)
      g_panel.webview.postMessage({
        type: "output",
        data: `Error starting Macaulay2: ${err.message}`,
      });
    if (proc === child) proc = undefined;
    if (proc === undefined) procInterruptWithInput = false;
  });

  child.on("close", (code, signal) => {
    console.log("M2 process closed. code=", code, "signal=", signal);
    if (g_panel) g_panel.webview.postMessage({ type: "exit", code, signal });
    if (proc === child) proc = undefined;
    if (proc === undefined) procInterruptWithInput = false;
    disposePendingWebviewRunMarkers();
  });

  /*
  proc.on("close", (code) => { // not needed at the moment
    proc = undefined;
    g_panel.webview.postMessage({
      type: "exit",
      code,
    });
  });
   */
}

function completePendingWebviewRunMarkers(output: string) {
  if (pendingWebviewRunMarkers.size === 0) {
    return;
  }

  pendingWebviewRunMarkers.forEach((pending) => {
    if (outputHasSubmittedInput(output, pending.submittedText)) {
      pending.observedSubmittedInput = true;
    }
  });

  while (pendingWebviewRunMarkers.size > 0) {
    const next = pendingWebviewRunMarkers.entries().next().value as
      | [string, PendingRunMarker]
      | undefined;
    if (!next) {
      return;
    }
    const [markerId, pending] = next;
    if (
      !outputHasWebAppPromptAfterSubmittedInput(
        output,
        pending.submittedText,
        pending.observedSubmittedInput,
      )
    ) {
      return;
    }

    pending.marker.completed();
    pendingWebviewRunMarkers.delete(markerId);
  }
}

function completePendingTerminalRunMarkers(output: string) {
  if (pendingTerminalRunMarkers.size === 0) {
    return;
  }

  pendingTerminalRunMarkers.forEach((pending) => {
    if (outputHasSubmittedInput(output, pending.submittedText)) {
      pending.observedSubmittedInput = true;
    }
  });

  while (pendingTerminalRunMarkers.size > 0) {
    const next = pendingTerminalRunMarkers.entries().next().value as
      | [string, PendingRunMarker]
      | undefined;
    if (!next) {
      return;
    }
    const [markerId, pending] = next;
    if (
      !outputHasTerminalPromptAfterSubmittedInput(
        output,
        pending.submittedText,
        pending.observedSubmittedInput,
      )
    ) {
      return;
    }

    pending.marker.completed();
    pendingTerminalRunMarkers.delete(markerId);
  }
}

function disposePendingWebviewRunMarkers() {
  pendingWebviewRunMarkers.forEach((pending) => pending.marker.dispose());
  pendingWebviewRunMarkers.clear();
}

function disposePendingTerminalRunMarkers() {
  pendingTerminalRunMarkers.forEach((pending) => pending.marker.dispose());
  pendingTerminalRunMarkers.clear();
}

function postM2OutputToWebview(output: string, stream?: "stderr") {
  splitM2OutputForWebview(output).forEach((chunk) => {
    webviewOutputQueue.push({ data: chunk, stream });
  });
  drainWebviewOutputQueue();
}

function drainWebviewOutputQueue() {
  if (isDrainingWebviewOutput) {
    return;
  }

  isDrainingWebviewOutput = true;
  const drainNext = () => {
    if (!g_panel) {
      webviewOutputQueue.length = 0;
      isDrainingWebviewOutput = false;
      return;
    }

    if (webviewOutputQueue.length === 0) {
      isDrainingWebviewOutput = false;
      return;
    }

    const batchSize = webviewOutputQueue.length > 100 ? 10 : 1;
    const batch = webviewOutputQueue.splice(0, batchSize);
    batch.forEach((next) => {
      g_panel!.webview.postMessage({
        type: "output",
        data: next.data,
        stream: next.stream,
      });
    });
    setTimeout(drainNext, 16);
  };
  setTimeout(drainNext, 0);
}

function startREPLCommand() {
  startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
  if (proc === undefined) {
    // Create or show the webview panel
    if (g_panel === undefined) {
      const completionItems = g_getWebviewCompletionItems
        ? await g_getWebviewCompletionItems()
        : [];
      g_panel = vscode.window.createWebviewPanel(
        "macaulay2Output",
        "Macaulay2 Output",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: preserveFocus },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(g_context!.extensionUri, "media"),
          ],
        },
      );

      g_panel.webview.html = getWebviewContent(
        g_panel.webview,
        completionItems,
        !preserveFocus,
      );

      g_panel.webview.onDidReceiveMessage(handleWebviewMessage);

      g_panel.onDidDispose(() => {
        g_panel = undefined;
        if (proc) {
          proc.kill();
          proc = undefined;
        }
      });
    }
    startM2();
  }
}

async function executeCode(
  text: string,
  restoreEditorFocus = false,
  recordSubmittedInput = false,
): Promise<boolean> {
  const editorToRestore = restoreEditorFocus
    ? vscode.window.activeTextEditor
    : undefined;
  await startREPL(true);

  text = normalizeM2Input(text);
  if (proc && proc.stdin) {
    shouldRestoreEditorFocusAfterWebviewOutput = restoreEditorFocus;
    editorToRestoreAfterWebviewOutput = editorToRestore;
    if (recordSubmittedInput && g_panel) {
      await g_panel.webview.postMessage({
        type: "submittedInput",
        data: text,
      });
    }
    proc.stdin.write(text);
    return true;
  } else {
    vscode.window.showErrorMessage("Macaulay2 process is not running.");
    return false;
  }
}

function startTerminalCommand() {
  startM2Terminal(false);
}

export function getM2TerminalPtyLaunch(
  executablePath: string,
  args: string[],
): TerminalProcessLaunch {
  if (process.platform === "linux") {
    return {
      executablePath: "script",
      args: [
        "-qfec",
        [executablePath, ...args].map(shellQuote).join(" "),
        "/dev/null",
      ],
      echoesInput: true,
      interruptWithInput: true,
    };
  }

  return {
    executablePath,
    args,
    echoesInput: false,
    interruptWithInput: false,
  };
}

function toTerminalOutput(output: string): string {
  return output.replace(/\r?\n/g, "\r\n");
}

function startM2Terminal(preserveFocus: boolean): vscode.Terminal | undefined {
  if (g_terminal && !g_terminal.exitStatus) {
    g_terminal.show(preserveFocus);
    return g_terminal;
  }
  g_terminal = undefined;
  g_terminalProcess = undefined;

  const resolution = getM2ExecutableResolution();
  if (!resolution) {
    return undefined;
  }

  const workingDir = getM2WorkingDir();
  const launch = getM2LaunchConfiguration(
    resolution,
    getM2TerminalProcessArgs(getM2StartupExpression()),
    workingDir,
    getM2LaunchArgs(),
  );
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  const terminalLaunch = getM2TerminalPtyLaunch(
    launch.executablePath,
    launch.args,
  );
  let queuedInput = "";
  const outputQueue: string[] = [];
  let isDrainingOutput = false;

  const drainOutputQueue = () => {
    if (isDrainingOutput) {
      return;
    }

    isDrainingOutput = true;
    const drainBatch = () => {
      const batch = outputQueue.splice(0, 20).join("");
      if (batch.length > 0) {
        writeEmitter.fire(batch);
      }

      if (outputQueue.length > 0) {
        setTimeout(drainBatch, 0);
      } else {
        isDrainingOutput = false;
      }
    };
    setTimeout(drainBatch, 0);
  };

  const writeTerminalOutput = (output: string) => {
    const chunks = output.match(/[^\n]*\n|[^\n]+/g);
    if (!chunks) {
      return;
    }

    chunks.forEach((chunk) => outputQueue.push(toTerminalOutput(chunk)));
    drainOutputQueue();
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => {
      const child = spawn(terminalLaunch.executablePath, terminalLaunch.args, {
        cwd: launch.cwd,
      });
      g_terminalProcess = child;
      if (queuedInput.length > 0 && child.stdin) {
        child.stdin.write(queuedInput);
        queuedInput = "";
      }

      child.stdout.on("data", (data) => {
        const output = data.toString();
        completePendingTerminalRunMarkers(output);
        writeTerminalOutput(output);
      });

      child.stderr.on("data", (data) => {
        const output = data.toString();
        writeTerminalOutput(output);
      });

      child.on("error", (err) => {
        disposePendingTerminalRunMarkers();
        writeEmitter.fire(`Error starting Macaulay2: ${err.message}\r\n`);
        g_terminalProcess = undefined;
        closeEmitter.fire(1);
      });

      child.on("close", (code) => {
        disposePendingTerminalRunMarkers();
        g_terminalProcess = undefined;
        closeEmitter.fire(code || 0);
      });
    },
    close: () => {
      disposePendingTerminalRunMarkers();
      if (g_terminalProcess) {
        g_terminalProcess.kill();
        g_terminalProcess = undefined;
      }
    },
    handleInput: (data: string) => {
      if (!g_terminalProcess || !g_terminalProcess.stdin) {
        if (!terminalLaunch.echoesInput) writeEmitter.fire(toTerminalOutput(data));
        queuedInput += data.replace(/\r/g, "\n");
        return;
      }

      if (data === "\x03") {
        if (terminalLaunch.interruptWithInput) {
          g_terminalProcess.stdin.write(data);
        } else {
          writeEmitter.fire("^C\r\n");
          g_terminalProcess.kill("SIGINT");
        }
        return;
      }

      if (!terminalLaunch.echoesInput) writeEmitter.fire(toTerminalOutput(data));
      g_terminalProcess.stdin.write(data.replace(/\r/g, "\n"));
    },
  };
  g_terminal = vscode.window.createTerminal({
    name: "Macaulay2",
    pty,
  });
  g_terminal.show(preserveFocus);
  return g_terminal;
}

async function handleM2ExecutableChanged() {
  const restartActions: string[] = [];
  if (proc && g_panel) {
    restartActions.push("Restart REPL");
  }
  if (g_terminal && !g_terminal.exitStatus) {
    restartActions.push("Restart Terminal");
  }

  if (restartActions.length === 0) {
    vscode.window.showInformationMessage(
      "M2 executable updated. New M2 sessions will use the selected executable.",
    );
    return;
  }

  const selectedAction = await vscode.window.showInformationMessage(
    "M2 executable updated. Running M2 sessions keep their current executable until restarted.",
    ...restartActions,
  );

  if (selectedAction === "Restart REPL") {
    restartM2Process();
  } else if (selectedAction === "Restart Terminal") {
    restartM2Terminal();
  }
}

function restartM2Process() {
  if (!g_panel) {
    return;
  }

  if (!proc) {
    startM2();
    return;
  }

  const oldProc = proc;
  proc = undefined;
  oldProc.once("close", () => {
    if (g_panel) {
      startM2();
    }
  });
  oldProc.kill();
}

function restartM2Terminal() {
  if (g_terminal) {
    g_terminal.dispose();
    g_terminal = undefined;
  }
  startM2Terminal(false);
}

async function executeCodeInTerminal(text: string): Promise<boolean> {
  const terminal = startM2Terminal(true);
  if (!terminal) {
    return false;
  }

  text = normalizeM2Input(text);
  terminal.sendText(text, false);
  return true;
}

type SelectedM2Code = {
  editor: vscode.TextEditor;
  range: vscode.Range;
  text: string;
};

function getSelectedM2Code(): SelectedM2Code | undefined {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }

  var selection = editor.selection;
  const range = getSubmittedCodeRange(editor);
  return {
    editor,
    range,
    text: selection.isEmpty
      ? editor.document.lineAt(selection.start.line).text
      : editor.document.getText(selection),
  };
}

function executeSelectionInTerminal() {
  const code = getSelectedM2Code();
  if (code === undefined) {
    return;
  }
  if (isM2BlankOrCommentOnly(code.text)) {
    moveCursorDown();
    return;
  }

  const marker = new CodeRunStatusMarker(code.editor, code.range);
  const markerId = String(nextTerminalRunMarkerId++);
  marker.running();
  pendingTerminalRunMarkers.set(markerId, {
    marker,
    submittedText: normalizeM2Input(code.text),
    observedSubmittedInput: false,
  });
  executeCodeInTerminal(code.text).then((sent) => {
    if (!sent) {
      pendingTerminalRunMarkers.delete(markerId);
      marker.dispose();
    }
  });
  moveCursorDown();
}

async function executeSelectionInWebview() {
  const code = getSelectedM2Code();
  if (code === undefined) {
    return;
  }
  if (isM2BlankOrCommentOnly(code.text)) {
    moveCursorDown();
    return;
  }

  const marker = new CodeRunStatusMarker(code.editor, code.range);
  const markerId = String(nextWebviewRunMarkerId++);
  marker.running();
  pendingWebviewRunMarkers.set(markerId, {
    marker,
    submittedText: normalizeM2Input(code.text),
    observedSubmittedInput: false,
  });
  const sent = await executeCode(code.text, true, true);
  if (!sent) {
    pendingWebviewRunMarkers.delete(markerId);
    marker.dispose();
  }
  moveCursorDown();
}

function moveCursorDown() {
  vscode.commands.executeCommand("cursorMove", {
    to: "down",
    by: "line",
    value: 1,
  });
}

function getWebviewContent(
  webview: vscode.Webview,
  completionItems: WebviewCompletionItem[],
  focusInputOnLoad = true,
) {
  const extensionUri = g_context!.extensionUri;
  const htmlPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "webview.html",
  ).fsPath;
  let html = fs.readFileSync(htmlPath, "utf8");
  const colorTheme = getWebviewColorTheme();
  html = html.replace(
    '<html lang="en">',
    `<html lang="en" data-macaulay2-color-theme="${colorTheme}">`,
  );
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "main.js"),
  );
  html = html.replace("${scriptUri}", scriptUri.toString());
  const VGUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "VectorGraphics.js"),
  );
  html = html.replace("${VGUri}", VGUri.toString());
  const cssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "minimal.css"),
  );
  html = html.replace("${cssUri}", cssUri.toString());
  const completionItemsJson = JSON.stringify(completionItems).replace(
    /</g,
    "\\u003c",
  );
  const syntaxJson = JSON.stringify(getWebviewSyntax(extensionUri)).replace(
    /</g,
    "\\u003c",
  );
  const colorThemeJson = JSON.stringify(colorTheme);
  const focusInputOnLoadJson = JSON.stringify(focusInputOnLoad);
  const topLevelModeJson = JSON.stringify(getWebviewTopLevelMode());
  html = html.replace(
    "</head>",
    `<script>window.macaulay2CompletionItems = ${completionItemsJson}; window.macaulay2Syntax = ${syntaxJson}; window.macaulay2ColorTheme = ${colorThemeJson}; window.macaulay2FocusInputOnLoad = ${focusInputOnLoadJson}; window.macaulay2TopLevelMode = ${topLevelModeJson};</script>\n  </head>`,
  );
  return html;
}

function getHtmlTitle(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return fallback;

  return (
    match[1]
      .replace(/\s+/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .trim() || fallback
  );
}

function getWebviewSyntaxClass(
  scopeName: string,
): { className: WebviewSyntaxClass; priority: number } | undefined {
  if (scopeName.startsWith("keyword.operator.")) {
    return { className: "operator", priority: 5 };
  }
  if (scopeName.startsWith("keyword.")) {
    return { className: "keyword", priority: 4 };
  }
  if (scopeName.startsWith("entity.name.type.")) {
    return { className: "class-name", priority: 3 };
  }
  if (scopeName.startsWith("support.function.")) {
    return { className: "function", priority: 2 };
  }
  if (scopeName.startsWith("constant.language.")) {
    return { className: "constant", priority: 1 };
  }
}

function extractWordsFromTextMateMatch(match: string): string[] | undefined {
  const wordGroup = match.match(/\\b\(([^()]+)\)\\b$/);
  if (!wordGroup) return undefined;

  const words = wordGroup[1].split("|");
  if (!words.every((word) => /^[A-Za-z_]\w*$/.test(word))) return undefined;
  return words;
}

function getWebviewSyntax(extensionUri: vscode.Uri): WebviewSyntax {
  try {
    const grammarPath = vscode.Uri.joinPath(
      extensionUri,
      "syntaxes",
      "macaulay2.tmLanguage.json",
    ).fsPath;
    const grammar = JSON.parse(fs.readFileSync(grammarPath, "utf8"));
    const tokens: WebviewSyntaxToken[] = [];
    const patterns: WebviewSyntaxPattern[] = [];
    const patternGroups = [
      grammar.repository?.keywords?.patterns,
      grammar.repository?.support?.patterns,
    ];

    patternGroups.forEach((group) => {
      if (!Array.isArray(group)) return;
      group.forEach((pattern) => {
        if (
          typeof pattern?.name !== "string" ||
          typeof pattern?.match !== "string"
        )
          return;

        const tokenClass = getWebviewSyntaxClass(pattern.name);
        if (!tokenClass) return;

        const words = extractWordsFromTextMateMatch(pattern.match);
        if (words) {
          words.forEach((label) =>
            tokens.push({
              label,
              className: tokenClass.className,
              priority: tokenClass.priority,
            }),
          );
        } else {
          patterns.push({
            source: pattern.match,
            className: tokenClass.className,
          });
        }
      });
    });

    return { tokens, patterns };
  } catch (err) {
    console.warn("Could not load Macaulay2 TextMate grammar for webview", err);
    return { tokens: [], patterns: [] };
  }
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isAbsoluteUri(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value);
}

function splitFragment(value: string): { pathPart: string; fragment?: string } {
  const hashIndex = value.indexOf("#");
  if (hashIndex < 0) return { pathPart: value };

  return {
    pathPart: value.substring(0, hashIndex),
    fragment: value.substring(hashIndex + 1),
  };
}

function getMacaulay2DocRoot(filePath: string): string | undefined {
  const resolvedPath = path.resolve(filePath).replace(/\\/g, "/");
  const parts = resolvedPath.split("/");

  for (let i = 1; i < parts.length - 1; i++) {
    if (
      parts[i - 1] === "share" &&
      parts[i] === "doc" &&
      parts[i + 1] === "Macaulay2"
    ) {
      return parts.slice(0, i + 2).join("/") || path.parse(filePath).root;
    }
  }
}

function resolveHelpTarget(
  rawUrl: string,
  baseFilePath?: string,
): {
  filePath?: string;
  externalUri?: vscode.Uri;
  fragment?: string;
} {
  const trimmedUrl = (rawUrl || "").trim();
  if (!trimmedUrl) return {};
  const { pathPart, fragment } = splitFragment(trimmedUrl);

  if (isWindowsDrivePath(pathPart)) {
    return {
      filePath: path.normalize(pathPart),
      fragment,
    };
  }

  if (isAbsoluteUri(trimmedUrl)) {
    const uri = vscode.Uri.parse(trimmedUrl);
    if (uri.scheme === "file") {
      return {
        filePath: uri.fsPath,
        fragment: uri.fragment || undefined,
      };
    }

    return { externalUri: uri };
  }

  const baseDir = baseFilePath
    ? path.dirname(baseFilePath)
    : procWorkingDir || process.cwd();
  const filePath =
    pathPart.length === 0 && baseFilePath
      ? baseFilePath
      : path.resolve(baseDir, pathPart);

  return { filePath, fragment };
}

function getHelpLocalResourceRoots(filePath: string): vscode.Uri[] {
  const roots = new Set<string>();
  const fileDir = path.dirname(filePath);
  roots.add(fileDir);
  const docRoot = getMacaulay2DocRoot(filePath);
  if (docRoot) {
    roots.add(docRoot);
    const shareRoot = path.resolve(docRoot, "..", "..");
    const sharedMacaulay2Root = path.join(shareRoot, "Macaulay2");
    if (fs.existsSync(path.join(sharedMacaulay2Root, "Style"))) {
      roots.add(sharedMacaulay2Root);
    }
  }

  let currentDir = fileDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(currentDir, "Style"))) {
      roots.add(currentDir);
      break;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return Array.from(roots).map((root) => vscode.Uri.file(root));
}

function getHelpViewColumn(): vscode.ViewColumn {
  return (
    g_panel?.viewColumn ||
    vscode.window.activeTextEditor?.viewColumn ||
    vscode.ViewColumn.Active
  );
}

function getHelpWebviewContent(
  webview: vscode.Webview,
  filePath: string,
  fragment?: string,
): string {
  let html = fs.readFileSync(filePath, "utf8");
  const fileDir = path.dirname(filePath);
  const dirPath = fileDir.endsWith(path.sep) ? fileDir : fileDir + path.sep;
  const baseUri = webview.asWebviewUri(vscode.Uri.file(dirPath)).toString();
  const baseTag = `<base href="${escapeHtmlAttribute(baseUri)}">`;
  const navigationScript = `
<script>
(function() {
  const vscode = acquireVsCodeApi();
  const requestedFragment = ${JSON.stringify(fragment || "")};

  function findAnchor(target) {
    for (var el = target; el && el !== document; el = el.parentElement) {
      if (el.matches && el.matches("a[href]")) return el;
    }

    return null;
  }

  function scrollToFragment(fragment) {
    if (!fragment) return;

    var decodedFragment = decodeURIComponent(fragment);
    var target = document.getElementById(decodedFragment) || document.getElementsByName(decodedFragment)[0];
    if (target && target.scrollIntoView) target.scrollIntoView();
  }

  function openHelpLink(href) {
    if (!href || href.startsWith("javascript:")) return false;
    if (href.startsWith("#")) {
      scrollToFragment(href.substring(1));
      return true;
    }

    vscode.postMessage({ type: "openHelpLink", href: href });
    return true;
  }

  document.addEventListener("click", function(event) {
    var anchor = findAnchor(event.target);
    if (!anchor) return;

    var href = anchor.dataset.macaulay2HelpHref || anchor.getAttribute("href");
    if (!openHelpLink(href)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
  }, true);

  window.addEventListener("DOMContentLoaded", function() {
    Array.prototype.forEach.call(document.querySelectorAll("a[href]"), function(anchor) {
      var href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

      anchor.dataset.macaulay2HelpHref = href;
      anchor.setAttribute("href", "#");
    });

    scrollToFragment(requestedFragment);
  });
}());
</script>`;

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (headTag) => `${headTag}\n${baseTag}`);
  } else {
    html = `${baseTag}\n${html}`;
  }

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${navigationScript}\n</body>`);
  }

  return `${html}\n${navigationScript}`;
}

async function openHelpUrl(rawUrl: string, state?: HelpPanelState) {
  const target = resolveHelpTarget(rawUrl, state?.currentFilePath);
  if (target.externalUri) {
    await vscode.env.openExternal(target.externalUri);
    return;
  }

  if (!target.filePath) {
    vscode.window.showErrorMessage(
      `Could not resolve Macaulay2 help URL: ${rawUrl}`,
    );
    return;
  }

  const filePath = target.filePath;
  if (!fs.existsSync(filePath)) {
    vscode.window.showErrorMessage(
      `Macaulay2 help file does not exist: ${filePath}`,
    );
    return;
  }

  if (!/\.(html?|xhtml)$/i.test(filePath)) {
    await vscode.env.openExternal(vscode.Uri.file(filePath));
    return;
  }

  if (!getMacaulay2DocRoot(filePath)) {
    await vscode.window.showTextDocument(vscode.Uri.file(filePath), {
      preview: false,
      viewColumn: getHelpViewColumn(),
    });
    return;
  }

  const rawHtml = fs.readFileSync(filePath, "utf8");
  const title = getHtmlTitle(rawHtml, path.basename(filePath));
  const panelState = state || createHelpPanel(title, filePath);

  panelState.currentFilePath = filePath;
  panelState.panel.title = title;
  panelState.panel.webview.options = {
    ...panelState.panel.webview.options,
    localResourceRoots: getHelpLocalResourceRoots(filePath),
  };
  panelState.panel.webview.html = getHelpWebviewContent(
    panelState.panel.webview,
    filePath,
    target.fragment,
  );
  panelState.panel.reveal(panelState.panel.viewColumn || getHelpViewColumn());
}

function reportHelpOpenError(error: any) {
  console.error("Failed to open Macaulay2 help:", error);
  const message = error instanceof Error ? error.message : String(error);
  vscode.window.showErrorMessage(`Failed to open Macaulay2 help: ${message}`);
}

function createHelpPanel(title: string, filePath: string): HelpPanelState {
  const panel = vscode.window.createWebviewPanel(
    "macaulay2Help",
    title,
    getHelpViewColumn(),
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: getHelpLocalResourceRoots(filePath),
    },
  );
  const state = { panel, currentFilePath: filePath };

  panel.webview.onDidReceiveMessage((message) => {
    if (message.type === "openHelpLink") {
      openHelpUrl(message.href, state).catch(reportHelpOpenError);
    }
  });
  panel.onDidDispose(() => helpPanels.delete(state));
  helpPanels.add(state);

  return state;
}

function parseVSCodeFragment(pathWithFragment: string): {
  path: string;
  start?: { line: number; column: number };
  end?: { line: number; column: number };
} {
  const re = /^(.*?)(?:#\D*(\d+)(?::\D*(\d+))?(?:-\D*(\d+)(?::\D*(\d+))?)?)?$/;
  const m = pathWithFragment.match(re);
  if (!m) return { path: pathWithFragment };

  const [, path, line1, col1, line2, col2] = m;
  let result: {
    path: string;
    start?: { line: number; column: number };
    end?: { line: number; column: number };
  } = { path };

  if (line1)
    result.start = {
      line: parseInt(line1) - 1,
      column: col1 ? parseInt(col1) : 0,
    }; // TODO check shifts by 1
  if (line2)
    result.end = {
      line: parseInt(line2) - 1,
      column: col2 ? parseInt(col2) : 0,
    };
  return result;
}

function interruptM2() {
  console.log("interrupt");
  if (
    g_terminal &&
    !g_terminal.exitStatus &&
    (vscode.window.activeTerminal === g_terminal || !proc)
  ) {
    disposePendingTerminalRunMarkers();
    g_terminal.sendText("\x03", false);
    return;
  }

  if (!proc) return;
  disposePendingWebviewRunMarkers();

  try {
    // Best-effort: send SIGINT to the child process so it can interrupt computations.
    if (procInterruptWithInput && proc.stdin) {
      proc.stdin.write("\x03");
    } else {
      proc.kill("SIGINT");
    }
  } catch (e) {
    console.error("Failed to send SIGINT to M2 process:", e);
    // On Windows, proc.kill('SIGINT') may not work. Attempt taskkill as a fallback.
    if (process.platform === "win32" && proc.pid) {
      try {
        const killer = spawn("taskkill", [
          "/PID",
          String(proc.pid),
          "/T",
          "/F",
        ]);
        killer.on("close", () => {
          console.log("taskkill executed for pid", proc!.pid);
        });
      } catch (ee) {
        console.error("taskkill fallback failed:", ee);
      }
    }
  }
}

function handleWebviewMessage(message: any) {
  switch (message.type) {
    case "input":
      executeCode(message.data);
      break;
    case "reset":
      console.log("reset");
      if (proc) proc.kill();
      procWorkingDir = undefined; // Reset working directory
      startM2();
      break;
    case "interrupt":
      interruptM2();
      break;
    case "paste":
      vscode.env.clipboard.readText().then(
        (text) => {
          if (g_panel)
            g_panel.webview.postMessage({ type: "paste", data: text });
        },
        (err) => console.error("Failed to read clipboard:", err),
      );
      break;
    case "open":
      console.log("open " + message.data);
      // fix relative path: relative to where M2 was started
      const { path: relPath, start, end } = parseVSCodeFragment(message.data);
      let selection;
      if (start && end) {
        selection = new vscode.Range(
          start.line,
          start.column,
          end.line,
          end.column,
        );
      } else if (start) {
        selection = new vscode.Range(
          start.line,
          start.column,
          start.line,
          start.column,
        );
      }
      const absPath = path.resolve(procWorkingDir!, relPath);
      const fileUri = vscode.Uri.file(absPath);
      vscode.window.showTextDocument(fileUri, {
        preview: false,
        selection,
        viewColumn: vscode.ViewColumn.One,
      });
      break;
    case "openHelp":
      console.log("open help " + message.data);
      openHelpUrl(message.data).catch(reportHelpOpenError);
      break;
    case "focus":
      if (!shouldRestoreEditorFocusAfterWebviewOutput) {
        break;
      }
      shouldRestoreEditorFocusAfterWebviewOutput = false;
      const editor = editorToRestoreAfterWebviewOutput;
      editorToRestoreAfterWebviewOutput = undefined;
      if (editor)
        vscode.window.showTextDocument(
          editor!.document,
          editor!.viewColumn,
          false,
        ); // restore focus
      break;
  }
}

export function activate(
  context: vscode.ExtensionContext,
  getWebviewCompletionItems?: () => Promise<WebviewCompletionItem[]>,
) {
  g_context = context;
  g_getWebviewCompletionItems = getWebviewCompletionItems;

  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.startREPL", startREPLCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.startTerminal",
      startTerminalCommand,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendToREPL",
      executeSelectionInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendToWebview",
      executeSelectionInWebview,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "macaulay2.sendToTerminal",
      executeSelectionInTerminal,
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.interruptREPL", interruptM2),
  );
  registerM2ExecutableSwitcher(context, handleM2ExecutableChanged);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("macaulay2.webviewColorTheme")) {
        postWebviewSettings();
      }
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      if (terminal === g_terminal) {
        g_terminal = undefined;
      }
    }),
  );
}

export function deactivate() {
  if (proc) {
    proc.kill();
    proc = undefined;
  }
  if (g_terminal) {
    g_terminal.dispose();
    g_terminal = undefined;
  }
}
