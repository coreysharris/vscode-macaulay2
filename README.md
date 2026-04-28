# Macaulay2 README

This extension provides support for the Macaulay2 language in Visual Studio Code.

## Features

- A language grammar (and syntax highlighting)
![syntax highlighting](https://user-images.githubusercontent.com/186528/54696704-990e3480-4b2c-11e9-9376-3106aa64d618.png)

- Code completion with IntelliSense

- An integrated REPL

- Automatic Macaulay2 executable detection on macOS and Windows, with an optional manual override via `macaulay2.executablePath`

## Requirements

You need a working installation of Macaulay2. The extension now tries to find the `M2` executable automatically:

- On macOS it checks the current environment, your login shell, and common Homebrew locations.
- On Windows it checks the current environment, Cygwin's own shell, and common Cygwin install locations.

If detection fails, you can still set `macaulay2.executablePath` manually.

## Codespaces

This repository now includes a devcontainer for GitHub Codespaces. Opening the repo in a codespace provisions Macaulay2 inside the container and runs `npm install`, so testing the extension with `F5` should find `M2` without any manual path setting.
