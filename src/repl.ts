
import * as vscode from "vscode";

let g_context: vscode.ExtensionContext | undefined;
let g_terminal: vscode.Terminal | undefined;

function startREPLCommand(context: vscode.ExtensionContext) {
    startREPL(false);
}

async function startREPL(preserveFocus: boolean) {
    if (g_terminal === undefined) {
        let exepath = vscode.workspace.getConfiguration("macaulay2").get<string>("executablePath");
        g_terminal = vscode.window.createTerminal({
            name: "macaulay2",
            shellPath: exepath,
            shellArgs: [],
            env: {}
        });
    }
    g_terminal.show(preserveFocus);
}

async function executeCode(text: string) {
    if (!text.endsWith("\n")) {
        text = text + '\n';
    }

    await startREPL(true);
    g_terminal!.show(true);
    var lines = text.split(/\r?\n/);
    lines = lines.filter(line => line !== '');
    text = lines.join('\n');
    // if (process.platform === "win32") {
        // g_terminal!.sendText(text + '\n', false);
    // }
    // else {
        // g_terminal!.sendText('\u001B[200~' + text + '\n' + '\u001B[201~', false);
        // g_terminal!.sendText('\u001B[200~' + text + '\n' + '\u001B[201~', false);
    // }
    g_terminal!.sendText(text + '\n', false);
}

function executeSelection() {
    var editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }

    var selection = editor.selection;
    var text = selection.isEmpty ? editor.document.lineAt(selection.start.line).text : editor.document.getText(selection);

    // If no text was selected, try to move the cursor to the end of the next line
    if (selection.isEmpty) {
        for (var line = selection.start.line + 1; line < editor.document.lineCount; line++) {
            if (!editor.document.lineAt(line).isEmptyOrWhitespace) {
                var newPos = selection.active.with(line, editor.document.lineAt(line).range.end.character);
                var newSel = new vscode.Selection(newPos, newPos);
                editor.selection = newSel;
                break;
            }
        }
    }
    executeCode(text);
}

export function activate(context: vscode.ExtensionContext) {
    g_context = context;

    context.subscriptions.push(vscode.commands.registerCommand('macaulay2.startREPL', startREPLCommand));
    context.subscriptions.push(vscode.commands.registerCommand('macaulay2.sendToREPL', executeSelection));

    vscode.window.onDidCloseTerminal(terminal => {
        if (terminal === g_terminal) {
            g_terminal = undefined;
        }
    });
}