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
import { getCodeRunStatusText } from "../codeRunStatus";
import {
  getM2StartupPatch,
  getM2TerminalPtyLaunch,
  getM2TerminalProcessArgs,
  getM2WebviewPtyLaunch,
  getM2WebviewProcessArgs,
  isM2BlankOrCommentOnly,
  outputHasM2CompletionSignal,
  outputHasTerminalPromptAfterSubmittedInput,
  outputHasWebAppPromptAfterSubmittedInput,
  splitM2OutputForWebview,
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

  test("builds webview process args for Standard top-level output", function () {
    assert.deepEqual(getM2WebviewProcessArgs("startupPatch", "standard"), [
      "--webapp",
      "-e",
      "startupPatch",
      "-e",
      "topLevelMode = Standard",
    ]);
  });

  test("builds terminal process args with extension startup patch", function () {
    assert.deepEqual(getM2TerminalProcessArgs("startupPatch"), [
      "-e",
      "startupPatch",
    ]);
  });

  test("wraps Linux terminal launches in a pseudo-tty", function () {
    const launch = getM2TerminalPtyLaunch("/usr/bin/M2", ["--silent"]);
    if (process.platform === "linux") {
      assert.equal(launch.executablePath, "script");
      assert.deepEqual(launch.args, [
        "-qfec",
        "'/usr/bin/M2' '--silent'",
        "/dev/null",
      ]);
      assert.equal(launch.echoesInput, true);
      assert.equal(launch.interruptWithInput, true);
    } else {
      assert.equal(launch.executablePath, "/usr/bin/M2");
      assert.deepEqual(launch.args, ["--silent"]);
      assert.equal(launch.echoesInput, false);
      assert.equal(launch.interruptWithInput, false);
    }
  });

  test("wraps Linux webview launches in a pseudo-tty without input echo", function () {
    const launch = getM2WebviewPtyLaunch("/usr/bin/M2", ["--webapp"]);
    if (process.platform === "linux") {
      assert.equal(launch.executablePath, "script");
      assert.deepEqual(launch.args, [
        "-E",
        "never",
        "-qfec",
        "'/usr/bin/M2' '--webapp'",
        "/dev/null",
      ]);
    } else {
      assert.equal(launch.executablePath, "/usr/bin/M2");
      assert.deepEqual(launch.args, ["--webapp"]);
    }
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

suite("Macaulay2 Code Run Status", function () {
  test("labels submitted code states", function () {
    assert.equal(getCodeRunStatusText("waiting"), "  M2 waiting");
    assert.equal(getCodeRunStatusText("running"), "  M2 running");
    assert.equal(getCodeRunStatusText("completed"), "  M2 completed");
  });

  test("detects blank or comment-only submissions", function () {
    assert.equal(isM2BlankOrCommentOnly(""), true);
    assert.equal(isM2BlankOrCommentOnly("   \n\t"), true);
    assert.equal(isM2BlankOrCommentOnly("-- just a comment"), true);
    assert.equal(isM2BlankOrCommentOnly("  -- indented comment\n\n-- next"), true);
    assert.equal(isM2BlankOrCommentOnly("x = 1 -- trailing comment"), false);
    assert.equal(isM2BlankOrCommentOnly("-- comment\nx = 1"), false);
  });

  test("detects webview completion output", function () {
    assert.equal(
      outputHasM2CompletionSignal("output" + String.fromCharCode(20)),
      true,
    );
    assert.equal(outputHasM2CompletionSignal("answer\n\ni24 : "), true);
    assert.equal(outputHasM2CompletionSignal("answer\r\n\r\ni24 : "), true);
    assert.equal(outputHasM2CompletionSignal("still running"), false);
  });

  test("detects quiet WebApp completion after submitted input", function () {
    const promptTag = String.fromCharCode(14);
    const submittedInput = "x = 1;\n";

    assert.equal(
      outputHasWebAppPromptAfterSubmittedInput(
        `${promptTag}i1 : ${submittedInput}`,
        submittedInput,
      ),
      false,
    );
    assert.equal(
      outputHasWebAppPromptAfterSubmittedInput(
        `${promptTag}i1 : x = 1;\r\n${promptTag}i2 : `,
        submittedInput,
      ),
      true,
    );
    assert.equal(
      outputHasWebAppPromptAfterSubmittedInput(
        `${promptTag}i2 : `,
        submittedInput,
        true,
      ),
      true,
    );
  });

  test("detects quiet terminal completion after submitted input", function () {
    const submittedInput = "x = 1;\n";

    assert.equal(
      outputHasTerminalPromptAfterSubmittedInput(
        `\r\ni1 : x = 1;\r\n`,
        submittedInput,
      ),
      false,
    );
    assert.equal(
      outputHasTerminalPromptAfterSubmittedInput(
        `x = 1;\r\n\r\ni2 : `,
        submittedInput,
      ),
      true,
    );
    assert.equal(
      outputHasTerminalPromptAfterSubmittedInput(
        `\r\ni2 : `,
        submittedInput,
        true,
      ),
      true,
    );
    assert.equal(
      outputHasTerminalPromptAfterSubmittedInput(
        `\r\ni3 : sleep(2)\r\n`,
        "sleep(2)\n",
      ),
      false,
    );
  });

  test("splits webview output on WebApp section boundaries", function () {
    assert.deepEqual(
      splitM2OutputForWebview(
        `a${String.fromCharCode(18)}\nb${String.fromCharCode(18)}\n`,
      ),
      [`a${String.fromCharCode(18)}\n`, `b${String.fromCharCode(18)}\n`],
    );
    assert.deepEqual(splitM2OutputForWebview("1\n2\n"), ["1\n", "2\n"]);
  });
});
