# Macaulay2 README

This extension provides support for the Macaulay2 language in Visual Studio Code.

## Features

- A language grammar (and syntax highlighting)
  ![syntax highlighting](https://user-images.githubusercontent.com/186528/54696704-990e3480-4b2c-11e9-9376-3106aa64d618.png)

- Code completion with IntelliSense

- An integrated webview REPL. The default `macaulay2.webviewTopLevelMode` is `webview`, which starts Macaulay2 with `topLevelMode = WebApp`; set it to `standard` to use `topLevelMode = Standard` in the same VS Code webview.

- Optional terminal-backed evaluation. Run `Macaulay2: Start M2 Terminal` or `Macaulay2: Send code to Macaulay2 Terminal` to use a real VS Code terminal, or set `macaulay2.replTarget` to `terminal` so the normal start/send commands and keybindings target the terminal.

- Automatic Macaulay2 executable detection on macOS and Windows, with an optional manual override via `macaulay2.executablePath`

- Optional executable switcher. Set `macaulay2.showExecutableSwitcher` to `true` and add paths to `macaulay2.executablePathAlternatives` to show a status bar button for switching between M2 binaries.

## Requirements

You need a working installation of Macaulay2. The extension now tries to find the `M2` executable automatically:

- On macOS it checks the current environment, your login shell, and common Homebrew locations.
- On Windows it checks the current environment, Cygwin's own shell, and common Cygwin install locations.

If detection fails, you can still set `macaulay2.executablePath` manually.
