import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { spawn, ChildProcess } from "child_process";
import { getWebviewCompletionItems } from "./completionProviders";
import { resolveM2Executable } from "./executablePath";

let g_context: vscode.ExtensionContext | undefined;
let g_panel: vscode.WebviewPanel | undefined;
let proc: ChildProcess | undefined;
let procWorkingDir: string | undefined;

type WebviewTopLevelMode = "webview" | "standard";

type HelpPanelState = {
  panel: vscode.WebviewPanel;
  currentFilePath: string;
};

const helpPanels = new Set<HelpPanelState>();

// In WebApp mode, some help pages fail while processing example output.
// Keep native help where it works, and fall back to the top documentation node.
function getM2StartupPatch(): string {
  return [
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

function getWebviewTopLevelMode(): WebviewTopLevelMode {
  const configuredMode = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("webviewTopLevelMode", "webview");
  return configuredMode === "standard" ? "standard" : "webview";
}

function getM2TopLevelMode(): "WebApp" | "Standard" {
  return getWebviewTopLevelMode() === "standard" ? "Standard" : "WebApp";
}

function getM2StartupExpression(): string {
  return [`topLevelMode = ${getM2TopLevelMode()};`, getM2StartupPatch()].join(
    " ",
  );
}

function startM2() {
  const configuredPath = vscode.workspace
    .getConfiguration("macaulay2")
    .get<string>("executablePath");
  const resolution = resolveM2Executable(configuredPath);
  if (!resolution) {
    const action = "Open Settings";
    vscode.window
      .showErrorMessage(
        "Could not locate the Macaulay2 executable automatically. Install Macaulay2 so the M2 command is available, or set 'macaulay2.executablePath' manually.",
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
    return;
  }
  const exepath = resolution.executablePath;
  console.log(`Using M2 executable from ${resolution.source}: ${exepath}`);

  // Determine the working directory for Macaulay2
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

  // Spawn M2 directly (no shell) so signals like SIGINT reach the M2 process.
  // Previously we used a shell with `2>&1` which merged stderr/stdout but prevented
  // SIGINT from interrupting the actual M2 process. Listening to both stdout and
  // stderr separately preserves output while allowing interrupts to work.
  proc = spawn(exepath, ["--webapp", "-e", getM2StartupExpression()], {
    cwd: workingDir,
  });
  console.log("M2 process started (pid=", proc.pid, ")");

  procWorkingDir = workingDir;

  proc.stdout.on("data", (data) => {
    if (g_panel)
      g_panel.webview.postMessage({ type: "output", data: data.toString() });
  });

  proc.stderr.on("data", (data) => {
    // forward stderr as output too
    console.log("M2 stderr:", data.toString());
    if (g_panel)
      g_panel.webview.postMessage({
        type: "output",
        data: data.toString(),
        stream: "stderr",
      });
  });

  proc.on("error", (err) => {
    console.error("M2 process error:", err);
    if (g_panel)
      g_panel.webview.postMessage({
        type: "output",
        data: `Error starting Macaulay2: ${err.message}`,
      });
    proc = undefined;
  });

  proc.on("close", (code, signal) => {
    console.log("M2 process closed. code=", code, "signal=", signal);
    if (g_panel) g_panel.webview.postMessage({ type: "exit", code, signal });
    proc = undefined;
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

function startREPLCommand(context: vscode.ExtensionContext) {
  startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
  if (proc === undefined) {
    // Create or show the webview panel
    if (g_panel === undefined) {
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

      g_panel.webview.html = getWebviewContent(g_panel.webview);

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

async function executeCode(text: string) {
  await startREPL(true);

  // TODO: remove this ... (make sure stuff copied from editor has \n) and fix ctrl-C
  // Filter out empty lines and send to terminal
  var lines = text.split(/\r?\n/);
  lines = lines.filter((line) => line !== "");
  text = lines.join("\n");

  if (!text.endsWith("\n")) {
    text = text + "\n";
  }
  // ... until here
  if (proc && proc.stdin) {
    proc.stdin.write(text);
  } else {
    vscode.window.showErrorMessage("Macaulay2 process is not running.");
  }
}

function executeSelection() {
  var editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  var selection = editor.selection;
  var text = selection.isEmpty
    ? editor.document.lineAt(selection.start.line).text
    : editor.document.getText(selection);

  executeCode(text);
  // Move the cursor to the next line
  vscode.commands.executeCommand("cursorMove", {
    to: "down",
    by: "line",
    value: 1,
  });
}

function getWebviewContent(webview: vscode.Webview) {
  const extensionUri = g_context!.extensionUri;
  const htmlPath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "webview.html",
  ).fsPath;
  let html = fs.readFileSync(htmlPath, "utf8");
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
  const completionItemsJson = JSON.stringify(getWebviewCompletionItems()).replace(
    /</g,
    "\\u003c",
  );
  html = html.replace(
    "</head>",
    `<script>window.macaulay2CompletionItems = ${completionItemsJson};</script>\n  </head>`,
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
  if (!proc) return;

  try {
    // Best-effort: send SIGINT to the child process so it can interrupt computations.
    proc.kill("SIGINT");
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
      const editor = vscode.window.activeTextEditor;
      if (editor)
        vscode.window.showTextDocument(
          editor!.document,
          editor!.viewColumn,
          false,
        ); // restore focus
      break;
  }
}

export function activate(context: vscode.ExtensionContext) {
  g_context = context;

  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.startREPL", startREPLCommand),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.sendToREPL", executeSelection),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("macaulay2.interruptREPL", interruptM2),
  );
}

export function deactivate() {
  if (proc) {
    proc.kill();
    proc = undefined;
  }
}
