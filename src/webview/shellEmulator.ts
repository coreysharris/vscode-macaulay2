declare const MINIMAL;
// import { autoRender } from "./autoRender";
import { webAppTags, webAppClasses, webAppRegex } from "./tags.js";
import {
  scrollDownLeft,
  scrollDown,
  scrollLeft,
  baselinePosition,
  getCaret,
  setCaret,
  setCaretAtEndMaybe,
  attachElement,
  locateRowColumn,
  locateOffset,
  addMarkerPos,
  language,
  parseLocation,
} from "./htmlTools.js";

// import Prism from "prismjs"; // TODO reinstate

/*
function dehtml(s) {
  // these are all the substitutions performed by M2
  //  s = s.replace(/&bsol;/g, "\\");
  //s = s.replace(/&dollar;/g,"$");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&amp;/g, "&"); // do this one last
  return s;
}
*/

declare global {
  interface Array<T> {
    sortedPush(el: any): number;
  }
}
Array.prototype.sortedPush = function (el: any) {
  let m = 0;
  let n = this.length - 1;

  while (m <= n) {
    const k = (n + m) >> 1;
    if (el > this[k]) m = k + 1;
    else if (el < this[k]) n = k - 1;
    else {
      m = -1;
      n = -2;
    }
  }
  if (m >= 0) this.splice(m, 0, el);

  return this.length;
};

type CompletionItem = {
  label: string;
  kind: string;
};

