import * as vscode from "vscode";

export type CodeRunState = "waiting" | "running" | "completed";

const runningDelayMs = 120;
const completedDelayMs = 900;
const disposeDelayMs = 3500;

export function getCodeRunStatusText(state: CodeRunState): string {
  switch (state) {
    case "waiting":
      return "  M2 waiting";
    case "running":
      return "  M2 running";
    case "completed":
      return "  M2 completed";
  }
}

function getCodeRunStatusColor(state: CodeRunState): vscode.ThemeColor {
  switch (state) {
    case "waiting":
      return new vscode.ThemeColor("charts.yellow");
    case "running":
      return new vscode.ThemeColor("charts.blue");
    case "completed":
      return new vscode.ThemeColor("charts.green");
  }
}

export function getSubmittedCodeRange(editor: vscode.TextEditor): vscode.Range {
  const selection = editor.selection;
  if (!selection.isEmpty) {
    return selection;
  }

  return editor.document.lineAt(selection.start.line).range;
}

export class CodeRunStatusMarker {
  private decorationType: vscode.TextEditorDecorationType | undefined;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly editor: vscode.TextEditor,
    private readonly range: vscode.Range,
  ) {
    this.setState("waiting");
  }

  running() {
    this.setState("running");
  }

  completed() {
    this.setState("completed");
    this.timers.push(setTimeout(() => this.dispose(), disposeDelayMs));
  }

  runWithApproximateCompletion() {
    this.timers.push(setTimeout(() => this.running(), runningDelayMs));
    this.timers.push(setTimeout(() => this.completed(), completedDelayMs));
  }

  dispose() {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.length = 0;
    if (this.decorationType) {
      this.editor.setDecorations(this.decorationType, []);
      this.decorationType.dispose();
      this.decorationType = undefined;
    }
  }

  private setState(state: CodeRunState) {
    if (this.decorationType) {
      this.editor.setDecorations(this.decorationType, []);
      this.decorationType.dispose();
    }

    const color = getCodeRunStatusColor(state);
    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      after: {
        margin: "0 0 0 1.2em",
        color,
        fontStyle: "italic",
        contentText: getCodeRunStatusText(state),
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.editor.setDecorations(this.decorationType, [this.range]);
  }
}
