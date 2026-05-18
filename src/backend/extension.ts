// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
"use strict";

import * as vscode from "vscode";
import * as pet from "./pet";
import * as repl from "./repl";
import hljs from "highlight.js/lib/core";
import hljsM2 from "highlightjs-macaulay2";

hljs.registerLanguage("macaulay2", hljsM2);

type CompletionProviderModule = typeof import("./completionProviders");

function isMacaulay2Document(document: vscode.TextDocument): boolean {
  return document.languageId === "macaulay2";
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "macaulay2" is now active!');

  let completionsModule: Promise<CompletionProviderModule> | undefined;
  let completionsActivated = false;
  let activateCompletionsPromise: Promise<void> | undefined;
  const loadCompletions = () => {
    if (!completionsModule) {
      completionsModule = import("./completionProviders");
    }
    return completionsModule;
  };

  const activateCompletions = () => {
    if (completionsActivated) {
      return Promise.resolve();
    }

    if (!activateCompletionsPromise) {
      activateCompletionsPromise = loadCompletions().then((completions) => {
        completions.activate(context);
        completionsActivated = true;
      });
    }
    return activateCompletionsPromise;
  };

  const getWebviewCompletionItems = async () => {
    await activateCompletions();
    const completions = await loadCompletions();
    return completions.getWebviewCompletionItems();
  };

  if (vscode.workspace.textDocuments.some(isMacaulay2Document)) {
    void activateCompletions();
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isMacaulay2Document(document)) {
        void activateCompletions();
      }
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && isMacaulay2Document(editor.document)) {
        void activateCompletions();
      }
    }),
  );

  repl.activate(context, getWebviewCompletionItems);
  pet.activate(context);

  return {
    // markdown-it plugin to highlight m2 code in markdown previews
    extendMarkdownIt(md: any) {
      const highlight = md.options.highlight;
      md.options.highlight = (code, lang) => {
        if (lang && ["m2", "macaulay2"].includes(lang.toLowerCase())) {
          return hljs.highlight(code, {
            language: lang,
            ignoreIllegals: true,
          }).value;
        } else {
          return highlight(code, lang);
        }
      };
      return md;
    },
  };
}

// this method is called when your extension is deactivated
export function deactivate() {
  repl.deactivate();
}
