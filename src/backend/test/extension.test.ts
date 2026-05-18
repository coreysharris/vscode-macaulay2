//
// Note: This example test is leveraging the Mocha test framework.
// Please refer to their documentation on https://mochajs.org/ for help.
//

// The module 'assert' provides assertion methods from node
import * as assert from "assert";

import {
  formatM2ExecutablePathForStatusBar,
  getM2ExecutablePathOptions,
  getM2ExecutableStatusText,
} from "../executableSwitcher";
import {
  getM2LaunchConfiguration,
  normalizeM2LaunchArgs,
  windowsPathToWslPath,
} from "../executablePath";
import {
  getM2StartupPatch,
  getM2TerminalProcessArgs,
  getM2WebviewProcessArgs,
} from "../repl";

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
// import * as vscode from 'vscode';
// import * as myExtension from '../extension';

// Defines a Mocha test suite to group tests of similar kind together
suite("Extension Tests", function () {
  // Defines a Mocha unit test
  test("Something 1", function () {
    assert.equal(-1, [1, 2, 3].indexOf(5));
    assert.equal(-1, [1, 2, 3].indexOf(0));
  });
});

suite("Executable Switcher", function () {
  test("keeps the current executable first and removes duplicates", function () {
    assert.deepEqual(
      getM2ExecutablePathOptions("/opt/m2/bin/M2", [
        "/usr/local/bin/M2",
        "/opt/m2/bin/M2",
        "  ",
      ]),
      ["/opt/m2/bin/M2", "/usr/local/bin/M2"],
    );
  });

  test("formats compact labels for bin directories", function () {
    assert.equal(
      formatM2ExecutablePathForStatusBar("/Applications/Macaulay2-1.26/bin/M2"),
      "Macaulay2-1.26/bin/M2",
    );
  });

  test("shows when auto-detection cannot find M2", function () {
    assert.equal(
      getM2ExecutableStatusText(undefined, undefined),
      "$(terminal) M2: not found",
    );
  });

  test("shows WSL auto-detection compactly", function () {
    assert.equal(
      getM2ExecutableStatusText(undefined, {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        source: "WSL",
        wslExecutablePath: "/usr/bin/M2",
      }),
      "$(terminal) M2 auto: WSL:/usr/bin/M2",
    );
  });

  test("shows WSL manual executable compactly", function () {
    assert.equal(
      getM2ExecutableStatusText("/usr/bin/M2", {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        source: "setting via WSL",
        wslExecutablePath: "/usr/bin/M2",
      }),
      "$(terminal) M2: WSL:/usr/bin/M2",
    );
  });
});

suite("Executable Launch", function () {
  test("patches method function code output for WebApp mode", function () {
    const patch = getM2StartupPatch();

    assert.notEqual(patch.indexOf("html FilePosition := p ->"), -1);
    assert.notEqual(
      patch.indexOf("code MethodFunctionWithOptions := f ->"),
      -1,
    );
    assert.notEqual(patch.indexOf("if #m > 0 then code m"), -1);
  });

  test("builds webview process args for WebApp output", function () {
    assert.deepEqual(getM2WebviewProcessArgs("startupPatch"), [
      "--webapp",
      "-e",
      "startupPatch",
    ]);
  });

  test("builds terminal process args with extension startup patch", function () {
    assert.deepEqual(getM2TerminalProcessArgs("startupPatch"), [
      "-e",
      "startupPatch",
    ]);
  });

  test("normalizes configured M2 launch arguments", function () {
    assert.deepEqual(
      normalizeM2LaunchArgs(" --silent   --print-width 120 "),
      ["--silent", "--print-width", "120"],
    );
    assert.deepEqual(normalizeM2LaunchArgs(""), []);
    assert.deepEqual(normalizeM2LaunchArgs("--print-width 50"), [
      "--print-width",
      "50",
    ]);
    assert.deepEqual(
      normalizeM2LaunchArgs("--prefix '/tmp/Macaulay2 Prefix'"),
      ["--prefix", "/tmp/Macaulay2 Prefix"],
    );
  });

  test("converts Windows drive paths to WSL mount paths", function () {
    assert.equal(
      windowsPathToWslPath("C:\\Users\\Admin\\m2-project"),
      "/mnt/c/Users/Admin/m2-project",
    );
    assert.equal(
      windowsPathToWslPath("D:/Macaulay2 Work"),
      "/mnt/d/Macaulay2 Work",
    );
  });

  test("builds a native M2 launch configuration", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        { executablePath: "/usr/local/bin/M2", source: "PATH" },
        ["--webapp"],
        "/Users/admin/project",
      ),
      {
        executablePath: "/usr/local/bin/M2",
        args: ["--webapp"],
        cwd: "/Users/admin/project",
      },
    );
  });

  test("adds configured launch arguments after built-in M2 args", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        { executablePath: "/usr/local/bin/M2", source: "PATH" },
        ["--webapp"],
        "/Users/admin/project",
        "--print-width 50",
      ),
      {
        executablePath: "/usr/local/bin/M2",
        args: ["--webapp", "--print-width", "50"],
        cwd: "/Users/admin/project",
      },
    );
  });

  test("builds a WSL M2 launch configuration", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        {
          executablePath: "C:\\Windows\\System32\\wsl.exe",
          source: "WSL",
          wslExecutablePath: "/usr/bin/M2",
        },
        ["--webapp"],
        "C:\\Users\\Admin\\m2-project",
      ),
      {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        args: [
          "--cd",
          "/mnt/c/Users/Admin/m2-project",
          "--exec",
          "/usr/bin/M2",
          "--webapp",
        ],
      },
    );
  });

  test("adds configured launch arguments to WSL M2 invocations", function () {
    assert.deepEqual(
      getM2LaunchConfiguration(
        {
          executablePath: "C:\\Windows\\System32\\wsl.exe",
          source: "WSL",
          wslExecutablePath: "/usr/bin/M2",
        },
        ["--webapp"],
        "C:\\Users\\Admin\\m2-project",
        "--silent",
      ),
      {
        executablePath: "C:\\Windows\\System32\\wsl.exe",
        args: [
          "--cd",
          "/mnt/c/Users/Admin/m2-project",
          "--exec",
          "/usr/bin/M2",
          "--webapp",
          "--silent",
        ],
      },
    );
  });
});