const Shell = function (
  terminal: HTMLElement,
  emit: (type: string, msg?: string) => void, // should be renamed
  editor: HTMLElement,
  iFrame: HTMLFrameElement,
  createInputSpan: boolean,
  completionItems: CompletionItem[] = [],
) {
  // Shell is an old-style javascript oop constructor
  // we're using arguments as private variables, cf
  // https://stackoverflow.com/questions/18099129/javascript-using-arguments-for-closure-bad-or-good
  const obj = this; // for nested functions with their own 'this'. or one could use bind, or => functions, but simpler this way
  obj.openedHelp = false;
  let htmlSec; // the current place in terminal where new stuff gets written
  let inputSpan = null; // the input HTML element at the bottom of the terminal. note that inputSpan should always have *one text node*
  const cmdHistory: any = []; // History of commands for terminal-like arrow navigation
  cmdHistory.index = 0;
  cmdHistory.sorted = []; // a sorted version
  // input is a bit messy...
  let inputEndFlag = false;
  let procInputSpan = null; // temporary span containing currently processed input (for aesthetics only)
  let pendingErrorOutput = "";
  let interpreterDepth = 1;

  const isEmptyCell = function (el) {
    // tests if a cell is empty
    if (!el.classList.contains("M2Cell")) return false;
    const c = el.childNodes;
    for (let i = 0; i < c.length; i++)
      if (c[i].nodeType != 1 || !c[i].classList.contains("M2CellBar"))
        return false;
    return true;
  };

  const openHelp = function (url: string) {
    obj.openedHelp = true;
    emit("openHelp", url);
  };

  const isHtmlHelpLink = function (href: string) {
    const path = href.split("#", 1)[0].split("?", 1)[0];
    return (
      /^file:\/\/.+\.html?$/i.test(path) ||
      /^[a-zA-Z]:[\\/].+\.html?$/i.test(path) ||
      (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && /\.html?$/i.test(path))
    );
  };

  const createHtml = function (className) {
    const cell = className.indexOf("M2Cell") >= 0; // a bit special
    const anc = htmlSec;
    htmlSec = document.createElement(cell ? "div" : "span");
    htmlSec.className = className;
    if (cell) {
      if (!isEmptyCell(anc)) {
        // avoid 2 separators in a row
        // insert separator above
        const ss = document.createElement("span");
        ss.className = "M2CellBar M2Separator";
        ss.tabIndex = 0;
        htmlSec.appendChild(ss);
      }
      // insert bar at left -- NB: left bar must be after separator for css to work
      const s = document.createElement("span");
      s.className = "M2CellBar M2Left";
      s.tabIndex = 0;
      htmlSec.appendChild(s);
    }
    if (className.indexOf("M2Text") < 0) htmlSec.dataset.code = "";
    // even M2Html needs to keep track of innerHTML because html tags may get broken
    if (inputSpan && inputSpan.parentElement == anc)
      anc.insertBefore(htmlSec, inputSpan);
    else anc.appendChild(htmlSec);
  };

  const createInputEl = function () {
    // (re)create the input area
    if (inputSpan) inputSpan.remove(); // parentElement.removeChild(inputSpan);
    inputSpan = document.createElement("span");
    //inputSpan = document.createElement("input"); // interesting idea but creates tons of problems
    inputSpan.contentEditable = "plaintext-only";
    inputSpan.spellcheck = false; // sadly this or any of the following attributes are not recognized in contenteditable :(
    inputSpan.autocapitalize = "off";
    inputSpan.autocorrect = "off";
    inputSpan.autocomplete = "off";
    inputSpan.classList.add("M2Input");
    inputSpan.classList.add("M2CurrentInput");
    inputSpan.classList.add("M2Text");

    htmlSec = terminal;
    //    if (editor) htmlSec.appendChild(document.createElement("br")); // a bit of extra space doesn't hurt
    createHtml(webAppClasses[webAppTags.Cell]); // we create a first cell for the whole session
    createHtml(webAppClasses[webAppTags.Cell]); // and one for the starting text (Macaulay2 version... or whatever comes out of M2 first)
    htmlSec.appendChild(inputSpan);

    inputSpan.focus();

    inputEndFlag = false;
  };

  if (createInputSpan) createInputEl();
  else htmlSec = terminal;

  const codeStack = []; // stack of past code run

  obj.codeInputAction = function (t) {
    let str = t.dataset.m2code ? t.dataset.m2code : t.textContent; // used to be innerText
    if (str[str.length - 1] == "\n") str = str.substring(0, str.length - 1); // cleaner this way
    t.dataset.m2code = str;
    t.classList.add("codetrigger");
    if (
      (t.tagName == "CODE" && !t.classList.contains("norun")) ||
      t.classList.contains("run")
    ) {
      t.classList.add("clicked");
      codeStack.push(t);
      obj.postMessage(str);
    } else {
      // past input / manual code: almost the same but not quite: code not sent, just replaces input
      // inputSpan.textContent = str;
      // setCaretAtEndMaybe(inputSpan);
      inputSpan.focus();
      document.execCommand("selectAll");
      document.execCommand("insertText", false, str);
      scrollDown(terminal);
    }
    setTimeout(() => {
      t.classList.remove("codetrigger");
    }, 100);
  };

  const returnSymbol = "\u21B5";

  // borrowed from editor.ts
  const sanitizeInput = function (msg: string) {
    // sanitize input
    //  return msg.replace(sanitizeRegEx, "").replace(/\n+$/, "");
    return msg.replace(webAppRegex, "").replace(/\n+$/, "");
  };
  const htmlToM2 = function (el: HTMLElement) {
    return el.textContent.replace("−", "-");
  };
  const normalizePlainText = function (txt: string) {
    return txt.replace(/\t/g, "    ");
  };
  const clipboardText = function (data: DataTransfer | null) {
    return data ? normalizePlainText(data.getData("text/plain")) : "";
  };
  const hasPlainText = function (data: DataTransfer | null) {
    return !!data && Array.from(data.types).indexOf("text/plain") >= 0;
  };
  const shouldHandlePlainTextPaste = function (target: EventTarget | null) {
    if (!inputSpan) return false;
    const el = target instanceof HTMLElement ? target : null;
    if (el && el !== inputSpan && !inputSpan.contains(el)) {
      if (el.tagName == "INPUT" || el.tagName == "TEXTAREA") return false;
      if (el.isContentEditable) return false;
    }
    return true;
  };
  const insertPlainText = function (txt: string) {
    setCaretAtEndMaybe(inputSpan, true);
    document.execCommand("insertText", false, txt);
    scrollDown(terminal);
  };
  let lastClipboardPasteRequest = 0;
  const requestClipboardPaste = function () {
    const now = Date.now();
    if (now - lastClipboardPasteRequest < 250) return;
    lastClipboardPasteRequest = now;
    emit("paste");
  };

  const maxCompletionItems = 50;
  const seenCompletionLabels = new Set<string>();
  const uniqueCompletionItems = completionItems.filter((item) => {
    if (seenCompletionLabels.has(item.label)) return false;
    seenCompletionLabels.add(item.label);
    return true;
  });
  let completionMenu: HTMLUListElement | null = null;
  let completionMatches: CompletionItem[] = [];
  let completionStart = 0;
  let completionSelected = 0;
  let completionSelectionExplicit = false;

  const completionMenuIsVisible = function () {
    return completionMenu !== null && completionMenu.style.display != "none";
  };

  const ensureCompletionMenu = function () {
    if (completionMenu) return completionMenu;

    completionMenu = document.createElement("ul");
    completionMenu.className = "M2CompletionMenu";
    completionMenu.style.display = "none";
    document.body.appendChild(completionMenu);
    return completionMenu;
  };

  const getCompletionContext = function (allowEmptyPrefix = false) {
    if (!inputSpan || document.activeElement != inputSpan) return null;

    const caret = getCaret(inputSpan);
    if (caret === null) return null;

    const text = htmlToM2(inputSpan);
    const beforeCaret = text.substring(0, caret);
    const match = /(?:^|[^\w])(\w*)$/.exec(beforeCaret);
    if (!match) return null;

    const prefix = match[1];
    if (!allowEmptyPrefix && prefix.length == 0) return null;

    return {
      caret,
      prefix,
      start: caret - prefix.length,
      text,
    };
  };

  const hideCompletionMenu = function () {
    if (completionMenu) completionMenu.style.display = "none";
    completionMatches = [];
    completionSelectionExplicit = false;
  };

  const getCompletionMatches = function (prefix: string) {
    if (uniqueCompletionItems.length == 0) return [];

    const matches: CompletionItem[] = [];
    for (const item of uniqueCompletionItems) {
      if (item.label.startsWith(prefix)) {
        matches.push(item);
        if (matches.length >= maxCompletionItems) break;
      }
    }
    return matches;
  };

  const getCompletionAnchorRect = function (caret: number) {
    const nodeOffset = locateOffset(inputSpan, caret);
    if (nodeOffset) {
      const range = document.createRange();
      range.setStart(nodeOffset[0], nodeOffset[1]);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height || rect.left || rect.top) return rect;
    }
    return inputSpan.getBoundingClientRect();
  };

  const positionCompletionMenu = function (caret: number) {
    const menu = ensureCompletionMenu();
    const rect = getCompletionAnchorRect(caret);
    const margin = 4;
    const width = menu.offsetWidth || 260;
    const height = menu.offsetHeight || 0;
    const left = Math.max(
      margin,
      Math.min(rect.left, window.innerWidth - width - margin),
    );
    const below = rect.bottom + margin;
    const above = rect.top - height - margin;
    const top =
      below + height <= window.innerHeight || above < margin ? below : above;

    menu.style.left = `${left}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
  };

  const setCompletionSelection = function (index: number) {
    if (!completionMenu || completionMatches.length == 0) return;

    completionSelected =
      (index + completionMatches.length) % completionMatches.length;
    completionSelectionExplicit = true;
    Array.from(completionMenu.children).forEach((child, childIndex) => {
      child.classList.toggle("selected", childIndex == completionSelected);
    });
    completionMenu.children[completionSelected]?.scrollIntoView({
      block: "nearest",
    });
  };

  const applyCompletion = function (index: number) {
    const item = completionMatches[index];
    const context = getCompletionContext(true);
    if (!item || !context) return false;

    inputSpan.textContent =
      context.text.substring(0, completionStart) +
      item.label +
      context.text.substring(context.caret);
    setCaret(inputSpan, completionStart + item.label.length);
    hideCompletionMenu();
    scrollDown(terminal);
    return true;
  };

  const renderCompletionMenu = function () {
    const menu = ensureCompletionMenu();
    menu.textContent = "";

    completionMatches.forEach((item, index) => {
      const option = document.createElement("li");
      option.className = "M2CompletionItem";
      if (index == completionSelected) option.classList.add("selected");
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        applyCompletion(index);
      });

      const label = document.createElement("span");
      label.className = "M2CompletionLabel";
      label.textContent = item.label;
      option.appendChild(label);

      const kind = document.createElement("span");
      kind.className = "M2CompletionKind";
      kind.textContent = item.kind;
      option.appendChild(kind);

      menu.appendChild(option);
    });
  };

  const showCompletionMenu = function (
    allowEmptyPrefix = false,
    selectionExplicit = false,
  ) {
    const context = getCompletionContext(allowEmptyPrefix);
    if (!context) {
      hideCompletionMenu();
      return false;
    }

    const matches = getCompletionMatches(context.prefix);
    if (matches.length == 0) {
      hideCompletionMenu();
      return false;
    }

    completionMatches = matches;
    completionStart = context.start;
    completionSelected = 0;
    completionSelectionExplicit = selectionExplicit;
    renderCompletionMenu();
    ensureCompletionMenu().style.display = "block";
    positionCompletionMenu(context.caret);
    return true;
  };

  const completionKeyHandling = function (e: KeyboardEvent) {
    if (!inputSpan || document.activeElement != inputSpan) return false;

    if ((e.ctrlKey || e.metaKey) && e.code == "Space") {
      showCompletionMenu(true, true);
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    if (!completionMenuIsVisible()) return false;

    switch (e.key) {
      case "ArrowDown":
        setCompletionSelection(completionSelected + 1);
        e.preventDefault();
        return true;
      case "ArrowUp":
        setCompletionSelection(completionSelected - 1);
        e.preventDefault();
        return true;
      case "Enter":
        if (e.shiftKey) return false;
        if (!completionSelectionExplicit) return false;
        if (applyCompletion(completionSelected)) {
          e.preventDefault();
          return true;
        }
        return false;
      case "Tab":
        if (applyCompletion(completionSelected)) {
          e.preventDefault();
          return true;
        }
        return false;
      case "Escape":
        hideCompletionMenu();
        e.preventDefault();
        return true;
      case "ArrowLeft":
      case "ArrowRight":
      case "Home":
      case "End":
        hideCompletionMenu();
        return false;
      default:
        return false;
    }
  };

  obj.postMessage = function (msg) {
    hideCompletionMenu();
    // send input, adding \n if necessary
    const clean = sanitizeInput(msg);
    if (procInputSpan === null) {
      // it'd be nicer to use ::before on inputSpan but sadly caret issues... cf https://stackoverflow.com/questions/60843694/cursor-position-in-an-editable-div-with-a-before-pseudo-element
      procInputSpan = document.createElement("div");
      inputSpan.parentElement.insertBefore(procInputSpan, inputSpan);
    }
    procInputSpan.textContent += clean + returnSymbol + "\n";
    inputSpan.textContent = "";
    scrollDownLeft(terminal);
    emit("input", clean + "\n");
  };

  const focusElement = function () {
    const foc = window.getSelection().focusNode;
    return foc && foc.nodeType == 3 ? foc.parentElement : foc;
  };

  const downArrowKeyHandling = function () {
    if (
      focusElement() == inputSpan &&
      inputSpan.textContent.substring(getCaret(inputSpan) || 0).indexOf("\n") <
        0 &&
      cmdHistory.index < cmdHistory.length
    ) {
      cmdHistory.index++;
      inputSpan.textContent =
        cmdHistory.index === cmdHistory.length
          ? cmdHistory.current
          : cmdHistory[cmdHistory.index];
      return true;
    } else return false;
  };

  const upArrowKeyHandling = function () {
    if (
      focusElement() == inputSpan &&
      inputSpan.textContent
        .substring(0, getCaret(inputSpan) || 0)
        .indexOf("\n") < 0 &&
      cmdHistory.index > 0
    ) {
      if (cmdHistory.index === cmdHistory.length)
        cmdHistory.current = htmlToM2(inputSpan);
      cmdHistory.index--;
      inputSpan.textContent = cmdHistory[cmdHistory.index];
      return true;
    } else return false;
  };

  terminal.onpaste = function (e) {
    if (!shouldHandlePlainTextPaste(e.target)) return;
    e.preventDefault();
    if (hasPlainText(e.clipboardData)) {
      insertPlainText(clipboardText(e.clipboardData));
    } else {
      requestClipboardPaste();
    }
  };

  terminal.addEventListener("beforeinput", function (e: InputEvent) {
    if (
      e.inputType !== "insertFromPaste" &&
      e.inputType !== "insertFromDrop"
    )
      return;
    if (
      !shouldHandlePlainTextPaste(e.target) ||
      document.activeElement != inputSpan
    )
      return;
    e.preventDefault();
    if (hasPlainText(e.dataTransfer)) {
      insertPlainText(clipboardText(e.dataTransfer));
    } else if (e.inputType == "insertFromPaste") {
      requestClipboardPaste();
    }
  });

  obj.receivePaste = function (txt: string) {
    if (!inputSpan) return;
    insertPlainText(normalizePlainText(txt));
  };

  terminal.onclick = function (e) {
    if (!inputSpan) return;
    let t = e.target as HTMLElement;
    while (t != terminal) {
      if (
        ((t.tagName == "CODE" && language(t) == "Macaulay2") ||
          t.dataset.m2code || // allows to emulate code pasting from arbitrary html element
          t.classList.contains("M2PastInput")) &&
        t.ownerDocument.getSelection().isCollapsed
      ) {
        e.stopPropagation();
        obj.codeInputAction(t);
        return;
      } else if (t instanceof HTMLAnchorElement) {
        const href = t.getAttribute("href");
        if (!href) return;
        const [name, rowcols] = parseLocation(href);
        if (rowcols && name == "stdio") {
          obj.selectPastInput(document.activeElement, rowcols);
          e.preventDefault();
        } else if (isHtmlHelpLink(href)) {
          e.preventDefault();
          e.stopPropagation();
          openHelp(href);
        } else if (!t.host || t.host == window.location.host) {
          e.preventDefault();
          e.stopPropagation();
          emit("open", href); // calls to local files are redirected to editor
        }
        return;
      }
      if (t.classList.contains("M2CellBar")) return;
      t = t.parentElement;
    }
    if (
      window.getSelection().toString().length == 0 &&
      document.activeElement != inputSpan
    ) {
      inputSpan.focus({ preventScroll: true });
      setCaret(inputSpan, inputSpan.textContent.length);
    }
  };

  let savepos = null;
  terminal.onkeydown = function (e: KeyboardEvent) {
    if (!inputSpan) return;
    if (
      (e.target as HTMLElement).classList.contains("M2CellBar") ||
      (e.target as HTMLElement).tagName == "INPUT"
    )
      return;
    if (completionKeyHandling(e)) return;
    if (
      ((e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() == "v") ||
      (e.shiftKey && e.key == "Insert")
    ) {
      if (shouldHandlePlainTextPaste(e.target)) {
        e.preventDefault();
        requestClipboardPaste();
        return;
      }
    }
    if (e.key == "Enter") {
      if (!e.shiftKey) {
        obj.postMessage(htmlToM2(inputSpan));
        setCaret(inputSpan, 0);
        e.preventDefault(); // no crappy <div></div> added
      }
      e.stopPropagation(); // in case of shift-enter, don't want it to kick in
      return;
    }

    if ((e.key == "ArrowDown" || e.key == "ArrowUp") && !e.shiftKey) {
      if (
        e.key == "ArrowDown" ? downArrowKeyHandling() : upArrowKeyHandling()
      ) {
        hideCompletionMenu();
        e.preventDefault();
        setCaretAtEndMaybe(inputSpan);
        scrollDown(terminal);
        //
        return;
      }
    }

    if (
      e.ctrlKey ||
      e.altKey ||
      e.metaKey ||
      e.key == "Shift" || // subtly different: shift key pressed (no combo)
      e.key == "PageUp" ||
      e.key == "PageDown" ||
      e.key == "F1"
    ) {
      // do not move caret on Ctrl/Command combos, PageUp/Down, etc
      if (e.key == "PageUp" && document.activeElement == inputSpan) {
        savepos = getCaret(inputSpan);
        // this prevents the annoying behavior of page up going to start of inputSpan => weird horiz scrolling
        setCaret(inputSpan, 0);
      }
      if (e.key == "PageDown" && document.activeElement == inputSpan) {
        // this prevents the annoying behavior of page down going to end of inputSpan => weird horiz scrolling
        setCaret(inputSpan, inputSpan.textContent.length);
      }
      return;
    }

    if (e.key == "Home") {
      setCaret(inputSpan, 0); // the default would sometimes use this for vertical scrolling
      scrollDownLeft(terminal);
      return;
    }

    if (e.key == "End") {
      setCaretAtEndMaybe(inputSpan); // the default would sometimes use this for vertical scrolling
      scrollDown(terminal);
      return;
    }

    setCaretAtEndMaybe(inputSpan, true);
    const pos = getCaret(inputSpan);
    if (pos == 0) scrollLeft(terminal);
  };

  terminal.oninput = function (e: InputEvent) {
    if (!inputSpan) return;
    if (document.activeElement == inputSpan && getCaret(inputSpan) == 0)
      scrollLeft(terminal);
    if (document.activeElement == inputSpan) showCompletionMenu(false);
    else hideCompletionMenu();
  };

  terminal.onkeyup = function (e: KeyboardEvent) {
    if (!inputSpan) return;
    if (savepos !== null) {
      setCaret(inputSpan, savepos);
      savepos = null;
    }
  };

  const subList = [];

  // If rich TeX/HTML rendering fails, show escaped fallback text rather than
  // leaking internal \htmlId placeholders into the output.
  const unresolvedHtmlIdPattern = /\\htmlId\{sub\d+\}/;

  const replaceAll = function (
    text: string,
    needle: string,
    replacement: string,
  ) {
    return text.split(needle).join(replacement);
  };

  const replaceDelimitedTexCommand = function (
    text: string,
    command: string,
    replacement: (argument: string) => string,
  ) {
    let result = "";
    let index = 0;
    const prefix = "\\" + command + "{";
    while (index < text.length) {
      const start = text.indexOf(prefix, index);
      if (start < 0) {
        result += text.substring(index);
        break;
      }
      result += text.substring(index, start);
      let depth = 1;
      let end = start + prefix.length;
      while (end < text.length && depth > 0) {
        if (text[end] == "{") depth++;
        else if (text[end] == "}") depth--;
        end++;
      }
      if (depth > 0) {
        result += text.substring(start);
        break;
      }
      result += replacement(text.substring(start + prefix.length, end - 1));
      index = end;
    }
    return result;
  };

  const plainTextFromTex = function (text: string) {
    let plain = text.trim();
    if (plain[0] == "$" && plain[plain.length - 1] == "$")
      plain = plain.substring(1, plain.length - 1);

    [
      "texttt",
      "textrm",
      "textsf",
      "mathrm",
      "mathit",
      "mathbf",
      "mathbb",
      "mathfrak",
      "mathcal",
    ].forEach((command) => {
      plain = replaceDelimitedTexCommand(
        plain,
        command,
        (argument) => argument,
      );
    });

    plain = plain
      .replace(/\\left/g, "")
      .replace(/\\right/g, "")
      .replace(/\\begin\{(?:array|aligned|tabular)\}(?:\{[^}]*\})?/g, "")
      .replace(/\\end\{(?:array|aligned|tabular)\}/g, "")
      .replace(/\\(?:,|:|;|!)/g, "")
      .replace(/\\q?quad/g, " ")
      .replace(/\\\\/g, "\n")
      .replace(/&/g, "")
      .replace(/\\([{}[\]().,|/])/g, "$1")
      .replace(/\\ /g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n\s+/g, "\n");
    return plain;
  };

  const fallbackTextForRichOutput = function (
    rawHtml: string,
    idList?: string,
  ) {
    let fallback = rawHtml || "";
    if (idList) {
      idList.split(" ").forEach(function (id) {
        const sub = subList[+id];
        if (sub)
          fallback = replaceAll(fallback, sub[0], sub[1].textContent || "");
      });
    }
    const scratch = document.createElement("span");
    scratch.innerHTML = fallback;
    return plainTextFromTex(scratch.textContent || fallback);
  };

  const shouldUsePlainTextFallback = function (
    rawHtml: string,
    idList?: string,
  ) {
    const trimmed = rawHtml.trim();
    return !!idList && trimmed[0] == "$" && trimmed[trimmed.length - 1] == "$";
  };

  const fallbackRichOutput = function (
    target: HTMLElement,
    rawHtml: string,
    idList: string | undefined,
    reason: string,
  ) {
    target.textContent = fallbackTextForRichOutput(rawHtml, idList);
    target.classList.add("M2RenderFallback");
    console.log("Macaulay2 rich output fallback: " + reason);
  };

  const recurseReplace = function (container, str, el) {
    for (let i = 0; i < container.childNodes.length; i++) {
      const sub = container.childNodes[i];
      if (sub.nodeType === 3) {
        const pos = sub.textContent.indexOf(str);
        if (pos >= 0) {
          const rest = sub.textContent.substring(pos + str.length);
          const next = sub.nextSibling; // really, #i+1 except if last
          if (pos > 0) {
            sub.textContent = sub.textContent.substring(0, pos);
            container.insertBefore(el, next);
          } else container.replaceChild(el, sub);
          if (rest.length > 0)
            container.insertBefore(document.createTextNode(rest), next);
          return true;
        }
      } else if (sub.nodeType === 1) {
        if (recurseReplace(sub, str, el)) return true;
      }
    }
    return false;
  };

  const isTrueInput = function () {
    // test if input is from user or from e.g. examples
    if (!createInputSpan) return false;
    let el = htmlSec;
    while (el && el != terminal && !el.classList.contains("M2Html"))
      el = el.parentElement; // TODO better
    return el == terminal;
  };

  const isOpenInputSection = function () {
    return htmlSec && htmlSec.classList.contains("M2Input");
  };

  const shouldDeferErrorOutput = function () {
    // stdout/stderr arrive on separate pipes, so stderr can beat M2's input echo.
    return (
      createInputSpan &&
      (procInputSpan !== null || inputEndFlag || isOpenInputSection())
    );
  };

  const flushPendingErrorOutput = function (force = false) {
    if (pendingErrorOutput.length == 0) return;
    if (!force && shouldDeferErrorOutput()) return;
    const msg = pendingErrorOutput;
    pendingErrorOutput = "";
    displayText(msg);
  };

  const sessionCell = function (el: HTMLElement) {
    while (el && el.parentElement != terminal) {
      el = el.parentElement;
    }
    return el;
  };

  const closeHtml = function () {
    const closingInput = htmlSec.classList.contains("M2Input");
    let anc = htmlSec.parentElement;

    if (htmlSec.classList.contains("M2Input"))
      anc.appendChild(document.createElement("br")); // this first for spacing purposes

    if (htmlSec.contains(inputSpan)) attachElement(inputSpan, anc);
    // move back input element to outside htmlSec

    if (isEmptyCell(htmlSec)) {
      // reject empty cells
      htmlSec.remove();
      htmlSec = anc;
      return;
    }
    if (htmlSec.classList.contains("M2Prompt") && isTrueInput()) {
      const txt = htmlSec.textContent;
      const newInterpreterDepth = /^i*/.exec(txt)[0].length;
      if (newInterpreterDepth > 0) {
        while (interpreterDepth != newInterpreterDepth) {
          const saveHtmlSec = htmlSec;
          const saveAnc = anc;
          htmlSec = anc.parentElement;
          if (interpreterDepth > newInterpreterDepth) {
            interpreterDepth--;
            closeHtml();
          } else {
            interpreterDepth++;
            createHtml(webAppClasses[webAppTags.Cell]);
          }
          htmlSec.appendChild(saveAnc);
          htmlSec = saveHtmlSec;
          anc = saveAnc;
        }
      }
    } else if (htmlSec.classList.contains("M2Position") && isTrueInput()) {
      if (!htmlSec.parentElement.dataset.positions)
        htmlSec.parentElement.dataset.positions = " ";
      htmlSec.parentElement.dataset.positions += htmlSec.dataset.code + " ";
    } else if (htmlSec.classList.contains("M2Input")) {
      if (isTrueInput()) {
        // add input to history
        let txt = htmlSec.textContent;
        if (txt[txt.length - 1] == "\n") txt = txt.substring(0, txt.length - 1); // should be true
        if (htmlSec.classList.contains("M2InputContd"))
          // rare case where input is broken -- e.g.  I=ideal 0; x=(\n   1)
          cmdHistory[cmdHistory.length - 1] += "\n" + txt;
        else cmdHistory.index = cmdHistory.push(txt);
        txt.split("\n").forEach((line) => {
          line = line.trim();
          if (line.length > 0) cmdHistory.sorted.sortedPush(line);
        });
      }
      // highlight
      /*
      htmlSec.innerHTML = Prism.highlight(
        htmlSec.textContent,
        Prism.languages.macaulay2
      );
       */
      htmlSec.classList.add("M2PastInput");
    } else if (htmlSec.classList.contains("M2Html")) {
      // first things first: make sure we don't mess with input (interrupts, tasks, etc, can display unexpectedly)
      if (anc.classList.contains("M2Input")) {
        anc.parentElement.insertBefore(htmlSec, anc);
      }
      const rawHtml = htmlSec.dataset.code || "";
      const idList = htmlSec.dataset.idList;
      let renderFailure: string | undefined;
      if (shouldUsePlainTextFallback(rawHtml, idList)) {
        renderFailure = "generic TeX output contains embedded HTML";
      } else {
        try {
          htmlSec.insertAdjacentHTML("beforeend", rawHtml);
          // KaTeX rendering // TODO reinstate bundled version
          // autoRender(htmlSec);
          // instead we use the non-bundled katex
          // @ts-ignore
          renderMathInElement(htmlSec, {
            strict: false,
            trust: true,
            throwOnError: true,
            // Dense Macaulay2 output can contain thousands of thin-space macros.
            maxExpand: 100000,
            delimiters: [{ left: "$", right: "$", display: false }],
          });
        } catch (e) {
          renderFailure = "KaTeX could not render this output";
          console.log(e);
        }
      }
      if (!renderFailure) {
        // syntax highlighting code
        /*
        Array.from(
          htmlSec.querySelectorAll(
            "code.language-macaulay2"
          ) as NodeListOf<HTMLElement>
        ).forEach(
          (x) =>
            (x.innerHTML = Prism.highlight(
              x.innerText,
              Prism.languages.macaulay2
            ))
        );
         */
        // auto opening links
        Array.from(
          htmlSec.querySelectorAll("a.auto") as NodeListOf<HTMLAnchorElement>,
        ).forEach((x) => {
          let url = x.getAttribute("href") || x.href;
          console.log("Opening URL " + url);
          openHelp(url);
        });
        // error highlighting
        Array.from(
          htmlSec.querySelectorAll(
            ".M2ErrorLocation a",
          ) as NodeListOf<HTMLAnchorElement>,
        ).forEach((x) => {
          const [name, rowcols] = parseLocation(x.getAttribute("href"));
          if (rowcols) {
            // highlight error
            if (name == "stdio") {
              const nodeOffset = obj.locateStdio(
                sessionCell(htmlSec),
                rowcols[0],
                rowcols[1],
              );
              if (nodeOffset) {
                addMarkerPos(nodeOffset[0], nodeOffset[1]).classList.add(
                  "error-marker",
                );
              }
            }
            // TODO other cases
          }
        });
        // putting pieces back together
        if (idList) {
          idList.split(" ").forEach(function (id) {
            if (renderFailure) return;
            const el = document.getElementById("sub" + id);
            if (el) {
              if (el.style.color == "transparent") subList[+id][1].remove();
              // e.g. inside \vphantom{}
              else {
                el.style.display = "contents"; // could put in css but don't want to overreach
                el.style.fontSize = "0.826446280991736em"; // to compensate for katex's 1.21 factor
                el.innerHTML = "";
                el.appendChild(subList[+id][1]);
              }
            } else {
              // more complicated
              if (!recurseReplace(htmlSec, subList[+id][0], subList[+id][1]))
                renderFailure =
                  "internal rich-output placeholder was not restored";
            }
          });
          htmlSec.removeAttribute("data-id-list");
        }
        if (
          !renderFailure &&
          unresolvedHtmlIdPattern.test(htmlSec.textContent || "")
        )
          renderFailure = "internal rich-output placeholder remained visible";
      }
      if (renderFailure) {
        htmlSec.removeAttribute("data-id-list");
        fallbackRichOutput(htmlSec, rawHtml, idList, renderFailure);
      }
    } else if (htmlSec.classList.contains("M2Url")) {
      const url = htmlSec.dataset.code;
      if (url) openHelp(url);
    }
    htmlSec.removeAttribute("data-code");
    if (anc.classList.contains("M2Html") && anc.dataset.code != "") {
      // stack
      // in case it's inside TeX, we compute dimensions
      // 18mu= 1em * mathfont size modifier, here 1.21 factor of KaTeX
      const unitName = "em"; // TEMP replace with "ce" eventually
      const fontSize: number =
        +window
          .getComputedStyle(htmlSec, null)
          .getPropertyValue("font-size")
          .split("px", 1)[0] * 1.21;
      const baseline: number = baselinePosition(htmlSec);
      const str =
        "\\htmlId{sub" +
        subList.length +
        "}{\\vphantom{" + // the vphantom ensures proper horizontal space
        "\\raisebox{" +
        baseline / fontSize +
        unitName +
        "}{}" +
        "\\raisebox{" +
        (baseline - htmlSec.offsetHeight) / fontSize +
        unitName +
        "}{}" +
        "}\\hspace{" +
        htmlSec.offsetWidth / fontSize +
        unitName +
        "}" + // the hspace is really just for debugging
        "}";
      anc.dataset.code += str;
      if (!anc.dataset.idList) anc.dataset.idList = subList.length;
      else anc.dataset.idList += " " + subList.length;
      subList.push([str, htmlSec]);
    }
    htmlSec = anc;
    if (closingInput) flushPendingErrorOutput(true);
  };

  obj.displayOutput = function (msg: string, isErrorOutput = false) {
    obj.openedHelp = false;
    if (isErrorOutput && shouldDeferErrorOutput()) {
      pendingErrorOutput += msg;
      scrollDownLeft(terminal);
      return;
    }
    if (procInputSpan !== null) {
      procInputSpan.remove();
      procInputSpan = null;
    }
    const txt = msg.replace(/\r/g, "").split(webAppRegex);
    for (let i = 0; i < txt.length; i += 2) {
      //console.log(i+"-"+(i+1)+"/"+txt.length+": ",i==0?"":webAppClasses[txt[i-1]]," : ",txt[i].replace("\n",returnSymbol));
      // if we are at the end of an input section
      if (
        inputEndFlag &&
        ((i == 0 && txt[i].length > 0) ||
          (i > 0 && txt[i - 1] !== webAppTags.InputContd))
      ) {
        closeHtml();
        inputEndFlag = false;
      }
      if (i > 0) {
        const tag = txt[i - 1];
        if (tag == webAppTags.End || tag == webAppTags.CellEnd) {
          if (htmlSec != terminal || !createInputSpan) {
            // htmlSec == terminal should only happen at very start
            // or at the very end for rendering help -- then it's OK
            while (htmlSec.classList.contains("M2Input")) closeHtml(); // M2Input is *NOT* closed by end tag but rather by \n
            // but in rare circumstances (ctrl-C interrupt) it may be missing its \n
            const oldHtmlSec = htmlSec;
            closeHtml();
          }
        } else if (tag === webAppTags.InputContd && inputEndFlag) {
          // continuation of input section
          inputEndFlag = false;
        } else {
          // new section
          createHtml(webAppClasses[tag]);
          if (
            inputSpan &&
            (tag === webAppTags.Input || tag === webAppTags.InputContd)
          ) {
            // input section: a bit special (ends at first \n)
            attachElement(inputSpan, htmlSec); // !!! we move the input inside the current span to get proper indentation !!!
          }
        }
      }

      if (txt[i].length > 0) {
        // for next round, check if we're nearing the end of an input section
        if (htmlSec.classList.contains("M2Input")) {
          const ii = txt[i].indexOf("\n");
          if (ii >= 0) {
            if (ii < txt[i].length - 1) {
              // need to do some surgery
              displayText(txt[i].substring(0, ii + 1));
              closeHtml();
              txt[i] = txt[i].substring(ii + 1, txt[i].length);
            } else inputEndFlag = true;
            // can't tell for sure if it's the end of input or not (could be a InputContd), so set a flag to remind us
          }
        }

        if (htmlSec.dataset.code !== undefined) htmlSec.dataset.code += txt[i];
        else displayText(txt[i]);
        //          if (l.contains("M2Html")) htmlSec.innerHTML = htmlSec.dataset.code; // used to update in real time
        // all other states are raw text -- don't rewrite htmlSec.textContent+=txt[i] in case of input
      }
    }
    flushPendingErrorOutput();
    scrollDownLeft(terminal);
  };

  const displayText = function (msg) {
    // Check if the message contains file paths with line numbers (Macaulay2 error format)
    // Common patterns: "filename.m2:123:" or "filename.m2:123:456:"
    const errorPattern = /([^\s:]+\.m2):(\d+)(?::(\d+))?:/g;

    if (errorPattern.test(msg)) {
      // Reset regex lastIndex for next use
      errorPattern.lastIndex = 0;

      let lastIndex = 0;
      let match;

      while ((match = errorPattern.exec(msg)) !== null) {
        // Add text before the match
        if (match.index > lastIndex) {
          const textBefore = msg.substring(lastIndex, match.index);
          const textNode = document.createTextNode(textBefore);
          if (inputSpan && inputSpan.parentElement == htmlSec)
            htmlSec.insertBefore(textNode, inputSpan);
          else htmlSec.appendChild(textNode);
        }

        // Create clickable link for the file path
        const [fullMatch, filePath, lineNum, colNum] = match;
        const link = document.createElement("a");
        link.textContent = fullMatch;
        link.href = "#";
        link.style.textDecoration = "underline";
        link.style.cursor = "pointer";

        // Build the VS Code fragment (file#line:column format)
        let fragment = filePath + "#" + lineNum;
        if (colNum) {
          fragment += ":" + colNum;
        }

        link.onclick = (e) => {
          e.preventDefault();
          emit("open", fragment);
        };

        if (inputSpan && inputSpan.parentElement == htmlSec)
          htmlSec.insertBefore(link, inputSpan);
        else htmlSec.appendChild(link);

        lastIndex = match.index + fullMatch.length;
      }

      // Add remaining text after the last match
      if (lastIndex < msg.length) {
        const textAfter = msg.substring(lastIndex);
        const textNode = document.createTextNode(textAfter);
        if (inputSpan && inputSpan.parentElement == htmlSec)
          htmlSec.insertBefore(textNode, inputSpan);
        else htmlSec.appendChild(textNode);
      }
    } else {
      // No error patterns found, display text normally
      const node = document.createTextNode(msg);
      if (inputSpan && inputSpan.parentElement == htmlSec)
        htmlSec.insertBefore(node, inputSpan);
      else htmlSec.appendChild(node);
    }
  };

  obj.reset = function () {
    console.log("Reset");
    emit("reset");
    createInputEl(); // recreate the input area
    interpreterDepth = 1;
  };
  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) resetBtn.onclick = obj.reset;

  obj.interrupt = function () {
    inputSpan.textContent = "";
    emit("interrupt");
    setCaretAtEndMaybe(inputSpan);
  };
  const interruptBtn = document.getElementById("interruptBtn");
  if (interruptBtn) interruptBtn.onclick = obj.interrupt;

  obj.locateStdio = function (cel: HTMLElement, row: number, column: number) {
    // find relevant input from stdio:row:column
    const query = '.M2PastInput[data-positions*=" ' + row + ':"]';
    const pastInputs = Array.from(
      cel.querySelectorAll(query) as NodeListOf<HTMLElement>,
    );
    if (pastInputs.length == 0) return null;

    const m = pastInputs.map((p) => p.dataset.positions.match(/ (\d+):(\d+) /));
    let i = 0;
    while (
      i + 1 < pastInputs.length &&
      (+m[i + 1][1] < row || (+m[i + 1][1] == row && +m[i + 1][2] <= column))
    )
      i++;
    const m1 = m[i];
    const txt = pastInputs[i].textContent;
    const offset = locateRowColumn(
      txt,
      row - +m1[1] + 1,
      row == +m1[1] ? column - +m1[2] : column,
    );
    if (offset === null) return null;
    const nodeOffset = locateOffset(pastInputs[i], offset);
    if (nodeOffset)
      // should always be true
      return [nodeOffset[0], nodeOffset[1], pastInputs[i], offset]; // node, offset in node, element, offset in element
  };

  obj.selectPastInput = function (el: HTMLElement, rowcols) {
    const cel = sessionCell(el);
    if (!cel) return;
    const nodeOffset1 = obj.locateStdio(cel, rowcols[0], rowcols[1]);
    if (!nodeOffset1) return;
    const nodeOffset2 = obj.locateStdio(cel, rowcols[2], rowcols[3]);
    if (!nodeOffset2 || nodeOffset2[2] != nodeOffset1[2]) return;
    const sel = window.getSelection();
    sel.setBaseAndExtent(
      nodeOffset1[0],
      nodeOffset1[1],
      nodeOffset2[0],
      nodeOffset2[1],
    );
    const marker = addMarkerPos(nodeOffset2[0], nodeOffset2[1]);
    if (rowcols[0] == rowcols[2] && rowcols[1] == rowcols[3])
      marker.classList.add("caret-marker");
    setTimeout(function () {
      marker.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "end",
      });
    }, 100);
  };

  if (inputSpan)
    window.addEventListener("load", function () {
      inputSpan.focus();
    });
};

export { Shell };
