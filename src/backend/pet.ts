import * as vscode from "vscode";

type PetMood = "happy" | "content" | "sad";

const happyIdleMs = 8000;
const sadIdleMs = 20000;
const petLevelKey = "macaulay2.pet.level";
const petWordsTowardNextLevelKey = "macaulay2.pet.wordsTowardNextLevel";

function isMacaulay2Editor(editor: vscode.TextEditor | undefined): boolean {
  return editor?.document.languageId === "macaulay2";
}

function isPetEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("macaulay2")
    .get<boolean>("enablePet", true);
}

export function getPetMood(idleMs: number): PetMood {
  if (idleMs < happyIdleMs) return "happy";
  if (idleMs < sadIdleMs) return "content";
  return "sad";
}

export type PetProgress = {
  level: number;
  wordsTowardNextLevel: number;
};

export function applyWordsToPetProgress(
  progress: PetProgress,
  wordCount: number,
): PetProgress {
  let level = Math.max(1, Math.floor(progress.level));
  let wordsTowardNextLevel = Math.max(
    0,
    Math.floor(progress.wordsTowardNextLevel + wordCount),
  );

  while (wordsTowardNextLevel >= Math.pow(10, level)) {
    wordsTowardNextLevel -= Math.pow(10, level);
    level++;
  }

  return { level, wordsTowardNextLevel };
}

function countWords(text: string): number {
  return text.match(/[A-Za-z0-9_']+/g)?.length || 0;
}

function getPetText(mood: PetMood, level: number): string {
  switch (mood) {
    case "happy":
      return `  (^_^) lvl ${level}`;
    case "content":
      return `  (._.) lvl ${level}`;
    case "sad":
      return `  (;_;) lvl ${level}`;
  }
}

export function activate(context: vscode.ExtensionContext) {
  let lastActivityAt = Date.now();
  let lastDecoratedEditor: vscode.TextEditor | undefined;
  let petProgress: PetProgress = {
    level: context.globalState.get<number>(petLevelKey, 1),
    wordsTowardNextLevel: context.globalState.get<number>(
      petWordsTowardNextLevelKey,
      0,
    ),
  };

  const decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 1.2em",
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "italic",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  function clearPet() {
    if (lastDecoratedEditor) {
      lastDecoratedEditor.setDecorations(decorationType, []);
      lastDecoratedEditor = undefined;
    }
  }

  function updatePet() {
    const editor = vscode.window.activeTextEditor;
    if (!isPetEnabled() || !isMacaulay2Editor(editor)) {
      clearPet();
      return;
    }

    if (lastDecoratedEditor && lastDecoratedEditor !== editor) {
      lastDecoratedEditor.setDecorations(decorationType, []);
    }

    const line = editor.selection.active.line;
    if (line >= editor.document.lineCount) {
      clearPet();
      return;
    }

    const lineEnd = editor.document.lineAt(line).range.end;
    const mood = getPetMood(Date.now() - lastActivityAt);
    editor.setDecorations(decorationType, [
      {
        range: new vscode.Range(lineEnd, lineEnd),
        renderOptions: {
          after: {
            contentText: getPetText(mood, petProgress.level),
          },
        },
      },
    ]);
    lastDecoratedEditor = editor;
  }

  context.subscriptions.push(decorationType);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updatePet()),
    vscode.window.onDidChangeTextEditorSelection(() => updatePet()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.activeTextEditor;
      if (
        isPetEnabled() &&
        isMacaulay2Editor(editor) &&
        event.document === editor?.document
      ) {
        const typedWords = event.contentChanges.reduce(
          (total, change) => total + countWords(change.text),
          0,
        );
        if (typedWords > 0) {
          petProgress = applyWordsToPetProgress(petProgress, typedWords);
          void context.globalState.update(petLevelKey, petProgress.level);
          void context.globalState.update(
            petWordsTowardNextLevelKey,
            petProgress.wordsTowardNextLevel,
          );
        }
        lastActivityAt = Date.now();
        updatePet();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("macaulay2.enablePet")) {
        updatePet();
      }
    }),
    {
      dispose: () => clearInterval(idleTimer),
    },
  );

  const idleTimer = setInterval(updatePet, 1000);
  updatePet();
}
