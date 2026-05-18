# Macaulay2 for Visual Studio Code

This extension adds language support for [Macaulay2](https://macaulay2.com/) to Visual Studio Code. It is intended for editing `.m2` files and running Macaulay2 interactively without leaving the editor.

## Features

- Syntax highlighting for Macaulay2 source files and fenced Macaulay2 code blocks in Markdown.
- Completion suggestions for Macaulay2 symbols, functions, constants, and keywords.
- Language configuration for comments, brackets, quotes, and surrounding pairs.
- An integrated Macaulay2 REPL in a VS Code webview.
- Terminal-backed evaluation in a standard VS Code terminal through a separate command/keybinding.
- Automatic `M2` executable detection on macOS and Windows, including WSL installs on Windows, with a manual override when needed.

![Syntax highlighting](https://user-images.githubusercontent.com/186528/54696704-990e3480-4b2c-11e9-9376-3106aa64d618.png)

## Getting Started

Install Macaulay2 first, then open a `.m2` file in VS Code. The extension will try to find the `M2` executable automatically.

Use `F12` or run **Macaulay2: Start M2 REPL** from the Command Palette to start the webview REPL. Use `Shift+Enter` to send the current selection, or the current line when nothing is selected, to the webview REPL. Use `Ctrl+Enter` to send the same text to a Macaulay2 terminal session instead. Both send commands are also available from the right-click editor menu in `.m2` files and can be rebound in VS Code Keyboard Shortcuts.

- Optional executable switcher. Set `macaulay2.showExecutableSwitcher` to `true` and add paths to `macaulay2.executablePathAlternatives` to show a status bar button for switching between M2 binaries.

## Requirements
If the extension cannot find Macaulay2, set `macaulay2.executablePath` to the full path of your `M2` executable. On Windows, leaving this empty also checks WSL for `M2`; a WSL path such as `/usr/bin/M2` can be used as the manual path when needed.

## Commands

| Command | Description |
| --- | --- |
| `Macaulay2: Start M2 REPL` | Start the integrated webview REPL. |
| `Macaulay2: Send Line or Selection to Macaulay2 Webview` | Send the current selection or line directly to the webview REPL. |
| `Macaulay2: Start M2 Terminal` | Start Macaulay2 in a VS Code terminal. |
| `Macaulay2: Send Line or Selection to Macaulay2 Terminal` | Send the current selection or line directly to the terminal REPL. |
| `Macaulay2: Interrupt M2 Computation` | Interrupt the running Macaulay2 computation. |

## Default Keybindings

| Keybinding | Command |
| --- | --- |
| `Shift+Enter` | Send the current selection or line to the webview REPL. |
| `Ctrl+Enter` | Send the current selection or line to the terminal REPL. |

There is no REPL target setting. To change where evaluation goes by default, rebind these explicit webview and terminal commands in VS Code Keyboard Shortcuts.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `macaulay2.executablePath` | `""` | Optional path to the `M2` executable. Leave empty to auto-detect. |
| `macaulay2.launchArgs` | `""` | Additional command-line arguments passed to `M2` when starting REPL sessions, for example `--print-width 50`. |
| `macaulay2.webviewColorTheme` | `vscode` | Choose the webview REPL color theme: `classic`, `light`, `dark`, or `vscode`. |
| `macaulay2.webviewTopLevelMode` | `webapp` | Choose the webview REPL top-level output mode: `webapp` or `standard`. |
| `macaulay2.interruptOnControlC` | `true` | Enable `Ctrl+C` as a webview interrupt shortcut on macOS. |

## Requirements

A working Macaulay2 installation is required for the REPL and code evaluation features. Editing support, syntax highlighting, and completions work when the extension is installed, but running code requires `M2`.

## Acknowledgements 

This package was developed by John Cobb, Paul Zinn-Justin, and Mike Stillman, and was built off of Corey Harris's version.
