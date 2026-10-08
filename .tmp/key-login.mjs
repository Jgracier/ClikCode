// src/runtime/lifecycle-log.ts
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join as join2 } from "node:path";

// src/session/store/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function stateDirectory() {
  return process.env.CLIKCODE_HOME?.trim() || join(homedir(), ".clikcode");
}

// src/runtime/lifecycle-log.ts
var ROTATE_BYTES = 10 * 1024 * 1024;
var ROTATE_CHECK_EVERY = 200;
var role = "command";
var session;
var linesSinceCheck = ROTATE_CHECK_EVERY;
function enabled() {
  return !process.env.VITEST || process.env.CLIKCODE_LIFECYCLE_LOG === "1";
}
function lifecycle(event, fields = {}) {
  if (!enabled()) return;
  try {
    const home = stateDirectory();
    if (!existsSync(home)) return;
    const dir = join2(home, "logs");
    mkdirSync(dir, { recursive: true, mode: 448 });
    const path = join2(dir, "lifecycle.log");
    if (++linesSinceCheck >= ROTATE_CHECK_EVERY) {
      linesSinceCheck = 0;
      try {
        if (statSync(path).size > ROTATE_BYTES) renameSync(path, `${path}.1`);
      } catch {
      }
    }
    const line = JSON.stringify({ ...fields, t: (/* @__PURE__ */ new Date()).toISOString(), pid: process.pid, role, ...session ? { session } : {}, event });
    appendFileSync(path, `${line}
`, { encoding: "utf8", mode: 384 });
  } catch {
  }
}

// src/harness/transport/native/login.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { createInterface } from "node:readline/promises";

// src/gateway/login/vendor-sign-in.ts
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join as join3 } from "node:path";

// src/harness/transport/spawn.ts
import crossSpawn from "cross-spawn";

// src/runtime/electron-env.ts
var VARIABLE = "ELECTRON_RUN_AS_NODE";
function childEnvironment(command, environment = process.env, self = process.execPath) {
  if (command === self || environment[VARIABLE] === void 0) return environment;
  const { [VARIABLE]: _dropped, ...rest } = environment;
  return rest;
}

// src/harness/transport/spawn.ts
var spawnPortable = ((command, args, options) => {
  if (!Array.isArray(args)) return spawnPortable(command, [], args);
  const env = childEnvironment(command, options?.env ?? process.env);
  return crossSpawn(command, args, env === (options?.env ?? process.env) ? options : { ...options, env });
});
function terminatePortable(child, signal = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" || !child.pid) {
    child.kill(signal);
    return;
  }
  const killer = crossSpawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true
  });
  killer.once("error", () => {
    if (child.exitCode === null) child.kill();
  });
}

// src/gateway/login/pty.ts
function shellQuote(parts) {
  return parts.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
}
var SIGN_IN_ROWS = 40;
var SIGN_IN_COLUMNS = 100;
var SIZED = `stty rows ${SIGN_IN_ROWS} cols ${SIGN_IN_COLUMNS} 2>/dev/null; exec`;
function scriptArgv(binary, args, platform = process.platform) {
  if (platform === "win32") return void 0;
  if (platform === "darwin") return ["-q", "/dev/null", "/bin/sh", "-c", `${SIZED} "$0" "$@"`, binary, ...args];
  return ["-q", "-e", "-f", "-c", `${SIZED} ${shellQuote([binary, ...args])}`, "/dev/null"];
}
async function runInPty(input) {
  const argv = scriptArgv(input.binary, input.args, input.platform);
  if (!argv) return { teed: false, exitCode: null };
  return new Promise((resolve, reject) => {
    const child = spawnPortable("script", [...argv], {
      stdio: ["pipe", "pipe", "pipe"],
      // A terminal of a known kind: under ClikCode's own TERM=dumb (a
      // script, a test) some vendors draw differently, or not at all.
      env: { ...process.env, ...!process.env.TERM || process.env.TERM === "dumb" ? { TERM: "xterm-256color" } : {}, ...input.env }
    });
    child.stdin?.on("error", () => {
    });
    input.onStdin((text) => {
      child.stdin?.write(text);
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const read = (chunk) => {
      try {
        input.onOutput(chunk);
      } catch {
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    const stop = () => {
      terminatePortable(child, "SIGTERM");
    };
    input.signal?.addEventListener("abort", stop, { once: true });
    process.once("SIGTERM", stop);
    if (process.platform !== "win32") process.once("SIGHUP", stop);
    const cleanup = () => {
      input.signal?.removeEventListener("abort", stop);
      process.off("SIGTERM", stop);
      if (process.platform !== "win32") process.off("SIGHUP", stop);
    };
    child.on("error", (error) => {
      cleanup();
      if (error.code === "ENOENT") resolve({ teed: false, exitCode: null });
      else reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      resolve({ teed: true, exitCode: code });
    });
  });
}

// src/gateway/login/screen.ts
var Screen = class {
  constructor(rows, columns) {
    this.rows = rows;
    this.columns = columns;
    this.grid = Array.from({ length: rows }, () => this.blank());
  }
  rows;
  columns;
  grid;
  row = 0;
  column = 0;
  saved = { row: 0, column: 0 };
  pending = "";
  blank() {
    return Array.from({ length: this.columns }, () => " ");
  }
  lineFeed() {
    if (this.row === this.rows - 1) {
      this.grid.shift();
      this.grid.push(this.blank());
    } else this.row += 1;
  }
  put(char) {
    if (this.column >= this.columns) {
      this.column = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.column] = char;
    this.column += 1;
  }
  clamp() {
    this.row = Math.max(0, Math.min(this.rows - 1, this.row));
    this.column = Math.max(0, Math.min(this.columns - 1, this.column));
  }
  eraseLine(mode, row = this.row) {
    const line = this.grid[row];
    const [from, to] = mode === 0 ? [this.column, this.columns] : mode === 1 ? [0, this.column + 1] : [0, this.columns];
    for (let index = from; index < to; index += 1) line[index] = " ";
  }
  eraseDisplay(mode) {
    if (mode === 2 || mode === 3) {
      this.grid = Array.from({ length: this.rows }, () => this.blank());
      return;
    }
    this.eraseLine(mode);
    const rows = mode === 0 ? [this.row + 1, this.rows] : [0, this.row];
    for (let index = rows[0]; index < rows[1]; index += 1) this.grid[index] = this.blank();
  }
  csi(params, final) {
    if (params.startsWith("?")) {
      if (/\b(?:1049|47|1047)\b/.test(params) && (final === "h" || final === "l")) this.eraseDisplay(2);
      return;
    }
    if (/^[<=>]/.test(params)) return;
    const numbers = params.split(";").map((part) => Number.parseInt(part, 10));
    const n = (index, fallback = 1) => Number.isFinite(numbers[index]) && numbers[index] > 0 ? numbers[index] : fallback;
    switch (final) {
      case "A":
        this.row -= n(0);
        break;
      case "B":
      case "e":
        this.row += n(0);
        break;
      case "C":
      case "a":
        this.column += n(0);
        break;
      case "D":
        this.column -= n(0);
        break;
      case "E":
        this.row += n(0);
        this.column = 0;
        break;
      case "F":
        this.row -= n(0);
        this.column = 0;
        break;
      case "G":
      case "`":
        this.column = n(0) - 1;
        break;
      case "d":
        this.row = n(0) - 1;
        break;
      case "H":
      case "f":
        this.row = n(0) - 1;
        this.column = n(1) - 1;
        break;
      case "J":
        this.eraseDisplay(Number.isFinite(numbers[0]) ? numbers[0] : 0);
        break;
      case "K":
        this.eraseLine(Number.isFinite(numbers[0]) ? numbers[0] : 0);
        break;
      case "X":
        for (let index = 0; index < n(0) && this.column + index < this.columns; index += 1) this.grid[this.row][this.column + index] = " ";
        break;
      case "P": {
        const line = this.grid[this.row];
        line.splice(this.column, n(0));
        while (line.length < this.columns) line.push(" ");
        break;
      }
      case "@": {
        const line = this.grid[this.row];
        line.splice(this.column, 0, ...Array.from({ length: n(0) }, () => " "));
        line.length = this.columns;
        break;
      }
      case "L":
        for (let index = 0; index < n(0); index += 1) {
          this.grid.splice(this.row, 0, this.blank());
          this.grid.length = this.rows;
        }
        break;
      case "M":
        for (let index = 0; index < n(0); index += 1) {
          this.grid.splice(this.row, 1);
          this.grid.push(this.blank());
        }
        break;
      case "S":
        for (let index = 0; index < n(0); index += 1) {
          this.grid.shift();
          this.grid.push(this.blank());
        }
        break;
      case "T":
        for (let index = 0; index < n(0); index += 1) {
          this.grid.pop();
          this.grid.unshift(this.blank());
        }
        break;
      case "s":
        this.saved = { row: this.row, column: this.column };
        break;
      case "u":
        ({ row: this.row, column: this.column } = this.saved);
        break;
      default:
        break;
    }
    this.clamp();
  }
  write(text) {
    const data = this.pending + text;
    this.pending = "";
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (char === "\x1B") {
        const rest = data.slice(index);
        const csi = /^\u001b\[([0-9;?<=>]*)[ -/]*([@-~])/.exec(rest);
        if (csi) {
          this.csi(csi[1], csi[2]);
          index += csi[0].length;
          continue;
        }
        const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/.exec(rest) ?? /^\u001b[P^_][^\u001b]*\u001b\\/.exec(rest);
        if (osc) {
          index += osc[0].length;
          continue;
        }
        if (rest.length >= 2 && /^\u001b[78]/.test(rest)) {
          if (rest[1] === "7") this.saved = { row: this.row, column: this.column };
          else ({ row: this.row, column: this.column } = this.saved);
          index += 2;
          continue;
        }
        if (/^\u001b[()#%][\s\S]/.test(rest)) {
          index += 3;
          continue;
        }
        if (/^\u001b[=>DEMc]/.test(rest)) {
          if (rest[1] === "D" || rest[1] === "E") {
            this.lineFeed();
            if (rest[1] === "E") this.column = 0;
          }
          if (rest[1] === "M") {
            if (this.row === 0) {
              this.grid.pop();
              this.grid.unshift(this.blank());
            } else this.row -= 1;
          }
          index += 2;
          continue;
        }
        if (/^\u001b(?:\[[0-9;?<=>]*[ -/]*|\][^\u0007\u001b]*|[P^_][^\u001b]*|[()#%])?$/.test(rest)) {
          this.pending = rest;
          return;
        }
        index += 1;
        continue;
      }
      if (char === "\r") this.column = 0;
      else if (char === "\n") {
        this.column = 0;
        this.lineFeed();
      } else if (char === "\b") this.column = Math.max(0, this.column - 1);
      else if (char === "	") this.column = Math.min(this.columns - 1, (Math.floor(this.column / 8) + 1) * 8);
      else if (char >= " " && char !== "\x7F") this.put(char);
      index += 1;
    }
  }
  state() {
    const lines = this.grid.map((line) => line.join("").trimEnd());
    while (lines.length > this.row + 1 && !lines.at(-1)) lines.pop();
    return { lines, row: this.row, column: this.column };
  }
};

// src/session/attachments.ts
function osc52Sequence(text, environment = process.env) {
  const payload = `\x1B]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
  if (environment.TMUX) return `\x1BPtmux;${payload.replace(/\u001b/g, "\x1B\x1B")}\x1B\\`;
  if (/^screen/.test(environment.TERM ?? "")) return `\x1BP${payload}\x1B\\`;
  return payload;
}
var IMAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

// src/gateway/login/url.ts
var ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
function stripAnsi(text) {
  return text.replace(ANSI, "");
}
function extractLoginUrl(text) {
  const urls = stripAnsi(text).match(/https:\/\/[^\s"'<>)\]\u2500-\u259f]+/g) ?? [];
  const isAuth = (url) => /\b(?:oauth2?|auth|authorize|authorise|login|sign-?in|device|activate)\b|user_code=|_device\b/i.test(url);
  return urls.filter(isAuth).sort((left, right) => right.length - left.length)[0];
}
function hasLocalDisplay(environment = process.env) {
  if (process.platform === "darwin" || process.platform === "win32") return !environment.SSH_CONNECTION;
  return Boolean(environment.DISPLAY || environment.WAYLAND_DISPLAY);
}
function shortenLoginUrl(url, maxLength = 56) {
  if (url.length <= maxLength) return url;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return `${url.slice(0, maxLength - 1)}\u2026`;
  }
  const shown = `https://${host}/\u2026`;
  return shown.length <= maxLength ? shown : `${shown.slice(0, maxLength - 1)}\u2026`;
}
function openLoginUrl(url, platform = process.platform) {
  const [command, args] = platform === "darwin" ? ["open", [url]] : platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawnPortable(command, [...args], { stdio: "ignore", detached: true });
  child.on("error", () => {
  });
  child.unref();
}
function loginUrlNotice(url, environment = process.env) {
  const local = hasLocalDisplay(environment);
  return {
    clipboard: osc52Sequence(url, environment),
    lines: [
      `ClikCode \xB7 sign-in link copied to your clipboard: ${shortenLoginUrl(url)}`,
      local ? "A browser should have opened here; paste the link if it did not." : "Paste it into your phone's browser, then come back and paste any code below."
    ]
  };
}

// src/gateway/login/vendor-sign-in.ts
function extractLoginCode(text, url) {
  if (url) {
    try {
      const fromUrl = new URL(url).searchParams.get("user_code");
      if (fromUrl) return fromUrl;
    } catch {
    }
  }
  const prose = stripAnsi(text).replace(/https?:\/\/\S+/g, " ");
  return prose.match(/(?<![\w-])[A-Z0-9]{4,5}-[A-Z0-9]{4,5}(?![\w-])/)?.[0];
}
function chooseLoginLink(input) {
  return input.local ? input.opened ?? input.printed : input.printed ?? input.opened;
}
var SECRET_WORDS = /api[ _-]?key|(?:\b|_)(?:key|token|secret|password)\b/i;
function isSecret(prompt) {
  return SECRET_WORDS.test(prompt.replace(/\([^)]*\)/g, ""));
}
var KEYS = {
  "{enter}": "\r",
  "{down}": "\x1B[B",
  "{up}": "\x1B[A",
  "{right}": "\x1B[C",
  "{left}": "\x1B[D",
  "{tab}": "	",
  "{esc}": "\x1B",
  "{space}": " ",
  "{ctrl-c}": "",
  "{ctrl-d}": ""
};
function titleAbove(lines, start, fallback = "") {
  return [...lines.slice(0, start)].reverse().map((line) => line.replace(/[│┃║]/g, " ").trim()).find((line) => /[A-Za-z]/.test(line) && !/^[┌└╭╰─━]|^>\s/.test(line) && !/\b(?:navigate|ENTER|ESC|select)\b.*\b(?:select|cancel|confirm)\b/i.test(line))?.replace(/^\?\s*/, "") ?? fallback;
}
function keystrokes(send) {
  return send.replace(/\{[a-z-]+\}/g, (token) => KEYS[token] ?? token);
}
function drawText(text) {
  const screen2 = new Screen(Math.max(24, text.split("\n").length + 2), 400);
  screen2.write(text);
  return screen2.state();
}
function screenLines(text) {
  return stripAnsi(text).split("\n").map((line) => (line.split("\r").filter((part) => part.trim()).pop() ?? "").trimEnd());
}
function readScreenPrompt(shown) {
  const state = typeof shown === "string" ? drawText(shown) : shown;
  const lines = state.lines;
  const before = (lines[state.row] ?? "").slice(0, state.column);
  const after = (lines[state.row] ?? "").slice(state.column);
  const last = !after.trim() ? before.trim() : "";
  if (last) {
    const yesNo = /^(.*?)\s*(?:\(Y\)es\/\(N\)o|\[(?:Y\/n|y\/N|y\/n|Y\/N)\])\s*(?:\[(Yes|No)\])?\s*:?$/i.exec(last);
    if (yesNo) {
      const defaultNo = /\[(?:y\/N)\]/.test(last) || yesNo[2]?.toLowerCase() === "no";
      return { kind: "choice", title: yesNo[1].trim(), choices: ["Yes", "No"], selected: defaultNo ? 1 : 0, style: "yes-no" };
    }
    if (/[:>?]$/.test(last) && last.length <= 140 && !/https?:\/\//.test(last.replace(/\[[^\]]*\]/g, ""))) {
      const prompt = last.replace(/\s*[:>?]$/, "").trim();
      const asksNumber = /\b(?:choice|choose|select|option|number)\b/i.test(prompt);
      const list = asksNumber ? numberedList(lines.slice(0, state.row), true) : void 0;
      if (list && list.prompt.kind === "choice") {
        const fallback = /\[default (\d+)\]/i.exec(prompt)?.[1];
        return { ...list.prompt, title: list.prompt.title || prompt, selected: fallback ? Number(fallback) - 1 : list.prompt.selected, style: "number" };
      }
      if (prompt) return { kind: "input", prompt, secret: isSecret(prompt), .../\(optional\b|\bdefault\b|\[[^\]]+\]$/i.test(prompt) ? { optional: true } : {} };
    }
  }
  const drawn = [readClack(lines), readEnquirer(lines), readNumbered(lines), readRadio(lines), readPointer(lines), readCards(lines), readInputBox(lines), readTitledField(state)].filter((found2) => Boolean(found2));
  const found = drawn.sort((left, right) => right.at - left.at)[0]?.prompt;
  if (found?.kind === "choice" && found.style === "arrows" && lines.some((line) => /\btype to (?:search|filter)\b|\bsearch [a-z]+\.\.\.|\bsearch:|\d+ more\b|^\s*\(\d+\/\d+\)\s*$/i.test(line))) {
    return { ...found, searchable: true };
  }
  return found;
}
function readTitledField(state) {
  const { lines, row } = state;
  for (let index = row - 1; index >= 0 && row - index <= 4; index -= 1) {
    const title = /^\s*[┌╭]─+\s*([^─┐╮]+?)\s*─/.exec(lines[index])?.[1];
    if (!title) continue;
    const closed = lines.slice(row + 1, row + 5).some((line) => /^\s*[└╰]─/.test(line));
    if (!closed || !/[A-Za-z]/.test(title)) return void 0;
    return { prompt: { kind: "input", prompt: title, secret: isSecret(title) }, at: index };
  }
  return void 0;
}
function readCards(lines) {
  const cards = [];
  let open2 = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*[╭┌]─/.test(line)) {
      open2 = index;
      continue;
    }
    if (/^\s*[╰└]─/.test(line) && open2 >= 0) {
      const rows = lines.slice(open2 + 1, index);
      const first = rows.map((row) => row.replace(/^\s*>?\s*│\s?|\s*│\s*$/g, "").trim()).find(Boolean);
      const current = first !== void 0 && /→\s*$/.test(first) || rows.some((row) => /^\s*>\s*│/.test(row));
      if (first) cards.push({ at: open2, label: first.replace(/^[^\p{L}\p{N}(]+\s*/u, "").replace(/\s*→$/, "").trim(), current });
      open2 = -1;
    }
  }
  const run = [];
  for (const card of cards.reverse()) {
    if (run.length && run[0].at - card.at > 8) break;
    run.unshift(card);
  }
  const selected = run.findIndex((card) => card.current);
  if (run.length < 2 || selected < 0) return void 0;
  if (!lines.slice(run.at(-1).at).some((line) => /↑|↓|\bnavigate\b|\benter (?:to )?select\b/i.test(line))) return void 0;
  return { prompt: { kind: "choice", title: titleAbove(lines, run[0].at), choices: run.map((card) => card.label), selected, style: "arrows" }, at: run[0].at };
}
function readRadio(lines) {
  const option = (line) => /^\s*(?:[→>›❯]\s*)?\((●|○)\)\s+(?!\d+\.\s)(.+?)\s*$/.exec(line);
  let end = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) if (option(lines[index])) {
    end = index;
    break;
  }
  if (end < 0) return void 0;
  let start = end;
  while (start > 0 && option(lines[start - 1])) start -= 1;
  const found = lines.slice(start, end + 1).map((line) => option(line));
  const selected = found.findIndex((match) => match[1] === "\u25CF");
  if (found.length < 2 || selected < 0) return void 0;
  const title = titleAbove(lines, start, "Choose one");
  return { prompt: { kind: "choice", title, choices: found.map((match) => match[2]), selected, style: "arrows" }, at: start };
}
function readInputBox(lines) {
  const hint = (line) => /\benter to (?:submit|save|confirm|continue)\b|↵\s*submit\b/i.test(line);
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) if (hint(lines[index])) {
    at = index;
    break;
  }
  if (at < 0) return void 0;
  const content = (line) => line.replace(/^\s*[│┃]\s?|\s*[│┃]\s*$/g, "").trim();
  let top = -1;
  for (let index = at; index >= 0 && at - index < 40; index -= 1) {
    if (/^\s*[┌╭]/.test(lines[index])) {
      top = index;
      break;
    }
  }
  let bottom = -1;
  if (top >= 0) {
    for (let index = top + 1; index < lines.length; index += 1) if (/^\s*[└╰]/.test(lines[index])) {
      bottom = index;
      break;
    }
  }
  if (top >= 0 && bottom >= 0 && (bottom >= at || at - bottom <= 3)) {
    const inside = lines.slice(top + 1, bottom).map(content).filter(Boolean).filter((line) => !hint(line));
    const parts = (inside[0] ?? "").split(/\s+·\s+/).filter((part) => !/^Step \d+\/\d+$/i.test(part));
    const label = [lines[top - 1], lines[top - 2]].map((line) => (line ?? "").trim()).find((line) => /[A-Za-z]/.test(line) && line.length <= 60);
    const field = inside.length <= 1 && label ? label : parts.at(-1) ?? label ?? "";
    if (!field) return void 0;
    const prompt = parts.length > 1 ? `${parts[0]}: ${field}` : field;
    return { prompt: { kind: "input", prompt, secret: isSecret(field) || inside.length <= 1 && isSecret(inside[0] ?? "") }, at: top };
  }
  const typing = lines.slice(Math.max(0, at - 4), at).find((line) => /^\s*[>❭]/.test(line));
  if (typing === void 0) return void 0;
  const placeholder = typing.replace(/^\s*[>❭]\s*/, "").trim();
  for (let index = at - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || /^[>❭]/.test(line)) continue;
    const label = line.replace(/\s*:$/, "");
    const prompt = placeholder.length > label.length && /[A-Za-z]{3}/.test(placeholder) ? placeholder : label;
    return { prompt: { kind: "input", prompt, secret: isSecret(prompt) || isSecret(label) }, at: index };
  }
  return void 0;
}
function readPointer(lines) {
  const plain = lines.map((line) => line.replace(/[│┃║]/g, " ").trimEnd());
  const marker = (line) => /^\s*[›>→❯]\s+(?!\([●○]\)|[│┃])\S/.test(line);
  let at = -1;
  for (let index = plain.length - 1; index >= 0; index -= 1) if (marker(plain[index]) && !/^\s*[›>→❯]\s*[│┃]/.test(lines[index])) {
    at = index;
    break;
  }
  if (at < 0) return void 0;
  const indent = (line) => {
    const shown = line.replace(/[›>→❯]/, " ");
    return shown.length - shown.trimStart().length;
  };
  const column = indent(plain[at]);
  const inMenu = (line) => !/^\s*[─━]{3,}|^\s*\(\d+\/\d+\)\s*$/.test(line) && (!line.trim() || indent(line) === column);
  const entryAt = (index) => Boolean(plain[index]?.trim()) && indent(plain[index]) === column;
  const heading = (index) => Boolean(plain[index].trim()) && indent(plain[index]) < column && entryAt(index - 1) && entryAt(index + 1);
  let first = at;
  while (first > 0 && (inMenu(plain[first - 1]) || heading(first - 1))) first -= 1;
  let last = at;
  while (last < plain.length - 1 && (inMenu(plain[last + 1]) || heading(last + 1))) last += 1;
  const groups = [];
  for (let index = first; index <= last; index += 1) {
    if (heading(index)) continue;
    if (!plain[index].trim()) {
      if (groups.at(-1)?.length) groups.push([]);
      continue;
    }
    if (!groups.length) groups.push([]);
    groups.at(-1).push(index);
  }
  const filled = groups.filter((group) => group.length);
  const entries = filled.length > 1 ? filled.map((group) => group[0]) : filled[0] ?? [];
  if (!entries.includes(at) || entries.length < (/^\s*[❯→]/.test(plain[at]) ? 1 : 2)) return void 0;
  const title = titleAbove(lines, entries[0]);
  return {
    prompt: {
      kind: "choice",
      title,
      choices: entries.map((index) => plain[index].trim().replace(/^[›>→❯]\s*/, "")),
      selected: entries.indexOf(at),
      style: "arrows"
    },
    at: entries[0]
  };
}
function readClack(lines) {
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/[◇■▲]/.test(line)) return void 0;
    if (line.includes("\u25C6")) {
      at = index;
      break;
    }
  }
  if (at < 0) return void 0;
  const title = lines[at].replace(/^.*◆\s*/, "").trim();
  const choices = [];
  let selected = 0;
  for (const line of lines.slice(at + 1)) {
    const inline = /^\s*[│|]?\s*([●○])\s+(.+?)\s+\/\s+([●○])\s+(.+?)\s*$/.exec(line);
    if (inline) {
      return { prompt: { kind: "choice", title, choices: [inline[2], inline[4]], selected: inline[3] === "\u25CF" ? 1 : 0, style: "sideways" }, at };
    }
    const option = /^\s*[│|]?\s*([●○])\s+(.+?)\s*$/.exec(line);
    if (!option) continue;
    if (option[1] === "\u25CF") selected = choices.length;
    choices.push(option[2]);
  }
  if (choices.length) return { prompt: { kind: "choice", title, choices, selected, style: "arrows" }, at };
  return title ? { prompt: { kind: "input", prompt: title, secret: isSecret(title) }, at } : void 0;
}
function readEnquirer(lines) {
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*\?\s+\S/.test(lines[index])) {
      at = index;
      break;
    }
  }
  if (at < 0) return void 0;
  const options = lines.slice(at + 1).filter((line) => line.trim());
  const firstRepeat = options.findIndex((line, index) => index > 0 && line.trim().replace(/^❯\s*/, "") === options[0].trim().replace(/^❯\s*/, ""));
  const drawing = firstRepeat > 0 ? options.slice(options.length - firstRepeat) : options;
  if (!drawing.some((line) => /^\s*❯/.test(line))) return void 0;
  const choices = drawing.map((line) => line.trim().replace(/^❯\s*/, ""));
  const selected = Math.max(0, drawing.findIndex((line) => /^\s*❯/.test(line)));
  const title = lines[at].replace(/^\s*\?\s*/, "").replace(/\s*[›»].*$/, "").trim();
  const shownAt = lines.lastIndexOf(drawing[0]);
  return { prompt: { kind: "choice", title, choices, selected, style: "arrows" }, at: Math.max(at, shownAt) };
}
function numberedList(lines, unmarked = false) {
  const plain = lines.map((line) => line.replace(/[│┃║]/g, " ").trimEnd());
  const option = (line) => /^\s*(?:([●›❯>❭])|\((●|○)\))?\s*(\d+)[.)]?\s+(\S.*?)\s*$/.exec(line);
  let index = plain.length - 1;
  while (index >= 0 && !option(plain[index])) index -= 1;
  if (index < 0) return void 0;
  const found = [];
  let expected = Number(option(plain[index])[3]);
  if (expected < 2) return void 0;
  let gap = 0;
  for (; index >= 0 && expected >= 1; index -= 1) {
    const match = option(plain[index]);
    if (match && Number(match[3]) === expected) {
      found.unshift({ at: index, match });
      expected -= 1;
      gap = 0;
      continue;
    }
    if (++gap > 3) return void 0;
  }
  if (expected !== 0) return void 0;
  const marked = found.findIndex(({ match }) => match[1] || match[2] === "\u25CF");
  if (marked < 0 && !unmarked) return void 0;
  const start = found[0].at;
  const title = titleAbove(lines, start);
  return {
    prompt: { kind: "choice", title: title.replace(/^\?\s*/, ""), choices: found.map(({ match }) => match[4]), selected: Math.max(0, marked), style: "arrows" },
    at: start,
    marked: marked >= 0
  };
}
function readNumbered(lines) {
  return numberedList(lines);
}
function choiceKeys(prompt, to) {
  if (prompt.style === "yes-no") return to === 0 ? "y\r" : "n\r";
  if (prompt.style === "number") return `${to + 1}\r`;
  const moves = to - prompt.selected;
  if (prompt.style === "sideways") return `${(moves >= 0 ? "\x1B[C" : "\x1B[D").repeat(Math.abs(moves))}\r`;
  return `${(moves >= 0 ? KEYS["{down}"] : KEYS["{up}"]).repeat(Math.abs(moves))}\r`;
}
function terminalReplies(chunk, cursor) {
  let reply = "";
  for (const match of chunk.matchAll(/\u001b\[(?:0?c|6n|\?(\d+)\$p|>0?q|5n)|\u001b\](1[01]);\?(?:\u0007|\u001b\\)/g)) {
    const query = match[0];
    if (/^\u001b\[0?c$/.test(query)) reply += "\x1B[?62;22c";
    else if (query === "\x1B[6n") reply += `\x1B[${cursor.row + 1};${cursor.column + 1}R`;
    else if (query === "\x1B[5n") reply += "\x1B[0n";
    else if (match[1]) reply += `\x1B[?${match[1]};2$y`;
    else if (/^\u001b\[>0?q$/.test(query)) reply += "\x1BP>|xterm(388)\x1B\\";
    else if (match[2]) reply += `\x1B]${match[2]};rgb:${match[2] === "10" ? "ffff/ffff/ffff" : "0000/0000/0000"}\x1B\\`;
  }
  return reply;
}
function compact(text) {
  return stripAnsi(text).replace(/\s+/g, "").toLowerCase();
}
var OPENERS = ["xdg-open", "open", "gio", "sensible-browser", "x-www-browser", "www-browser"];
async function openerStandIns() {
  const dir = await mkdtemp(join3(tmpdir(), "clikcode-open-"));
  const log = join3(dir, "opened");
  const script = `#!/bin/sh
for a; do case "$a" in http://*|https://*) printf '%s\\n' "$a" >> "$CLIKCODE_OPENED";; esac; done
`;
  await Promise.all(OPENERS.map(async (name) => {
    await writeFile(join3(dir, name), script);
    await chmod(join3(dir, name), 493);
  }));
  return { dir, log };
}
var SEARCH_CHOICE = "Search for another\u2026";
var SETTLE_MS = 350;
var REDRAW_MS = 4e3;
var SIGNED_IN_POLL_MS = 1e3;
var SIGNED_IN_GRACE_MS = 1500;
var STEP_AGAIN_MS = 2e3;
var MAX_UNREAD_MS = 1e3;
var KEY_GAP_MS = 100;
async function runVendorSignIn(input) {
  const { ui } = input;
  const cancelled = () => new Error(`sign-in to ${input.displayName} was cancelled`);
  if (ui.signal?.aborted) throw cancelled();
  const controller2 = new AbortController();
  const abort = () => controller2.abort();
  ui.signal?.addEventListener("abort", abort, { once: true });
  const standIns = process.platform === "win32" ? void 0 : await openerStandIns();
  const env = {
    ...input.env,
    ...standIns ? {
      PATH: `${standIns.dir}${delimiter}${input.env.PATH ?? process.env.PATH ?? ""}`,
      BROWSER: join3(standIns.dir, "xdg-open"),
      CLIKCODE_OPENED: standIns.log
    } : {}
  };
  let raw = "";
  const screen2 = new Screen(SIGN_IN_ROWS, SIGN_IN_COLUMNS);
  let changed = false;
  let opened;
  let shown;
  let write = () => void 0;
  let exited = false;
  const fired = /* @__PURE__ */ new Map();
  let answeredAt = 0;
  let answering = false;
  let lastPrompt;
  let settle;
  const publishLink = () => {
    const url = chooseLoginLink({ printed: extractLoginUrl(raw), opened, local: input.local });
    if (!url) return;
    const code = extractLoginCode(raw, url);
    if (shown && shown.url === url && shown.code === code) return;
    shown = { url, ...code ? { code } : {} };
    try {
      ui.show(shown);
    } catch {
    }
  };
  const answer = async (work) => {
    answering = true;
    try {
      const keys = await work();
      if (exited) return;
      if (keys === void 0) {
        abort();
        return;
      }
      answeredAt = raw.length;
      changed = false;
      for (const key of keys.match(/\u001b\[[A-D]|[\r\u0003\u0004]|[^\r\u0003\u0004\u001b]+|\u001b/g) ?? []) {
        if (exited) return;
        write(key);
        await new Promise((resolve) => setTimeout(resolve, KEY_GAP_MS));
      }
    } finally {
      answering = false;
    }
  };
  const read = () => {
    if (answering || exited) return;
    publishLink();
    const since = compact(raw.slice(answeredAt));
    const index = input.steps?.findIndex((rule, at) => Date.now() - (fired.get(at) ?? 0) >= STEP_AGAIN_MS && since.includes(compact(rule.when))) ?? -1;
    const next = index >= 0 ? input.steps[index] : void 0;
    if (next) {
      fired.set(index, Date.now());
      void answer(async () => next.ask ? `${await ui.ask(next.ask.prompt, Boolean(next.ask.secret))}\r` : keystrokes(next.send ?? "")).finally(schedule);
      return;
    }
    if (!changed) return;
    const prompt = readScreenPrompt(screen2.state());
    if (!prompt) return;
    const key = `${prompt.kind}:${prompt.kind === "choice" ? prompt.title : prompt.prompt}`;
    if (lastPrompt && lastPrompt.key === key && Date.now() - lastPrompt.at < REDRAW_MS) return;
    lastPrompt = { key, at: Date.now() };
    let searched = false;
    void answer(async () => {
      if (prompt.kind === "input") return `${await ui.ask(prompt.prompt, prompt.secret, prompt.optional)}\r`;
      const choices = prompt.searchable ? [...prompt.choices, SEARCH_CHOICE] : prompt.choices;
      const index2 = await ui.choose(prompt.title, choices, prompt.selected);
      if (index2 === void 0) return void 0;
      if (index2 === prompt.choices.length) {
        searched = true;
        return ui.ask(`Search ${prompt.title.replace(/:$/, "")}`, false);
      }
      return choiceKeys(prompt, index2);
    }).finally(() => {
      lastPrompt = searched ? void 0 : { key, at: Date.now() };
      schedule();
    });
  };
  let deadline;
  const readNow = () => {
    if (settle) clearTimeout(settle);
    if (deadline) clearTimeout(deadline);
    settle = void 0;
    deadline = void 0;
    read();
  };
  const schedule = () => {
    if (settle) clearTimeout(settle);
    settle = setTimeout(readNow, SETTLE_MS);
    deadline ??= setTimeout(readNow, MAX_UNREAD_MS);
  };
  const onOutput = (chunk) => {
    raw += chunk;
    screen2.write(chunk);
    const replies = terminalReplies(chunk, screen2.state());
    if (replies) write(replies);
    changed = true;
    publishLink();
    schedule();
  };
  let succeeded = false;
  const watch = input.signedIn ? setInterval(() => {
    if (succeeded) return;
    void input.signedIn().then((done) => {
      if (!done || succeeded) return;
      succeeded = true;
      setTimeout(abort, SIGNED_IN_GRACE_MS);
    }, () => void 0);
  }, SIGNED_IN_POLL_MS) : void 0;
  const poll = standIns ? setInterval(() => {
    void readFile(standIns.log, "utf8").then((text) => {
      const last = text.trim().split("\n").pop();
      if (last && last !== opened) {
        opened = last;
        publishLink();
      }
    }, () => void 0);
  }, 200) : void 0;
  let exitCode;
  try {
    const teed = await runInPty({
      binary: input.binary,
      args: input.args,
      env,
      onOutput,
      onStdin: (send) => {
        write = send;
      },
      signal: controller2.signal
    });
    exitCode = teed.teed ? teed.exitCode : await runPiped(input.binary, input.args, env, onOutput, (send) => {
      write = send;
    }, controller2.signal);
  } finally {
    exited = true;
    ui.signal?.removeEventListener("abort", abort);
    if (poll) clearInterval(poll);
    if (watch) clearInterval(watch);
    if (settle) clearTimeout(settle);
    if (deadline) clearTimeout(deadline);
    if (standIns) await rm(standIns.dir, { recursive: true, force: true }).catch(() => void 0);
  }
  if (succeeded) return;
  if (controller2.signal.aborted) throw cancelled();
  if (exitCode !== 0) {
    const said = screenLines(raw).map((line) => line.trim()).filter(Boolean).pop();
    throw new Error(`${input.displayName} sign-in exited with status ${exitCode}${said ? `: ${said}` : ""}`);
  }
}
function runPiped(binary, args, env, onOutput, onStdin, signal) {
  return new Promise((resolve, reject) => {
    const child = spawnPortable(binary, [...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    const abort = () => {
      terminatePortable(child, "SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdin?.on("error", () => {
    });
    onStdin((text) => {
      child.stdin?.write(text);
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", abort);
      resolve(code);
    });
  });
}

// src/runtime/lazy-bridge.ts
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// src/harness/custom-acp.ts
import { readFileSync, statSync as statSync2 } from "node:fs";
import { join as join4 } from "node:path";

// src/session/store/files.ts
import { randomBytes } from "node:crypto";
import { chmod as chmod2, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
var hardenedDirectories = /* @__PURE__ */ new Set();
async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 448 });
  if (hardenedDirectories.has(directory)) return;
  await chmod2(directory, 448).catch(() => void 0);
  hardenedDirectories.add(directory);
}
async function atomicWriteFile(path, data) {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, "w", 384);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    renamed = true;
  } finally {
    if (!renamed) await unlink(temporary).catch(() => void 0);
  }
  await syncDirectory(directory);
}
async function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r").catch(() => void 0);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
  } finally {
    await handle.close();
  }
}

// src/harness/custom-acp.ts
function customAcpConfigPath() {
  return join4(stateDirectory(), "custom-acp.json");
}
function parseCustomAcpConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.harnesses)) return [];
  const records = [];
  for (const entry of parsed.harnesses) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry;
    if (typeof record.command !== "string" || typeof record.binary !== "string") continue;
    const argv = Array.isArray(record.argv) ? record.argv.filter((arg) => typeof arg === "string") : [];
    records.push({
      command: record.command,
      binary: record.binary,
      argv,
      ...typeof record.displayName === "string" ? { displayName: record.displayName } : {},
      ...typeof record.provider === "string" ? { provider: record.provider } : {}
    });
  }
  return records;
}
var loadedSignature;
var CHECK_MS = 1e3;
var lastCheck;
function reloadCustomAcpHarnesses(catalog) {
  const path = customAcpConfigPath();
  const now = Date.now();
  if (lastCheck?.path === path && now - lastCheck.at < CHECK_MS) return;
  lastCheck = { path, at: now };
  let signature;
  let text;
  try {
    const stat4 = statSync2(path, { throwIfNoEntry: false });
    if (!stat4) {
      if (loadedSignature !== void 0 && loadedSignature !== "missing") catalog.registerCustomHarnesses([]);
      loadedSignature = "missing";
      return;
    }
    signature = `${stat4.mtimeMs}:${stat4.size}`;
    if (signature === loadedSignature) return;
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let records;
  try {
    records = parseCustomAcpConfig(text);
  } catch {
    return;
  }
  const definitions = [];
  for (const record of records) {
    try {
      definitions.push(catalog.customAcpHarness(record));
    } catch {
    }
  }
  catalog.registerCustomHarnesses(definitions);
  loadedSignature = signature;
}

// src/harness/transport/native/install-locations.ts
import { homedir as homedir2 } from "node:os";
import { join as join5 } from "node:path";
function managedNpmPrefix() {
  return join5(stateDirectory(), "tools", "npm");
}
function npmPrefixBinDir(prefix, platform = process.platform) {
  return platform === "win32" ? prefix : join5(prefix, "bin");
}
function installStepFor(installer, platform = process.platform) {
  return platform === "win32" ? installer?.windows : installer?.posix;
}
function expandInstallDir(dir, env = process.env, home = homedir2()) {
  let unresolved = false;
  const expanded = dir.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const value2 = env[name] ?? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (!value2) unresolved = true;
    return value2 ?? "";
  });
  if (unresolved) return void 0;
  if (expanded === "~") return home;
  if (expanded.startsWith("~/")) return join5(home, expanded.slice(2));
  return expanded;
}
function harnessInstallDirs(harnesses, options = {}) {
  const platform = options.platform ?? process.platform;
  const dirs = /* @__PURE__ */ new Set();
  for (const harness of harnesses) {
    for (const dir of installStepFor(harness.installer, platform)?.binDirs ?? []) {
      const expanded = expandInstallDir(dir, options.env, options.home);
      if (expanded) dirs.add(expanded);
    }
  }
  dirs.add(npmPrefixBinDir(managedNpmPrefix(), platform));
  return [...dirs];
}
function pathKey(env) {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}
function withPathDirs(pathValue, dirs, platform = process.platform) {
  const separator = platform === "win32" ? ";" : ":";
  const normalize = (dir) => {
    const trimmed = dir.replace(/^"|"$/g, "").replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const entries = pathValue ? pathValue.split(separator) : [];
  const present2 = new Set(entries.map(normalize));
  for (const dir of dirs) {
    if (!dir || present2.has(normalize(dir))) continue;
    entries.push(dir);
    present2.add(normalize(dir));
  }
  return entries.join(separator);
}
function addToProcessPath(dirs, env = process.env, platform = process.platform) {
  const key = pathKey(env);
  env[key] = withPathDirs(env[key] ?? "", dirs, platform);
}
var augmented = false;
function augmentProcessPath(harnesses) {
  if (augmented) return;
  augmented = true;
  addToProcessPath(harnessInstallDirs(harnesses));
}

// src/runtime/lazy-bridge.ts
var require2 = createRequire(import.meta.url);
function sibling(name) {
  const attempts = [
    () => require2(`../${name}`),
    () => require2(fileURLToPath(new URL(`./${name}`, import.meta.url))),
    // Source tests and a source entry load the bundle the build already wrote.
    () => require2(fileURLToPath(new URL(`../../dist/${name}`, import.meta.url)))
  ];
  let missing;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
      missing = error;
    }
  }
  throw missing;
}
var catalogRuntime;
function localCatalog() {
  if (!catalogRuntime) {
    catalogRuntime = sibling("harness-catalog.cjs");
    augmentProcessPath(catalogRuntime.allLocalHarnesses());
  }
  reloadCustomAcpHarnesses(catalogRuntime);
  return catalogRuntime;
}
var localHarnessForCommand = (command) => localCatalog().localHarnessForCommand(command);
var keyProviders = () => localCatalog().KEY_PROVIDERS;

// src/harness/transport/native/binary.ts
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter as delimiter2, extname, isAbsolute, join as join6 } from "node:path";
function executableNames(binary, platform = process.platform, pathExt = process.env.PATHEXT) {
  if (platform !== "win32" || extname(binary)) return [binary];
  const extensions = (pathExt || ".COM;.EXE;.BAT;.CMD").split(";").map((value2) => value2.trim()).filter(Boolean);
  return [binary, ...extensions.map((extension) => `${binary}${extension.startsWith(".") ? extension : `.${extension}`}`)];
}
async function binaryOnPath(binary, options = {}) {
  return Boolean(await resolveBinaryPath(binary, options));
}
async function resolveBinaryPath(binary, options = {}) {
  const platform = options.platform ?? process.platform;
  const names = executableNames(binary, platform, options.pathExt ?? process.env.PATHEXT);
  const directories = isAbsolute(binary) ? [""] : (options.path ?? process.env.PATH ?? "").split(platform === "win32" ? ";" : delimiter2);
  for (const rawDirectory of directories) {
    const directory = rawDirectory.replace(/^"|"$/g, "") || ".";
    for (const name of names) {
      const candidate = isAbsolute(name) ? name : join6(directory, name);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
      }
    }
  }
  return void 0;
}

// src/session/store/json-memo.ts
import { readFile as readFile2, stat } from "node:fs/promises";
import { join as join7 } from "node:path";

// src/session/store/cached-file.ts
function fileIdentity(info) {
  return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

// src/session/store/data.ts
function sameData(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const a2 = left;
    const b2 = right;
    if (a2.length !== b2.length) return false;
    for (let index = 0; index < a2.length; index += 1) if (!sameData(a2[index], b2[index])) return false;
    return true;
  }
  const a = left;
  const b = right;
  let defined = 0;
  for (const key of Object.keys(a)) {
    if (a[key] === void 0) continue;
    defined += 1;
    if (!sameData(a[key], b[key])) return false;
  }
  let otherDefined = 0;
  for (const key of Object.keys(b)) if (b[key] !== void 0) otherDefined += 1;
  return defined === otherDefined;
}

// src/session/store/json-memo.ts
var isFields = (value2) => !!value2 && typeof value2 === "object" && !Array.isArray(value2);
function fold(base, ours, theirs, depth) {
  for (const key of /* @__PURE__ */ new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const [b, o, t] = [base[key], ours[key], theirs[key]];
    if (depth === 0 && isFields(b) && isFields(o) && isFields(t)) {
      fold(b, o, t, 1);
      continue;
    }
    if (!sameData(o, b)) continue;
    if (t === void 0) delete ours[key];
    else ours[key] = t;
  }
}
function jsonMemo(relativePath, empty, accept) {
  let held;
  const memoPath = () => {
    if (process.env.VITEST && !process.env.CLIKCODE_HOME?.trim()) return void 0;
    const directory = stateDirectory();
    return directory ? join7(directory, relativePath) : void 0;
  };
  const parse = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? accept(parsed) : void 0;
    } catch {
      return void 0;
    }
  };
  const readAt = async (path) => {
    if (!path) return void 0;
    const raw = await readFile2(path, "utf8").catch(() => void 0);
    return raw === void 0 ? void 0 : parse(raw);
  };
  const identityOf = (path) => stat(path).then(fileIdentity, () => void 0);
  const snapshot = async (path) => {
    const identity = path ? await identityOf(path) : void 0;
    const raw = identity && path ? await readFile2(path, "utf8").catch(() => void 0) : void 0;
    const read = () => (raw === void 0 ? void 0 : parse(raw)) ?? empty();
    return { theirs: read(), base: read(), identity };
  };
  const sync = async (current) => {
    if (!current.path || await identityOf(current.path) === current.identity) return;
    const { theirs, base, identity } = await snapshot(current.path);
    if (held !== current) return;
    if (isFields(current.data) && isFields(current.base) && isFields(theirs)) fold(current.base, current.data, theirs, 0);
    else if (sameData(current.data, current.base)) current.data = theirs;
    current.base = base;
    current.identity = identity;
  };
  const store = async (current) => {
    current.dirty = false;
    const raw = JSON.stringify(current.data);
    if (!await atomicWriteFile(current.path, raw).then(() => true, () => false)) return;
    current.base = parse(raw) ?? empty();
    current.identity = await identityOf(current.path);
  };
  const load = async () => {
    const path = memoPath() ?? "";
    if (held && held.path === path) {
      await sync(held);
      return held;
    }
    const { theirs, base, identity } = await snapshot(path || void 0);
    if (held && held.path === path) return held;
    held = { path, data: theirs, base, identity, dirty: false };
    return held;
  };
  return {
    async load() {
      return (await load()).data;
    },
    read: () => readAt(memoPath()),
    changed() {
      if (held) held.dirty = true;
    },
    get dirty() {
      return Boolean(held?.dirty);
    },
    async save() {
      if (!held?.dirty || held.path !== (memoPath() ?? "") || !held.path) return;
      const current = held;
      await sync(current);
      await store(current);
    },
    async write(data) {
      const path = memoPath() ?? "";
      held = { path, data, base: data, identity: void 0, dirty: true };
      if (path) await store(held);
    },
    reset() {
      held = void 0;
    }
  };
}

// src/harness/transport/native/version-memo.ts
var memo = jsonMemo("harness-versions.json", () => ({ v: 1, harnesses: {} }), (parsed) => {
  const file = parsed;
  return file.v === 1 && file.harnesses && typeof file.harnesses === "object" ? file : void 0;
});
function resetVersionMemo() {
  memo.reset();
}

// src/harness/transport/native/install.ts
import { constants as constants2 } from "node:fs";
import { access as access2, mkdir as mkdir2, mkdtemp as mkdtemp2, readFile as readFile3, rm as rm2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir3, tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname2, join as join8 } from "node:path";

// src/tui/active-terminal.ts
var TERMINAL = {};

// src/harness/install-progress.ts
var FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
var FRAME_MS = 80;
var FAILURE_TAIL_LINES = 12;
function installFailureTail(output, limit = FAILURE_TAIL_LINES) {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() && !/^\s*(?:npm (?:notice|fund|warn deprecated)|\d+ packages are looking for funding|run `npm fund`)/i.test(line));
  return lines.slice(-limit).join("\n");
}
function startSpinner(label, write = (text) => process.stdout.write(text), isTty = process.stdout.isTTY) {
  if (!isTty) {
    write(`${label}
`);
    return { stop: (finalLine) => {
      if (finalLine) write(`${finalLine}
`);
    } };
  }
  let frame = 0;
  const paint = () => {
    write(`\r\x1B[2K\x1B[2m${FRAMES[frame % FRAMES.length]}\x1B[0m ${label}`);
    frame += 1;
  };
  paint();
  const timer = setInterval(paint, FRAME_MS);
  timer.unref?.();
  return {
    stop: (finalLine) => {
      clearInterval(timer);
      write(`\r\x1B[2K${finalLine ? `${finalLine}
` : ""}`);
    }
  };
}

// src/harness/transport/native/install-route.ts
function harnessInstallRoute(spec, platform = process.platform) {
  if (spec.surface === "editor-extension") {
    return { kind: "none", reason: `${spec.displayName} is an editor extension, not a standalone terminal harness; ClikCode cannot broker it as a native TUI.` };
  }
  if (spec.npmPackage) return { kind: "npm", package: spec.npmPackage };
  const step = installStepFor(spec.installer, platform);
  if (step?.kind === "script") return { kind: "script", step };
  if (step?.kind === "uv-tool") return { kind: "uv-tool", step };
  if (spec.installer) {
    return { kind: "none", reason: `${spec.displayName} publishes no installer for ${platformName(platform)}; see ${spec.installer.docs}.` };
  }
  return { kind: "none", reason: `ClikCode has no installer for ${spec.displayName}; install it so a \`${spec.binary}\` command is on PATH.` };
}
function platformName(platform) {
  return platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
}
function manualInstallCommand(route, platform = process.platform) {
  switch (route.kind) {
    case "npm":
      return `npm install -g ${route.package}`;
    case "uv-tool":
      return `uv tool install ${route.step.python ? `--python ${route.step.python} ` : ""}${route.step.package}${(route.step.with ?? []).map((name) => ` --with ${name}`).join("")}`;
    case "script": {
      const args = route.step.args ?? [];
      if (platform === "win32") {
        const env2 = Object.entries(route.step.env ?? {}).map(([name, value2]) => `$env:${name}='${value2}'; `).join("");
        return args.length ? `${env2}& ([scriptblock]::Create((irm '${route.step.url}'))) ${args.join(" ")}` : `${env2}irm '${route.step.url}' | iex`;
      }
      const env = Object.entries(route.step.env ?? {}).map(([name, value2]) => `${name}=${value2} `).join("");
      return `curl -fsSL '${route.step.url}' | ${env}bash${args.length ? ` -s -- ${args.join(" ")}` : ""}`;
    }
    default:
      return void 0;
  }
}

// src/harness/transport/native/install.ts
var processReporter;
function defaultReporter() {
  if (processReporter) return processReporter;
  const terminal = TERMINAL.active;
  if (terminal) {
    return {
      start: (label) => terminal.startWaiting(label),
      done: () => terminal.stopWaiting(),
      failed: () => terminal.stopWaiting()
    };
  }
  let spinner;
  const write = (text) => {
    process.stderr.write(text);
  };
  return {
    start: (label) => {
      spinner?.stop();
      spinner = startSpinner(label, write, process.stderr.isTTY);
    },
    done: (message) => {
      spinner?.stop(message);
      spinner = void 0;
    },
    failed: () => {
      spinner?.stop();
      spinner = void 0;
    }
  };
}
function requiredBinaries(spec) {
  return [.../* @__PURE__ */ new Set([spec.binary, ...spec.acp?.binary ? [spec.acp.binary] : []])];
}
async function missingBinaries(spec) {
  const missing = [];
  for (const binary of requiredBinaries(spec)) if (!await resolveBinaryPath(binary)) missing.push(binary);
  return missing;
}
var inFlight = /* @__PURE__ */ new Map();
async function ensureHarnessInstalled(spec, options = {}) {
  const route = harnessInstallRoute(spec);
  if (spec.surface === "editor-extension" && route.kind === "none") throw new Error(route.reason);
  if (!(await missingBinaries(spec)).length) return false;
  if (route.kind === "none") throw new Error(installFailureMessage(spec, route, new Error(route.reason)));
  const running = inFlight.get(spec.command);
  if (running) return running;
  const work = installOnce(spec, route, options.reporter ?? defaultReporter());
  inFlight.set(spec.command, work);
  try {
    return await work;
  } finally {
    inFlight.delete(spec.command);
  }
}
async function installOnce(spec, route, reporter) {
  const label = `installing ${spec.displayName}\u2026`;
  let shown = false;
  const show = (text) => {
    shown = true;
    reporter.start(text);
  };
  try {
    const installed = await withInstallLock(spec.command, async () => {
      if (!(await missingBinaries(spec)).length) return false;
      show(label);
      const missingBefore = await missingBinaries(spec);
      try {
        if (missingBefore.includes(spec.binary) || !spec.acp?.npmPackage) await runRoute(spec, route);
        if (spec.acp?.binary && spec.acp.npmPackage && missingBefore.includes(spec.acp.binary)) {
          await installNpmPackage(spec.acp.npmPackage);
        }
      } catch (error) {
        if (route.kind !== "script" || (await missingBinaries(spec)).length) throw error;
      }
      const missing = await missingBinaries(spec);
      if (missing.length) {
        throw new Error(`the installer finished, but \`${missing.join("`, `")}\` is not on PATH or in ${searchedDirs(route).join(", ") || "any directory it declares"}`);
      }
      return true;
    }, () => show(`waiting for another ClikCode to finish installing ${spec.displayName}\u2026`));
    if (installed) reporter.done(`Installed ${spec.displayName}.`);
    else if (shown) reporter.done(`${spec.displayName} is installed.`);
    return installed;
  } catch (error) {
    const message = installFailureMessage(spec, route, error);
    if (shown) reporter.failed(message);
    throw new Error(message, { cause: error });
  }
}
function installFailureMessage(spec, route, error) {
  const reason = error instanceof Error ? error.message : String(error);
  if (route.kind === "none") return `${reason} Then retry /${spec.command}.`;
  const manual = manualInstallCommand(route);
  const source = route.kind === "npm" ? "" : ` (from ${spec.installer?.docs ?? "the vendor"})`;
  return `Could not install ${spec.displayName} automatically: ${reason}` + (manual ? `

To install it yourself${source}:

    ${manual}

Then retry /${spec.command}.` : "");
}
function searchedDirs(route) {
  if (route.kind === "script" || route.kind === "uv-tool") {
    return route.step.binDirs.map((dir) => expandInstallDir(dir)).filter((dir) => Boolean(dir));
  }
  return [];
}
async function runRoute(spec, route) {
  if (route.kind === "npm") return installNpmPackage(route.package);
  addToProcessPath(searchedDirs(route));
  if (route.kind === "script") return runInstallerScript(route.step);
  return installUvTool(route.step);
}
function runInstallCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPortable(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      ...options.cwd ? { cwd: options.cwd } : {}
    });
    let output = "";
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > 256e3) output = output.slice(-128e3);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => {
      output += `
${command} did not finish within ${Math.round((options.timeoutMs ?? INSTALL_TIMEOUT_MS) / 6e4)} minutes and was stopped.`;
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          terminatePortable(child, "SIGKILL");
        }
      } else terminatePortable(child, "SIGKILL");
    }, options.timeoutMs ?? INSTALL_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}
var INSTALL_TIMEOUT_MS = 20 * 6e4;
function commandFailure(what, result) {
  const tail = installFailureTail(result.output);
  return new Error(`${what} exited ${result.code ?? "abnormally"}${tail ? `
${tail}` : ""}`);
}
async function npmGlobalPrefix() {
  try {
    const result = await runInstallCommand("npm", ["prefix", "--global"], { timeoutMs: 6e4 });
    const prefix = result.output.trim().split(/\r?\n/).pop()?.trim();
    return result.code === 0 && prefix ? prefix : void 0;
  } catch {
    return void 0;
  }
}
async function npmPrefixWritable(prefix, platform = process.platform) {
  const targets = platform === "win32" ? [join8(prefix, "node_modules"), prefix] : [join8(prefix, "lib", "node_modules"), join8(prefix, "bin")];
  for (const target of targets) {
    let candidate = target;
    for (; ; ) {
      try {
        await stat2(candidate);
        break;
      } catch {
        const parent = dirname2(candidate);
        if (parent === candidate) return false;
        candidate = parent;
      }
    }
    try {
      await access2(candidate, constants2.W_OK);
    } catch {
      return false;
    }
  }
  return true;
}
function isPermissionFailure(output) {
  return /\b(EACCES|EPERM|EROFS)\b|permission denied|read-only file system/i.test(output);
}
async function installNpmPackage(npmPackage) {
  const globalPrefix = await npmGlobalPrefix();
  if (globalPrefix && await npmPrefixWritable(globalPrefix)) {
    const result2 = await runInstallCommand("npm", ["install", "--global", npmPackage]);
    if (result2.code === 0) {
      addToProcessPath([npmPrefixBinDir(globalPrefix)]);
      return;
    }
    if (!isPermissionFailure(result2.output)) throw commandFailure(`npm install --global ${npmPackage}`, result2);
  }
  const prefix = managedNpmPrefix();
  await mkdir2(prefix, { recursive: true });
  const result = await runInstallCommand("npm", ["install", "--global", "--prefix", prefix, npmPackage]);
  if (result.code !== 0) throw commandFailure(`npm install --global --prefix ${prefix} ${npmPackage}`, result);
  addToProcessPath([npmPrefixBinDir(prefix)]);
}
function assertInstallerUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`installer URL is not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`refusing to run an installer from a non-https URL: ${url}`);
  return parsed;
}
async function downloadInstaller(url, destination) {
  assertInstallerUrl(url);
  let body;
  let fetchError;
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12e4) });
    assertInstallerUrl(response.url || url);
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    body = await response.text();
  } catch (error) {
    fetchError = error;
  }
  if (body === void 0) {
    const result = await runInstallCommand("curl", ["-fsSL", "--proto", "=https", "--proto-redir", "=https", "-o", destination, url], { timeoutMs: 18e4 }).catch(() => void 0);
    if (result?.code === 0) return;
    throw new Error(`could not download ${url}: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
  }
  if (!body.trim()) throw new Error(`${url} returned an empty installer`);
  await writeFile2(destination, body, { mode: 448 });
}
async function firstOnPath(names) {
  for (const name of names) if (await resolveBinaryPath(name)) return name;
  return void 0;
}
async function runInstallerScript(step) {
  const windows = process.platform === "win32";
  const directory = await mkdtemp2(join8(tmpdir2(), "clikcode-install-"));
  try {
    const script = join8(directory, windows ? "install.ps1" : "install.sh");
    await downloadInstaller(step.url, script);
    const env = { ...process.env, ...step.env ?? {} };
    let command;
    let args;
    if (windows) {
      command = await firstOnPath(["pwsh", "powershell"]) ?? "powershell";
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...step.args ?? []];
    } else {
      command = await firstOnPath(["bash", "sh"]) ?? "sh";
      args = [script, ...step.args ?? []];
    }
    const result = await runInstallCommand(command, args, { env, cwd: directory });
    if (result.code !== 0) throw commandFailure(`the installer from ${step.url}`, result);
  } finally {
    await rm2(directory, { recursive: true, force: true }).catch(() => void 0);
  }
}
var UV_INSTALLER = {
  posix: "https://astral.sh/uv/install.sh",
  windows: "https://astral.sh/uv/install.ps1"
};
async function installUvTool(step) {
  addToProcessPath([join8(homedir3(), ".local", "bin"), join8(homedir3(), ".cargo", "bin")]);
  if (!await resolveBinaryPath("uv")) {
    await runInstallerScript({
      kind: "script",
      url: process.platform === "win32" ? UV_INSTALLER.windows : UV_INSTALLER.posix,
      // ClikCode finds ~/.local/bin itself; the user's shell profile is left alone.
      env: { UV_NO_MODIFY_PATH: "1" },
      binDirs: ["~/.local/bin"]
    });
    if (!await resolveBinaryPath("uv")) throw new Error("uv was installed but cannot be found in ~/.local/bin");
  }
  const installArgv = [
    "tool",
    "install",
    ...step.python ? ["--python", step.python] : [],
    step.package,
    ...(step.with ?? []).flatMap((name) => ["--with", name])
  ];
  const result = await runInstallCommand("uv", installArgv);
  if (result.code !== 0) throw commandFailure(`uv ${installArgv.join(" ")}`, result);
  const bin = await runInstallCommand("uv", ["tool", "dir", "--bin"], { timeoutMs: 6e4 }).catch(() => void 0);
  const dir = bin?.code === 0 ? bin.output.trim().split(/\r?\n/).pop()?.trim() : void 0;
  if (dir) addToProcessPath([dir]);
}
var LOCK_STALE_MS = INSTALL_TIMEOUT_MS + 5 * 6e4;
var LOCK_POLL_MS = 250;
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
var LOCK_MAX_WAIT_MS = 10 * 60 * 1e3;
async function withInstallLock(key, work, onWait, options = {}) {
  const directory = options.directory ?? join8(stateDirectory(), "tools", "locks");
  await mkdir2(directory, { recursive: true });
  const lock = join8(directory, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
  const owner = join8(lock, "owner.json");
  let waited = false;
  const waitStarted = Date.now();
  for (; ; ) {
    try {
      await mkdir2(lock);
      await writeFile2(owner, JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let holder;
    try {
      holder = JSON.parse(await readFile3(owner, "utf8"));
    } catch {
      holder = void 0;
    }
    const since = holder?.at ?? await stat2(lock).then((info) => info.mtimeMs).catch(() => Date.now());
    const dead = holder?.pid !== void 0 && !processAlive(holder.pid);
    if (dead || Date.now() - since > (options.staleMs ?? LOCK_STALE_MS)) {
      await rm2(lock, { recursive: true, force: true }).catch(() => void 0);
      continue;
    }
    if (!waited) {
      waited = true;
      onWait?.();
    }
    if (Date.now() - waitStarted > (options.maxWaitMs ?? LOCK_MAX_WAIT_MS)) {
      throw new Error(`another ClikCode install of ${key} is still running (pid ${holder?.pid ?? "unknown"}); try again once it finishes`);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? LOCK_POLL_MS));
  }
  try {
    return await work();
  } finally {
    await rm2(lock, { recursive: true, force: true }).catch(() => void 0);
  }
}

// src/harness/transport/native/inspect.ts
var inspectionCache = /* @__PURE__ */ new Map();
var pickerInspectionCache = /* @__PURE__ */ new Map();
function clearNativeHarnessInspectionCache(command) {
  if (command === void 0) {
    inspectionCache.clear();
    pickerInspectionCache.clear();
    return;
  }
  inspectionCache.delete(command);
  pickerInspectionCache.delete(command);
  resetVersionMemo();
}
async function ensureNativeHarness(spec, options = {}) {
  const installed = await ensureHarnessInstalled(spec, options);
  if (installed) clearNativeHarnessInspectionCache(spec.command);
  return installed;
}

// src/harness/transport/native/command.ts
var CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;
async function captureNativeHarnessOutput(spec, args, envOverrides = {}, timeoutMs = 15e3, cwd, stdinText) {
  if (!await binaryOnPath(spec.binary)) throw Object.assign(new Error(`${spec.displayName} is not installed (no \`${spec.binary}\` on PATH)`), { code: "ENOENT" });
  return new Promise((resolve, reject) => {
    const child = spawnPortable(spec.binary, [...args], { stdio: [stdinText === void 0 ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, ...envOverrides }, ...cwd ? { cwd } : {} });
    if (stdinText !== void 0) {
      child.stdin?.on("error", () => void 0);
      child.stdin?.end(stdinText);
    }
    let stdout = "";
    let stderr = "";
    let exceededLimit = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > CAPTURE_LIMIT_BYTES) {
        exceededLimit = true;
        terminatePortable(child);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk;
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (exceededLimit) return finish(new Error(`${spec.displayName} helper output exceeded ${CAPTURE_LIMIT_BYTES / 1024 / 1024} MiB`));
      if (code !== 0) return finish(new Error(`${spec.binary} ${signal ? `stopped (${signal})` : `exited ${code ?? 1}`}${stderr.trim() ? `: ${stderr.trim().slice(-2e3)}` : ""}`));
      finish();
    });
    const timer = setTimeout(() => {
      terminatePortable(child);
      finish(new Error(`${spec.displayName} helper timed out`));
    }, timeoutMs);
    timer.unref();
  });
}

// src/harness/accounts/auth-files.ts
import { readdir, readFile as readFile4, rm as rm3, stat as stat3, writeFile as writeFile3 } from "node:fs/promises";
import { homedir as homedir4 } from "node:os";
function expandAuthPath(path, environment, home = homedir4()) {
  const expanded = path.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    const value2 = environment[name]?.trim();
    return value2 || (fallback ?? "");
  });
  const profileHome = environment.HOME?.trim() || home;
  return expanded.startsWith("~") ? `${profileHome}${expanded.slice(1)}` : expanded;
}
async function present(entry, environment) {
  const path = expandAuthPath(entry.path, environment);
  try {
    if (path.endsWith("/")) return (await readdir(path)).length > 0;
    if (entry.contains === void 0) return (await stat3(path)).size > 0;
    return (await readFile4(path, "utf8")).includes(entry.contains);
  } catch {
    return false;
  }
}
async function authFilesStamp(harness, profileEnvironment, processEnvironment = process.env) {
  const environment = { ...processEnvironment, ...profileEnvironment };
  const parts = await Promise.all((harness.authFiles ?? []).map(async (entry) => {
    const path = expandAuthPath(entry.path, environment);
    try {
      const info = await stat3(path);
      return `${path}:${info.size}:${info.mtimeMs}:${await present(entry, environment)}`;
    } catch {
      return `${path}:-`;
    }
  }));
  return parts.join("|");
}
async function authFilePresent(harness, profileEnvironment, processEnvironment = process.env) {
  const environment = { ...processEnvironment, ...profileEnvironment };
  for (const entry of harness.authFiles ?? []) if (await present(entry, environment)) return true;
  return false;
}

// src/harness/transport/native/login.ts
var screens = new AsyncLocalStorage();
function withSignInScreen(screen2, work) {
  return screens.run(screen2, work);
}
function plainSignInScreen(name) {
  let opened = false;
  const controller2 = new AbortController();
  const line = async (prompt) => {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await reader.question(prompt);
    } finally {
      reader.close();
    }
  };
  return {
    signal: controller2.signal,
    show: (link) => {
      const local = hasLocalDisplay();
      if (local && !opened) {
        opened = true;
        openLoginUrl(link.url);
      }
      process.stdout.write(`${local ? "" : loginUrlNotice(link.url).clipboard}Sign in to ${name}: ${link.url}
${link.code ? `Code: ${link.code}
` : ""}`);
    },
    ask: (prompt) => line(`${prompt}: `),
    choose: async (title, choices) => {
      process.stdout.write(`${title}
${choices.map((choice, index) => `  ${index + 1}. ${choice}`).join("\n")}
`);
      const picked = Number.parseInt(await line("Number: "), 10);
      return picked >= 1 && picked <= choices.length ? picked - 1 : void 0;
    },
    stop: () => void 0
  };
}
async function loginNativeHarness(spec, envOverrides = {}) {
  lifecycle("signin.start", { harness: spec.command });
  try {
    await loginNativeHarnessInner(spec, envOverrides);
    lifecycle("signin.end", { harness: spec.command, outcome: "signed in" });
  } catch (error) {
    lifecycle("signin.end", { harness: spec.command, outcome: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
    throw error;
  }
}
async function loginNativeHarnessInner(spec, envOverrides) {
  await ensureNativeHarness(spec);
  const own = screens.getStore();
  const screen2 = own ?? plainSignInScreen(spec.displayName);
  const local = hasLocalDisplay();
  try {
    if (spec.loginKeyCommand) {
      await signInWithKey(spec, spec.loginKeyCommand, envOverrides, screen2);
      return;
    }
    const before = spec.authFiles?.length ? await authFilesStamp(spec, envOverrides) : void 0;
    await runVendorSignIn({
      ...before !== void 0 ? { signedIn: async () => await authFilesStamp(spec, envOverrides) !== before && authFilePresent(spec, envOverrides) } : {},
      binary: spec.binary,
      args: !local && spec.loginRemoteArgv ? spec.loginRemoteArgv : spec.loginArgv ?? [],
      env: envOverrides,
      displayName: spec.displayName,
      local,
      ...spec.loginSteps ? { steps: spec.loginSteps } : {},
      ui: spec.loginKeyRoutes && ownLogin(spec) ? await keyRoutedScreen(spec, spec.loginKeyRoutes, screen2) : screen2
    });
  } finally {
    if (!own) screen2.stop();
  }
}
function ownLogin(spec) {
  return JSON.stringify(spec.loginArgv ?? []) === JSON.stringify(localHarnessForCommand(spec.command)?.loginArgv ?? []);
}
async function signInWithKey(spec, command, env, screen2) {
  const cancelled = () => new Error(`sign-in to ${spec.displayName} was cancelled`);
  const listed = await captureNativeHarnessOutput(spec, command.providersArgv, env);
  const providers = [...new Set(listed.split("\n").map((line) => line.trim().split(/\s+/)[0] ?? "").filter((word) => /^[a-z][\w.-]*$/i.test(word)))];
  if (!providers.length) throw new Error(`${spec.displayName} listed no providers to sign in to`);
  const index = await screen2.choose(`Sign in to ${spec.displayName} with`, providers);
  if (index === void 0 || screen2.signal.aborted) throw cancelled();
  const key = (await screen2.ask(`${providers[index]} API key`, true)).trim();
  if (!key || screen2.signal.aborted) throw cancelled();
  const argv = command.setArgv.map((part) => part.replace("{provider}", providers[index]));
  await captureNativeHarnessOutput(spec, argv, env, 3e4, void 0, `${key}
`);
}
async function keyRoutedScreen(spec, routes, screen2, providers = keyProviders()) {
  const key = (await screen2.ask(`${spec.displayName} API key, or Enter to choose a provider`, true, true)).trim();
  if (screen2.signal.aborted) throw new Error(`sign-in to ${spec.displayName} was cancelled`);
  if (!key) return screen2;
  const candidates = keyCandidates(routes, key, providers);
  const accepted = await Promise.all(candidates.map((route2) => acceptsKey(route2, key, providers, screen2.signal)));
  const route = candidates[accepted.indexOf(true)];
  if (!route) throw new Error(`no provider ${spec.displayName} signs in to accepts that key -- check it was copied whole`);
  const labels = [...route.choose];
  let searched;
  let keyGiven = false;
  const defaults = () => keyGiven && !labels.length;
  return {
    signal: screen2.signal,
    show: (link) => screen2.show(link),
    choose: async (title, choices, selected) => {
      const label = labels[0];
      const at = label === void 0 ? -1 : optionFor(choices, label);
      if (at >= 0) {
        labels.shift();
        searched = void 0;
        return at;
      }
      if (label !== void 0 && searched === void 0 && choices.at(-1) === SEARCH_CHOICE) {
        searched = label;
        return choices.length - 1;
      }
      if (defaults() && selected !== void 0) return selected;
      return screen2.choose(title, choices, selected);
    },
    ask: async (prompt, secret, optional) => {
      if (searched !== void 0 && prompt.startsWith("Search ")) return searched.replace(/\s*\(.*$/, "");
      if (secret && !keyGiven) {
        keyGiven = true;
        return key;
      }
      if (defaults() && /\[[^\]]+\]$/.test(prompt)) return "";
      return screen2.ask(prompt, secret, optional);
    }
  };
}
function optionFor(choices, label) {
  const want = label.toLowerCase();
  const lower = choices.map((choice) => choice.toLowerCase());
  const exact = lower.indexOf(want);
  return exact >= 0 ? exact : lower.findIndex((choice) => choice.startsWith(want) && /^\s+[^\p{L}\p{N}\s]/u.test(choice.slice(want.length)));
}
function keyCandidates(routes, key, providers) {
  const issues = (provider) => Boolean(provider.prefixes?.some((prefix) => key.startsWith(prefix)));
  const claimed = Object.values(providers).some(issues);
  return routes.filter((route) => {
    if (!("provider" in route)) return true;
    const provider = providers[route.provider];
    return claimed ? issues(provider) : !provider.prefixes || Boolean(provider.unprefixed);
  });
}
async function acceptsKey(route, key, providers, signal) {
  const provider = "provider" in route ? providers[route.provider] : void 0;
  const auth = provider?.header ? { [provider.header]: key } : { authorization: `Bearer ${key}` };
  try {
    const response = provider ? await fetch(provider.probe, { headers: { ...auth, ...provider.headers }, signal: AbortSignal.any([signal, AbortSignal.timeout(15e3)]) }) : await fetch(route.url, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ model: "probe", messages: [] }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15e3)])
    });
    await response.body?.cancel();
    return provider ? response.ok : response.status !== 401 && response.status !== 403;
  } catch {
    return false;
  }
}

// packages/clikrouter/src/ai-local-harness.ts
var maxPromptArgvBytes = 96 * 1024;
var HOME_REDIRECT_ENV_DEFAULTS = {
  GIT_CONFIG_GLOBAL: "~/.gitconfig",
  NPM_CONFIG_USERCONFIG: "~/.npmrc",
  // npx keeps every MCP server it runs here; one per profile was 2.5 GB.
  NPM_CONFIG_CACHE: "~/.npm",
  // pnpm's own cache and store, the same duplication for pnpm installs.
  NPM_CONFIG_CACHE_DIR: "~/.cache/pnpm",
  NPM_CONFIG_STORE_DIR: "~/.local/share/pnpm/store",
  GH_CONFIG_DIR: "~/.config/gh",
  DOCKER_CONFIG: "~/.docker",
  GNUPGHOME: "~/.gnupg",
  CARGO_HOME: "~/.cargo",
  RUSTUP_HOME: "~/.rustup",
  SSH_AUTH_SOCK: null,
  GIT_SSH_COMMAND: null
};
var HOME_REDIRECT_ENV_PASSTHROUGH = Object.keys(HOME_REDIRECT_ENV_DEFAULTS);
var OPENCODE_FAMILY = {
  surface: "terminal",
  transport: "acp",
  integration: "structured",
  parser: "opencode-json",
  memoryFile: "AGENTS.md",
  nativeSlashPassthrough: false,
  customCommandDirs: [".opencode/command", "~/.config/opencode/command"],
  acp: { argv: ["acp"], inheritCliOptions: false, sharedSessions: true },
  localAuth: ["api-key", "oauth", "vendor-cli"],
  loginArgv: ["auth", "login"],
  providerLoginArgv: ["auth", "login", "--provider", "{provider}"],
  // Kilo's list (a fork) names them the same; both checked signed out.
  loginKeyRoutes: providerKeyRoutes([], {
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
    openai: ["OpenAI", "Manually enter API Key"],
    google: "Google",
    xai: ["xAI", "Manually enter API Key"],
    groq: "Groq",
    cerebras: "Cerebras",
    huggingface: "Hugging Face",
    fireworks: "Fireworks AI",
    mistral: "Mistral",
    deepseek: "DeepSeek",
    moonshot: "Moonshot AI",
    "moonshot-cn": "Moonshot AI (China)",
    zai: "Z.AI",
    minimax: "MiniMax (minimax.io)",
    together: "Together AI"
  }),
  authFiles: [{ path: "${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json", contains: '"type"' }],
  modelProviderSeparator: "/",
  modelArgvPrefix: ["--model"],
  modelDiscoveryArgv: ["models"],
  workspaceArgvPrefix: ["--dir"],
  effortArgvPrefix: ["--variant"],
  effortValues: ["minimal", "low", "medium", "high", "max"],
  permissionModes: ["ask", "bypass"],
  permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--auto"] } },
  normalizedPermissionOptionIds: ["auto-approve"],
  imageArgvPrefix: ["--file"],
  turn: { promptGuard: "double-dash", startArgv: ["run", "--format", "json"], resumeIdPrefix: ["--session"], output: "json-lines", responseFields: ["text", "content"] },
  session: { resumeIdPrefix: ["--session"], continueArgv: ["--continue"], discoverArgv: ["session", "list", "--format", "json"], discoverFormat: "json" }
};
var { customCommandDirs: _openCodeCommandDirs, normalizedPermissionOptionIds: _openCodePermissionAliases, ...OPENCODE_FORK_BASE } = OPENCODE_FAMILY;
var HERMES_REPLY_ERRORS = [
  { pattern: "^(?:API call failed after \\d+ retries: )?HTTP (\\d{3})\\b" },
  { pattern: "^No access token found for .+ login", status: 401 }
];
var COPILOT_REPLY_ERRORS = [
  { pattern: "^Error: .+ \\(Request ID: [0-9A-Fa-f:]+\\)$" }
];
var GOOSE_REPLY_ERRORS = [
  { pattern: "^Ran into this error: [\\s\\S]*Please retry if you think this is a transient or recoverable error\\.$" }
];
var AUGGIE_REPLY_ERRORS = [
  { pattern: "^\\s*(?:\u26A0\uFE0F\\s*)?\\*{0,2}You have run out of usage for\\b", status: 402 }
];
var CURSOR_REPLY_ERRORS = [
  { pattern: "(?:^|\\n\\n)Upgrade your (?:plan|account) to continue\\.?\\s*$", status: 402 },
  { pattern: "(?:^|\\n\\n)Add a payment method to continue\\.?\\s*$", status: 402 },
  { pattern: "(?:^|\\n\\n)Please sign in to continue\\.?\\s*$", status: 401 }
];
function providerKeyRoutes(first, labels) {
  return Object.entries(labels).map(([provider, label]) => ({ provider, choose: [...first, ...typeof label === "string" ? [label] : label] }));
}
var LOCAL_BIN = "~/.local/bin";
var HARNESS_INSTALLERS = {
  // Symlinks `cursor-agent` (and `agent`) into ~/.local/bin; on Windows it
  // copies cursor-agent.cmd into %LOCALAPPDATA%\cursor-agent.
  cursor: {
    posix: { kind: "script", url: "https://cursor.com/install", binDirs: [LOCAL_BIN] },
    windows: { kind: "script", url: "https://cursor.com/install?win32=true", binDirs: ["${LOCALAPPDATA}/cursor-agent"] },
    docs: "https://cursor.com/docs/cli/installation"
  },
  // aider.chat's scripts install uv, then `uv tool install aider-chat`.
  aider: {
    posix: { kind: "script", url: "https://aider.chat/install.sh", binDirs: [LOCAL_BIN] },
    windows: { kind: "script", url: "https://aider.chat/install.ps1", binDirs: [LOCAL_BIN] },
    docs: "https://aider.chat/docs/install.html"
  },
  // block/goose now redirects to aaif-goose/goose: the project moved, it was
  // not forked (same repository, homepage goose-docs.ai). CONFIGURE=false is
  // the scripts' documented switch for not starting `goose configure`.
  goose: {
    posix: { kind: "script", url: "https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh", env: { CONFIGURE: "false" }, binDirs: [LOCAL_BIN] },
    windows: { kind: "script", url: "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1", env: { CONFIGURE: "false" }, binDirs: [LOCAL_BIN] },
    docs: "https://goose-docs.ai/docs/getting-started/installation"
  },
  // A single binary: /usr/local/bin when writable (already on every PATH, so
  // not listed), else ~/.local/bin. There is no Windows script; the
  // documented install there is uv's.
  openhands: {
    posix: { kind: "script", url: "https://install.openhands.dev/install.sh", binDirs: [LOCAL_BIN] },
    windows: { kind: "uv-tool", package: "openhands", python: "3.12", binDirs: [LOCAL_BIN] },
    docs: "https://docs.openhands.dev/openhands/usage/cli/installation"
  },
  // Installs uv if needed, then mistral-vibe (which ships `vibe` and `vibe-acp`).
  vibe: {
    posix: { kind: "script", url: "https://mistral.ai/vibe/install.sh", binDirs: [LOCAL_BIN] },
    windows: { kind: "uv-tool", package: "mistral-vibe", binDirs: [LOCAL_BIN] },
    docs: "https://docs.mistral.ai/vibe/code/cli/install-setup"
  },
  // --non-interactive / -NonInteractive: the scripts' own switch for skipping
  // the stages that ask (API keys, settings) -- ClikCode signs in separately.
  hermes: {
    posix: { kind: "script", url: "https://hermes-agent.nousresearch.com/install.sh", args: ["--non-interactive"], binDirs: [LOCAL_BIN] },
    windows: { kind: "script", url: "https://hermes-agent.nousresearch.com/install.ps1", args: ["-NonInteractive"], binDirs: ["${LOCALAPPDATA}/hermes/bin"] },
    docs: "https://hermes-agent.nousresearch.com/docs/getting-started/installation"
  },
  // `kiro-cli` into ~/.local/bin on Linux. On macOS the script installs the
  // Kiro CLI app into /Applications, whose bundle carries the binary; on
  // Windows an MSI into Program Files.
  kiro: {
    posix: { kind: "script", url: "https://cli.kiro.dev/install", binDirs: [LOCAL_BIN, "/Applications/Kiro CLI.app/Contents/MacOS"] },
    windows: { kind: "script", url: "https://cli.kiro.dev/install.ps1", binDirs: ["${ProgramFiles}/Kiro-Cli", "${ProgramFiles}/Kiro-Cli/bin"] },
    docs: "https://kiro.dev/docs/cli/installation/"
  },
  // A native Go binary -- no Node, no npm -- at ~/.local/bin/agy.
  antigravity: {
    posix: { kind: "script", url: "https://antigravity.google/cli/install.sh", binDirs: [LOCAL_BIN] },
    windows: { kind: "script", url: "https://antigravity.google/cli/install.ps1", binDirs: ["${LOCALAPPDATA}/agy/bin"] },
    docs: "https://antigravity.google/docs/cli/install/"
  },
  // The ACP adapter is a separate Python extra, so installing only
  // deepagents-code would leave `dcode --acp` unusable.
  dcode: {
    posix: { kind: "uv-tool", package: "deepagents-code", with: ["deepagents-acp"], binDirs: [LOCAL_BIN] },
    windows: { kind: "uv-tool", package: "deepagents-code", with: ["deepagents-acp"], binDirs: [LOCAL_BIN] },
    docs: "https://github.com/langchain-ai/deepagents/blob/main/libs/acp/README.md"
  },
  devin: {
    posix: { kind: "script", url: "https://cli.devin.ai/install.sh", binDirs: [LOCAL_BIN] },
    windows: { kind: "script", url: "https://static.devin.ai/cli/setup.ps1", binDirs: ["${LOCALAPPDATA}/devin/cli/bin"] },
    docs: "https://docs.devin.ai/cli"
  },
  junie: {
    posix: { kind: "script", url: "https://junie.jetbrains.com/install.sh", binDirs: [LOCAL_BIN] },
    windows: { kind: "script", url: "https://junie.jetbrains.com/install.ps1", binDirs: [LOCAL_BIN] },
    docs: "https://junie.jetbrains.com/docs/junie-cli.html"
  },
  mcode: {
    posix: { kind: "script", url: "https://filecdn.minimax.chat/public/install.sh", binDirs: ["~/.minimax-code/bin"] },
    windows: { kind: "script", url: "https://filecdn.minimax.chat/public/install.ps1", binDirs: ["~/.minimax-code"] },
    docs: "https://github.com/MiniMax-AI/minimax-code"
  }
};
var CATALOG_HARNESSES = [
  { command: "claude", provider: "anthropic", displayName: "Claude Code", titleSource: "vendor", defaultModel: "opus", surface: "terminal", tier: "primary", transport: "acp", acp: { binary: "claude-agent-acp", npmPackage: "@agentclientprotocol/claude-agent-acp@0.84.0", argv: [], inheritCliOptions: false, listsModels: false, effortConfigId: "effort", permissionModeIds: { ask: "default", auto: "auto", bypass: "bypassPermissions" }, sharedSessions: true }, integration: "structured", parser: "claude-stream-json", memoryFile: "CLAUDE.md", nativeSlashPassthrough: true, customCommandDirs: [".claude/commands", "~/.claude/commands"], effortValues: ["low", "medium", "high", "xhigh", "max"], localAuth: ["api-key", "oauth", "vendor-cli"], binary: "claude", authFiles: [{ path: "${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json" }], authEnv: ["ANTHROPIC_API_KEY"], npmPackage: "@anthropic-ai/claude-code", loginArgv: ["auth", "login"], statusArgv: ["auth", "status"], logoutArgv: ["auth", "logout"], modelArgvPrefix: ["--model"], effortArgvPrefix: ["--effort"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--permission-mode", "manual", "--permission-prompts", "none"] }, bypass: { argv: ["--permission-mode", "bypassPermissions", "--permission-prompts", "none", "--allow-dangerously-skip-permissions"] }, auto: { argv: ["--permission-mode", "auto", "--permission-prompts", "none"] } }, turnEnv: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1" }, profileEnv: "CLAUDE_CONFIG_DIR", turn: { startArgv: ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages"], createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], promptInput: "stdin", stdinFormat: "stream-json", stdinArgv: [], output: "json-lines", responseFields: ["result"] }, session: { idKind: "uuid", createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], continueArgv: ["--continue"] } },
  // Grok Build speaks Claude Code's stream-json shape exactly -- verified live
  // against `grok -p --output-format streaming-messages-json`, whose first
  // line is {"type":"system","subtype":"init","session_id":…} and whose last
  // is {"type":"result",…,"usage":{…}} -- so it reuses that parser rather
  // than getting a near-identical one of its own. Its ACP server publishes
  // session-wide token usage, which ClikCode turns into a per-turn reading.
  // It publishes no quota window (errors are balance-based: HTTP 402).
  { command: "grok", provider: "xai", displayName: "Grok Build", surface: "terminal", tier: "primary", transport: "acp", acp: { argv: ["agent", "stdio"], inheritCliOptions: false, effortConfigId: "reasoning_effort", sharedSessions: true }, integration: "structured", parser: "claude-stream-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, effortValues: ["low", "medium", "high"], localAuth: ["api-key", "oauth", "vendor-cli"], binary: "grok", npmPackage: "@xai-official/grok", authFiles: [{ path: "~/.grok/auth.json" }], authEnv: ["XAI_API_KEY"], loginArgv: ["login"], logoutArgv: ["logout"], modelArgvPrefix: ["--model"], modelDiscoveryArgv: ["models"], workspaceArgvPrefix: ["--cwd"], effortArgvPrefix: ["--reasoning-effort"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--permission-mode", "default"] }, bypass: { argv: ["--permission-mode", "bypassPermissions"] }, auto: { argv: ["--permission-mode", "auto"] } }, turn: { startArgv: ["--output-format", "streaming-messages-json", "--include-partial-messages"], createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], promptArgvPrefix: ["-p"], output: "json-lines", responseFields: ["result"] }, session: { idKind: "uuid", createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], continueArgv: ["--continue"] } },
  // Restored and re-checked against gemini 0.60.0 on a real install, not the
  // entry this replaces. What changed: --acp is the flag now (the old
  // --experimental-acp is deprecated), -r/--resume takes "latest" or an index
  // rather than an id, --session-id starts a NEW session with a given uuid,
  // and -o/--output-format offers text|json|stream-json (confirmed by the
  // rejection of anything else). Its approval modes are default / auto_edit /
  // yolo / plan.
  //
  // No loginArgv: Gemini's auth lives behind /auth inside its own interactive
  // session, with nothing scriptable. An empty argv is still meaningful --
  // ClikCode's login flow gates on the field being present at all, and
  // without it a fresh install never gets handed a real terminal to sign in.
  // Sign-in (2026-10-03, real gemini 0.62 signed out): --skip-trust skips the
  // folder-trust dialog; its method menu, Google link + authorization code and
  // key box are read on ClikCode's screen. Signed in, it restarts into its chat,
  // which the step quits.
  // CLI turns (0.62.0, 2026-10-04): `--resume <id>` continues a thread by id
  // (without turn.resumeIdPrefix every resumed CLI turn silently started a
  // new thread); headless, a folder not yet trusted exits 55 unless
  // `--skip-trust`. ACP `session/load` reopens only threads ACP started: a
  // CLI-born or written thread loads as "No previous sessions found for this
  // project" AND is reset to its first message on disk -- which is why
  // those stay on the CLI (session nativeTransport) and the thread writer pins
  // its threads there.
  { command: "gemini", provider: "google", displayName: "Gemini CLI", surface: "terminal", tier: "primary", transport: "acp", integration: "structured", parser: "claude-stream-json", memoryFile: "GEMINI.md", nativeSlashPassthrough: false, customCommandDirs: [".gemini/commands", "~/.gemini/commands"], acp: { argv: ["--acp"], listsModels: true }, normalizedPermissionOptionIds: ["approval-mode"], localAuth: ["api-key", "oauth", "vendor-cli"], binary: "gemini", npmPackage: "@google/gemini-cli", authFiles: [{ path: "${GEMINI_CLI_HOME:-~}/.gemini/oauth_creds.json" }], authEnv: ["GEMINI_API_KEY"], loginArgv: ["--skip-trust"], loginSteps: [{ when: "Type your message", send: "/quit{enter}" }], modelArgvPrefix: ["--model"], workspaceArgvPrefix: ["--include-directories"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--approval-mode", "default"] }, bypass: { argv: ["--approval-mode", "yolo"] }, auto: { argv: ["--approval-mode", "auto_edit"] } }, profileEnv: "GEMINI_CLI_HOME", turn: { startArgv: ["--skip-trust", "--output-format", "stream-json"], createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], promptArgvPrefix: ["--prompt"], output: "json-lines", responseFields: ["response", "result", "text", "content"] }, session: { idKind: "uuid", createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], continueArgv: ["--resume", "latest"] } },
  { command: "codex", provider: "openai", displayName: "Codex", surface: "terminal", tier: "primary", transport: "codex-app-server", integration: "native", parser: "codex-items", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, customCommandDirs: ["~/.codex/prompts"], effortValues: ["low", "medium", "high", "xhigh", "max", "ultra"], localAuth: ["api-key", "oauth", "vendor-cli"], binary: "codex", authFiles: [{ path: "${CODEX_HOME:-~/.codex}/auth.json" }], authEnv: ["OPENAI_API_KEY"], npmPackage: "@openai/codex", loginRemoteArgv: ["login", "--device-auth"], loginArgv: ["login"], statusArgv: ["login", "status"], logoutArgv: ["logout"], modelArgvPrefix: ["--model"], workspaceArgvPrefix: ["--cd"], effortArgvPrefix: ["--config"], effortConfigKey: "model_reasoning_effort", permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"], placement: "root" }, bypass: { argv: ["--sandbox", "danger-full-access", "--ask-for-approval", "never"], placement: "root" }, auto: { argv: ["--approve-for-me"], placement: "root" } }, imageArgvPrefix: ["--image"], profileEnv: "CODEX_HOME", turn: { startArgv: ["exec", "--json", "--skip-git-repo-check"], resumeArgv: ["exec", "resume"], resumeIdSuffix: ["--json", "--skip-git-repo-check"], promptInput: "stdin", output: "json-lines", responseFields: ["text"], resumeSupportsWorkspaceSelector: false }, session: { resumeIdPrefix: ["resume"], continueArgv: ["resume", "--last"] } },
  { ...OPENCODE_FAMILY, command: "opencode", provider: "opencode", displayName: "OpenCode", tier: "primary", binary: "opencode", npmPackage: "opencode-ai", signInOptional: true },
  // No logoutArgv: Copilot signs out only with /logout inside its own chat
  // (1.0.91: `copilot logout` exits 1, "Invalid command format"), and its
  // token is in the system credential store, so ClikCode can remove the
  // account but cannot sign it out.
  // Shared sessions (1.0.91, 2026-10-05): a `-p --session-id` thread loads
  // over ACP with its history, and `--session-id` on an ACP thread continues
  // it; each recalled a word the other was told.
  { command: "copilot", provider: "github-copilot", displayName: "GitHub Copilot", planMode: { option: "plan", value: true }, surface: "terminal", tier: "primary", transport: "acp", integration: "structured", parser: "text", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["--acp", "--stdio"], effortArgvPrefix: ["--effort"], sharedSessions: true, probeDisableMcpPrefix: ["--disable-mcp-server"] }, retiredOptionIds: ["allow-all"], replyErrorPatterns: COPILOT_REPLY_ERRORS, localAuth: ["oauth", "vendor-cli"], binary: "copilot", npmPackage: "@github/copilot", loginRemoteArgv: ["login", "--device-code"], loginArgv: ["login"], authFiles: [{ path: "${COPILOT_HOME:-~/.copilot}/config.json", contains: '"loggedInUsers": [\n' }], modelArgvPrefix: ["--model"], workspaceArgvPrefix: ["-C"], permissionModes: ["ask", "bypass"], permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--allow-all"] } }, imageArgvPrefix: ["--attachment"], profileEnv: "COPILOT_HOME", turn: { startArgv: ["-s"], createIdPrefix: ["--session-id"], resumeIdPrefix: ["--session-id"], promptArgvPrefix: ["-p"], output: "text" }, session: { idKind: "uuid", createIdPrefix: ["--session-id"], resumeIdPrefix: ["--session-id"], continueArgv: ["--continue"] } },
  { command: "aider", provider: "aider", displayName: "Aider", titleSource: "none", surface: "terminal", tier: "more", transport: "text-cli", integration: "compatibility", parser: "aider", memoryFile: "CONVENTIONS.md", nativeSlashPassthrough: false, localAuth: ["api-key", "vendor-cli"], binary: "aider", installer: HARNESS_INSTALLERS.aider, loginArgv: ["--no-git", "--exit"], authFiles: [{ path: "~/.aider/oauth-keys.env" }], authEnv: ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "VERTEXAI_PROJECT"], modelArgvPrefix: ["--model"], permissionModes: ["ask", "bypass"], permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--yes-always"] } }, imageArgvPrefix: ["--file"], turn: { startArgv: ["--no-show-model-warnings", "--no-check-update", "--no-show-release-notes", "--no-analytics", "--no-pretty", "--no-fancy-input", "--no-detect-urls"], createIdPrefix: ["--chat-history-file"], resumeIdPrefix: ["--chat-history-file"], resumeIdSuffix: ["--restore-chat-history"], promptArgvPrefix: ["--message"], output: "text", outsideRepoArgv: ["--no-git"] }, session: { idKind: "history-file", createIdPrefix: ["--chat-history-file"], resumeIdPrefix: ["--chat-history-file"], resumeIdSuffix: ["--restore-chat-history"] } },
  { command: "goose", provider: "goose", displayName: "Goose", replyErrorPatterns: GOOSE_REPLY_ERRORS, surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "goose", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["acp"], inheritCliOptions: false, providerConfigId: "provider", effortConfigId: "thinking_effort", permissionModeIds: { ask: "approve", auto: "smart_approve", bypass: "auto" }, sharedSessions: true }, localAuth: ["api-key", "oauth", "vendor-cli"], binary: "goose", installer: HARNESS_INSTALLERS.goose, loginArgv: ["configure"], loginSteps: [{ when: "Share anonymous usage data", send: "{right}{enter}" }], providerLoginArgv: ["configure"], modelProviderSeparator: "/", modelProviderArgvPrefix: ["--provider"], modelArgvPrefix: ["--model"], permissionModes: ["ask", "bypass", "auto"], permissionEnv: { ask: { GOOSE_MODE: "approve" }, bypass: { GOOSE_MODE: "auto" }, auto: { GOOSE_MODE: "smart_approve" } }, turn: { startArgv: ["run", "--output-format", "stream-json"], createIdPrefix: ["--name"], resumeIdPrefix: ["--resume", "--session-id"], promptArgvPrefix: ["--text"], output: "json-lines", responseFields: ["text", "content", "response"], statelessProviders: ["claude-code"] }, session: { idKind: "uuid", idByName: true, createIdPrefix: ["--name"], resumeIdPrefix: ["session", "--resume", "--session-id"], discoverArgv: ["session", "list", "--format", "json"], discoverFormat: "json", discoverAllFolders: true } },
  // Amp's execute mode has a documented `--stream-json` switch that emits
  // Claude Code-compatible stream-json (system/assistant/result envelopes), so
  // it borrows the claude-stream-json parser family. UNVERIFIED LIVE: amp is
  // not installed where this was written, hence `experimental`; `fallbackTurn`
  // is the previously shipped plain-text contract, unchanged.
  { command: "amp", provider: "amp", displayName: "Amp", surface: "terminal", tier: "more", transport: "structured-cli", integration: "structured", parser: "claude-stream-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, experimental: true, localAuth: ["api-key", "oauth", "vendor-cli"], binary: "amp", npmPackage: "@ampcode/cli", authFiles: [{ path: "${XDG_DATA_HOME:-~/.local/share}/amp/secrets.json", contains: "apiKey@" }], authEnv: ["AMP_API_KEY"], loginArgv: ["login"], versionArgv: ["version"], turn: { startArgv: ["--stream-json"], resumeArgv: ["threads", "continue"], resumeIdSuffix: ["--stream-json"], promptArgvPrefix: ["-x"], output: "json-lines", responseFields: ["result"] }, fallbackTurn: { startArgv: [], resumeArgv: ["threads", "continue"], promptArgvPrefix: ["-x"], output: "text" }, session: { resumeIdPrefix: ["threads", "continue"] } },
  // Verified against Antigravity's own official headless-mode docs
  // (antigravity.google/docs/cli/headless/): -p/--print for a single
  // non-interactive prompt, --model <slug>, --continue/-c for the most
  // recent conversation, --conversation <id> to resume a specific one, and
  // --output-format text|json|stream-json -- these are the real, documented
  // flags, not guessed. No loginArgv: the same doc states headless mode
  // "uses your cached credentials -- authenticate once with an interactive
  // agy session first," meaning there's no scriptable login command, only
  // an interactive one -- loginArgv: [] here is the same pattern already
  // used for Gemini CLI for exactly this reason: it still routes through
  // ClikCode's suspend/resume handoff into agy's own interactive session
  // rather than being skipped entirely for lacking a real login argv.
  // Genuinely NOT verified: the JSON field names inside a stream-json
  // event carrying the final response text, and whether a conversation id
  // reliably comes back in that output at all -- Antigravity's own issue
  // tracker (google-antigravity/antigravity-cli#7) was, as of this
  // research, still requesting that a per-conversation id be emitted at
  // all, meaning --conversation-based resume may not work reliably yet.
  // responseFields here matches the same best-effort convention already
  // used for other harnesses with an unconfirmed inner schema (Pi, Kilo
  // Code) rather than a fabricated certainty.
  // loginArgv runs a minimal real print-mode turn rather than launching agy
  // bare: bare agy needs its own bubbletea TUI, which requires a real
  // /dev/tty and never returns on its own once open (confirmed live: a
  // proper login flow, but the wrong shape for a broker that hands off and
  // gets control back automatically). --print, by contrast, opens the same
  // OAuth browser flow when unauthenticated and returns control the moment
  // that completes -- confirmed live: it triggered the real browser OAuth
  // prompt with no TTY at all in a plain piped shell, not just under a
  // pty. The one real cost: unlike Claude/Codex's dedicated login
  // subcommands, this is a genuine (trivial) turn, not a free auth-only
  // call, since agy has no login-only command in its own CLI surface.
  // profileEnv: 'HOME' -- confirmed live: agy resolves its entire config
  // Effort is NOT an independent dimension here, which is why this entry
  // declares no effortValues and no effortArgvPrefix even though `agy --help`
  // lists --effort. Antigravity encodes effort in the MODEL ID -- its own
  // `agy models` prints gemini-3.8-flash-high / -medium / -low,
  // gemini-3.1-pro-high / -low, gpt-oss-120b-medium -- and the CLI rejects any
  // combination that is not consistent with that. Verified live against agy
  // 1.2.7 on a real authenticated account:
  //   --model claude-opus-4-6-thinking --effort medium
  //     -> "--effort is not supported for model claude-opus-4-6-thinking"
  //   --model gpt-oss-120b-medium --effort high
  //     -> "--model gpt-oss-120b-medium conflicts with --effort=high"
  //   --model claude-opus-4-6-thinking (no --effort)
  //     -> SUCCESS
  // Declaring the flag made ClikCode send it on every turn, so EVERY
  // antigravity turn failed on every account -- and because the failure
  // looked like the account's fault, failover then walked the whole account
  // list failing identically. Choosing effort means choosing the model.
  // tree (~/.gemini/antigravity-cli/, credentials included) from $HOME, the
  // same way it would with a real home directory, so redirecting HOME per
  // account is a real isolation mechanism here, not a guess -- verified
  // `agy models` runs cleanly under a freshly isolated HOME. This is what
  // makes "add a new/different account" actually work: a fresh, empty HOME
  // (keyring cut off by profileExtraEnv) has no credential to reuse.
  // Sign-in is bare `agy` (1.2.17): its "Select login method" screen, then a
  // Google link and a code field. `agy -p /help` used to be the login, but a
  // turn now runs signed out ("You are not logged into Antigravity", answered
  // anyway), so it signed nothing in. The token file it writes ends the
  // sign-in; the first-run screens are answered (data sharing unticked).
  { command: "antigravity", provider: "antigravity", displayName: "Antigravity CLI", planMode: { option: "mode", value: "plan" }, surface: "terminal", tier: "primary", transport: "structured-cli", integration: "structured", parser: "antigravity", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH, profileExtraEnv: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent", XDG_RUNTIME_DIR: "{profile}/runtime" }, apiKeySettings: { path: "~/.gemini/antigravity-cli/settings.json", set: { modelProvider: "gemini" } }, localAuth: ["api-key", "oauth", "vendor-cli"], binary: "agy", installer: HARNESS_INSTALLERS.antigravity, loginArgv: [], loginSteps: [{ when: "Choose your color scheme", send: "{enter}" }, { when: "Terms of Service & Data Use", send: "{enter}{down}{right}{enter}" }, { when: "Do you trust the contents of this project", send: "{enter}" }, { when: "Select login method", send: "{enter}" }, { when: "paste the authorization code below", ask: { prompt: "Paste the code from the Google page" } }], authFiles: [{ path: "~/.gemini/antigravity-cli/antigravity-oauth-token" }], modelArgvPrefix: ["--model"], modelDiscoveryArgv: ["models"], permissionModes: ["ask", "bypass"], permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--dangerously-skip-permissions"] } }, profileEnv: "HOME", turn: { startArgv: ["--output-format", "stream-json"], promptArgvPrefix: ["-p"], resumeIdPrefix: ["--conversation"], output: "json-lines", responseFields: ["text", "result", "response"] }, session: { resumeIdPrefix: ["--conversation"], continueArgv: ["--continue"] } },
  // Pi signs in only inside its own session (`/login`); `pi auth` just prints
  // or checks credentials. The steps type /login, its method/provider menus
  // and key field are read on ClikCode's screen, and Ctrl+D leaves once it
  // says the credentials are saved (verified 2026-10-03, pi 0.87 signed out).
  { command: "pi", provider: "pi", displayName: "Pi Coding Agent", surface: "terminal", tier: "more", transport: "structured-cli", integration: "structured", parser: "pi-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, effortValues: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], localAuth: ["api-key", "oauth", "vendor-cli"], loginArgv: [], binary: "pi", npmPackage: "@earendil-works/pi-coding-agent", loginSteps: [{ when: "/login to log into a provider", send: "/login{enter}" }, { when: "Credentials saved to", send: "{ctrl-d}" }], loginKeyRoutes: providerKeyRoutes(["Sign in with an API key"], {
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    google: "Google",
    xai: "xAI",
    groq: "Groq",
    cerebras: "Cerebras",
    huggingface: "Hugging Face",
    fireworks: "Fireworks",
    mistral: "Mistral",
    deepseek: "DeepSeek",
    moonshot: "Moonshot AI",
    "moonshot-cn": "Moonshot AI CN",
    zai: "Z.AI",
    minimax: "MiniMax",
    together: "Together"
  }), authFiles: [{ path: "${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json", contains: '"type"' }], modelDiscoveryArgv: ["--list-models"], modelProviderSeparator: "/", modelArgvPrefix: ["--model"], effortArgvPrefix: ["--thinking"], imageArgvPrefix: ["@"], imageArgvStyle: "concatenated", profileEnv: "PI_CODING_AGENT_DIR", turn: { startArgv: ["-p", "--mode", "json"], createIdPrefix: ["--session-id"], resumeIdPrefix: ["--session"], output: "json-lines", responseFields: ["text", "content"] }, session: { idKind: "uuid", createIdPrefix: ["--session-id"], resumeIdPrefix: ["--session"], continueArgv: ["--continue"] } },
  // Checked against droid 0.223.0: `droid exec` takes -m/--model,
  // -r/--reasoning-effort, --cwd, -s/--session-id, --auto low|medium|high and
  // --skip-permissions-unsafe, all as declared here. Two things were missing:
  // it ships on npm as plain `droid` (so ClikCode can install it), and its
  // --output-format accepts stream-json, which `zzz` does not -- the reject
  // is how the accepted set was confirmed, since --help swallows the flag
  // before it is validated.
  { command: "droid", provider: "factory", displayName: "Factory Droid", planMode: { option: "spec-mode", value: true }, surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["exec", "--output-format", "acp"], optionPlacement: "after", listsModels: true }, effortValues: ["low", "medium", "high", "xhigh"], localAuth: ["api-key", "oauth", "vendor-cli"], binary: "droid", npmPackage: "droid", loginArgv: [], loginSteps: [{ when: "Please login with your Factory account", send: "{enter}" }], authFiles: [{ path: "${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.v2.file" }, { path: "${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.v2.key" }, { path: "${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.v2.keyring" }, { path: "${FACTORY_HOME_OVERRIDE:-~/.factory}/auth.encrypted" }], authEnv: ["FACTORY_API_KEY"], modelArgvPrefix: ["--model"], workspaceArgvPrefix: ["--cwd"], effortArgvPrefix: ["--reasoning-effort"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--skip-permissions-unsafe"] }, auto: { argv: ["--auto", "low"] } }, turn: { startArgv: ["exec", "--output-format", "stream-json"], resumeIdPrefix: ["--session-id"], output: "json-lines", responseFields: ["result", "response", "text"] }, session: { resumeIdPrefix: ["--session-id"], continueArgv: ["resume"] } },
  // Checked against a real install (`curl -fsSL https://cli.kiro.dev/install`):
  // chat takes --model, --effort, -r/--resume, --resume-id, -a/--trust-all-tools
  // and --output-format stream-json ("JSON Lines on stdout", which implies
  // --no-interactive). Everything here was already right except --model,
  // which the CLI has and this entry did not.
  { command: "kiro", provider: "kiro", displayName: "Kiro CLI", surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["acp"], optionPlacement: "after" }, effortValues: ["low", "medium", "high", "xhigh", "max"], localAuth: ["api-key", "oauth", "vendor-cli"], loginRemoteArgv: ["login", "--license", "free", "--use-device-flow"], loginArgv: ["login"], logoutArgv: ["logout"], statusArgv: ["whoami"], binary: "kiro-cli", installer: HARNESS_INSTALLERS.kiro, launchArgv: ["chat"], modelArgvPrefix: ["--model"], effortArgvPrefix: ["--effort"], permissionModes: ["ask", "bypass"], permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--trust-all-tools"] } }, turn: { promptGuard: "double-dash", startArgv: ["chat", "--no-interactive", "--agent-engine", "v3", "--output-format", "stream-json"], resumeIdPrefix: ["--resume-id"], output: "json-lines", responseFields: ["text", "content", "result"] }, session: { resumeIdPrefix: ["chat", "--resume-id"], continueArgv: ["chat", "--resume"], discoverArgv: ["chat", "--list-sessions", "--format", "json"], discoverFormat: "json" } },
  // Sign-in (2026-10-03, real qwen 0.24 signed out): its provider menus and
  // key/model boxes are read on ClikCode's screen; once configured it sits in
  // its chat, which the step quits.
  // Qwen signs in only through its own /auth screen (0.25: Qwen OAuth is
  // discontinued, `qwen auth` removed). /auth asks plan, region -- US
  // (Virginia) included -- key and models, and saves them in settings.json
  // with security.auth.selectedType, so that is the one sign-in file. A bare
  // DASHSCOPE_API_KEY is not a sign-in to Qwen: it needs the region and
  // method from settings too, so there is no ClikCode API-key path here.
  // Its menus are answered from the key: every endpoint /auth offers, in its
  // own words, and the first that accepts the key picks plan and region. A
  // QwenCloud key (sk-ws-, home.qwencloud.com) lands on Singapore; US
  // (Virginia) refuses it, which is how a hand-picked region failed.
  // /auth's last step, Model IDs, is answered here, never asked: Enter applies
  // the models it pre-checks -- the plan's own list, which Coding Plan and
  // Token Plan read from the endpoint -- and the session lists what it saved.
  { command: "qwen", provider: "qwen", displayName: "Qwen Code", surface: "terminal", tier: "more", npmPackage: "@qwen-code/qwen-code", transport: "acp", integration: "structured", parser: "claude-stream-json", memoryFile: "QWEN.md", nativeSlashPassthrough: false, customCommandDirs: [".qwen/commands", "~/.qwen/commands"], acp: { argv: ["--acp"], probeArgv: ["--allowed-mcp-server-names", "clikcode-probe-none"] }, normalizedPermissionOptionIds: ["approval-mode"], localAuth: ["vendor-cli"], binary: "qwen", loginArgv: [], loginKeyRoutes: [{ url: "https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions", choose: ["Alibaba ModelStudio", "Standard API Key", "US (Virginia)"] }, { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", choose: ["Alibaba ModelStudio", "Standard API Key", "Singapore"] }, { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", choose: ["Alibaba ModelStudio", "Standard API Key", "China (Beijing)"] }, { url: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", choose: ["Alibaba ModelStudio", "Standard API Key", "China (Hong Kong)"] }, { url: "https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions", choose: ["Alibaba ModelStudio", "Coding Plan", "Singapore"] }, { url: "https://coding.dashscope.aliyuncs.com/v1/chat/completions", choose: ["Alibaba ModelStudio", "Coding Plan", "China (Beijing)"] }, { url: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", choose: ["Alibaba ModelStudio", "Token Plan", "Singapore"] }, { url: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions", choose: ["Alibaba ModelStudio", "Token Plan", "China (Beijing)"] }], loginSteps: [{ when: "Enter model IDs directly", send: "{enter}" }, { when: "Type your message", send: "/quit{enter}" }], authFiles: [{ path: "${QWEN_HOME:-~/.qwen}/settings.json", contains: '"selectedType"' }], modelArgvPrefix: ["--model"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--approval-mode", "default"] }, bypass: { argv: ["--approval-mode", "yolo"] }, auto: { argv: ["--approval-mode", "auto"] } }, profileEnv: "QWEN_HOME", turn: { startArgv: ["-p", "--output-format", "stream-json", "--include-partial-messages"], createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], output: "json-lines", responseFields: ["result", "response", "text"] }, session: { idKind: "uuid", createIdPrefix: ["--session-id"], resumeIdPrefix: ["--resume"], continueArgv: ["--continue"], discoverArgv: ["sessions", "list", "--json"], discoverFormat: "json-lines" } },
  // CLINE_SESSION_BACKEND_MODE=local runs the session inside the ACP child.
  // Left on `auto`, the first prompt starts a `--cline-hub-daemon` (~200 MB,
  // its own process group) that outlives the chat, and ClikCode's sandboxed
  // runs too. Measured on 3.0.68: same session files, session/load resumes,
  // and no daemon.
  { command: "cline", provider: "cline", displayName: "Cline CLI", planMode: { option: "plan", value: true }, surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "cline-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["--acp"], permissionArgv: { auto: ["--auto-approve", "true"] }, listsModels: true, usageFile: { path: "~/.cline/data/sessions/{id}/{id}.json", field: ["metadata", "usage"] } }, effortValues: ["none", "low", "medium", "high", "xhigh"], normalizedPermissionOptionIds: ["auto-approve"], localAuth: ["api-key", "oauth", "vendor-cli"], binary: "cline", npmPackage: "cline", authFiles: [{ path: "~/.cline/data/settings/providers.json", contains: '"auth"' }, { path: "~/.cline/data/settings/providers.json", contains: '"apiKey"' }], loginArgv: ["auth"], loginKeyRoutes: providerKeyRoutes(["Bring your own provider"], {
    anthropic: "Anthropic",
    openrouter: "OpenRouter",
    openai: "OpenAI",
    google: "Google Gemini",
    xai: "xAI",
    groq: "Groq",
    cerebras: "Cerebras",
    huggingface: "Hugging Face",
    fireworks: "Fireworks AI",
    mistral: "Mistral",
    deepseek: "DeepSeek",
    moonshot: "Moonshot AI",
    "moonshot-cn": "Moonshot AI (China)",
    zai: "Z.AI",
    minimax: "MiniMax (minimax.io)",
    together: "Together AI"
  }), modelArgvPrefix: ["--model"], workspaceArgvPrefix: ["--cwd"], effortArgvPrefix: ["--thinking"], permissionModes: ["ask", "bypass"], permissionArgv: { ask: { argv: ["--auto-approve", "false"] }, bypass: { argv: ["--auto-approve", "true"] } }, turn: { startArgv: ["--json"], resumeIdPrefix: ["--id"], output: "json-lines", responseFields: ["text", "content", "result"] }, turnEnv: { CLINE_SESSION_BACKEND_MODE: "local" }, session: { resumeIdPrefix: ["--id"] } },
  { ...OPENCODE_FORK_BASE, command: "kilo", provider: "kilo", displayName: "Kilo Code CLI", tier: "more", binary: "kilo", authFiles: [{ path: "${XDG_DATA_HOME:-~/.local/share}/kilo/auth.json", contains: '"type"' }], npmPackage: "@kilocode/cli", permissionModes: ["ask", "auto"], permissionArgv: { ask: { argv: [] }, auto: { argv: ["--auto"] } } },
  { command: "cursor", provider: "cursor", displayName: "Cursor Agent", planMode: { option: "mode", value: "plan" }, surface: "terminal", tier: "primary", transport: "acp", acp: { argv: ["acp"], inheritCliOptions: false, listsModels: true }, integration: "structured", parser: "cursor-stream-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, customCommandDirs: [".cursor/commands", "~/.cursor/commands"], normalizedPermissionOptionIds: ["auto-review", "force"], replyErrorPatterns: CURSOR_REPLY_ERRORS, localAuth: ["api-key", "oauth", "vendor-cli"], binary: "cursor-agent", installer: HARNESS_INSTALLERS.cursor, loginArgv: ["login"], statusArgv: ["status", "--format", "json"], logoutArgv: ["logout"], modelArgvPrefix: ["--model"], workspaceArgvPrefix: ["--workspace"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--force"] }, auto: { argv: ["--auto-review"] } }, turn: { promptGuard: "double-dash", startArgv: ["-p", "--output-format", "stream-json", "--stream-partial-output"], resumeIdPrefix: ["--resume"], output: "json-lines", responseFields: ["result", "response", "text"] }, session: { createSessionArgv: ["create-chat"], resumeIdPrefix: ["--resume"], continueArgv: ["--continue"] } },
  // Checked against the installed CLI. `hermes model` is an interactive picker
  // and there is no `models list`; the configured model is `hermes config get
  // model --json` (`default`). ACP (`hermes acp`) is the turn that streams
  // tool calls. `chat --quiet` is only the text fallback.
  // Hermes is one ClikCode account over many inference providers. A model id
  // is `provider:model`, so choosing a model chooses the provider, and the old
  // separate provider option is retired. `hermes login` was removed upstream
  // (it prints a notice and exits 0), so signing in is `hermes model`, and a
  // single provider is `hermes auth add <provider>`, which picks OAuth or an
  // API key for that provider itself.
  { command: "hermes", provider: "nous", displayName: "Hermes", turboFit: true, surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "text", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["acp"], listsModels: false, usageTotals: "session" }, effortValues: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], normalizedPermissionOptionIds: ["yolo"], localAuth: ["api-key", "oauth", "vendor-cli"], binary: "hermes", installer: HARNESS_INSTALLERS.hermes, loginArgv: ["model"], loginKeyRoutes: providerKeyRoutes([], {
    anthropic: ["Anthropic", "Anthropic API key"],
    openrouter: "OpenRouter",
    openai: ["OpenAI", "OpenAI API"],
    google: "Google AI Studio",
    xai: ["xAI Grok", "xAI"],
    huggingface: "Hugging Face Inference Providers",
    fireworks: "Fireworks AI",
    deepseek: "DeepSeek",
    moonshot: ["Kimi / Moonshot", "Kimi / Kimi Coding Plan"],
    "moonshot-cn": ["Kimi / Moonshot", "Kimi / Moonshot (China)"],
    zai: ["Z.AI / GLM", "Global (https://api.z.ai/api/paas/v4)"],
    minimax: ["MiniMax", "MiniMax"]
  }), providerLoginArgv: ["auth", "add", "{provider}"], statusArgv: ["status"], logoutArgv: ["logout"], retiredOptionIds: ["provider"], replyErrorPatterns: HERMES_REPLY_ERRORS, modelArgvPrefix: ["--model"], modelProviderArgvPrefix: ["--provider"], workspaceArgvPrefix: ["--in"], effortArgvPrefix: ["--reasoning"], permissionModes: ["ask", "bypass"], permissionArgv: { ask: { argv: [] }, bypass: { argv: ["--yolo"] } }, imageArgvPrefix: ["--image"], profileEnv: "HERMES_HOME", turn: { startArgv: ["chat", "--quiet"], resumeIdPrefix: ["--resume"], promptArgvPrefix: ["--query"], output: "text" }, session: { resumeIdPrefix: ["--resume"], continueArgv: ["--continue"], discoverArgv: ["sessions", "list", "--limit", "50"], discoverFormat: "text", discoverAllFolders: true } },
  // Same kind of product as Hermes, not a fork; checked against a real
  // install (OpenClaw 2026.9.6). The one-shot turn is `agent --local --json`,
  // whose answer is `meta.finalAssistantVisibleText` -- the generic fields
  // also match `meta.executionTrace…result: "success"`, which used to become
  // the reply. Without --session-id every turn joins the shared
  // `agent:main:main` session, so each chat gets its own. A model is
  // `provider/model` and --model takes it whole; one provider signs in with
  // `models auth login --provider <id>`, the whole setup is `onboard`. The
  // CLI back ends (a Claude Code login) keep no history between --local
  // turns, so those turns carry ClikCode's transcript instead.
  { command: "openclaw", provider: "openclaw", displayName: "OpenClaw", surface: "terminal", tier: "more", transport: "structured-cli", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, npmPackage: "openclaw", localAuth: ["api-key", "oauth", "vendor-cli"], binary: "openclaw", loginArgv: ["onboard"], loginSteps: [{ when: "How would you like to start?", send: "{enter}" }, { when: "What would you like to create?", send: "{enter}" }], providerLoginArgv: ["models", "auth", "login", "--provider", "{provider}"], modelProviderSeparator: "/", statusArgv: ["models", "status"], modelArgvPrefix: ["--model"], effortArgvPrefix: ["--thinking"], effortValues: ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"], profileEnv: "OPENCLAW_STATE_DIR", turn: { startArgv: ["agent", "--local", "--json", "--agent", "main"], resumeArgv: ["agent", "--local", "--json", "--agent", "main"], createIdPrefix: ["--session-id"], resumeIdPrefix: ["--session-id"], resumeKeyPrefix: ["--session-key"], promptArgvPrefix: ["--message"], output: "json", responseFields: ["finalAssistantVisibleText"], statelessRoute: { path: ["meta", "systemPromptReport", "provider"], values: ["claude-cli", "google-gemini-cli"] } }, session: { idKind: "uuid", createIdPrefix: ["--session-id"], resumeIdPrefix: ["--session-id"], resumeKeyPrefix: ["--session-key"], discoverArgv: ["sessions", "--json", "--limit", "50"], discoverFormat: "json", discoverAllFolders: true } },
  // Stays on its one-shot CLI, not `cmdc acp` (checked on 1.74.1, sandbox):
  // the ACP agent initializes, opens, loads (a written thread replays) and
  // shares the CLI's session files, but offers and accepts only Command
  // Code's gateway models -- a BYOK model (`mock/mock-model` from
  // providers.json) is "Unknown model" over ACP, while the CLI runs it.
  { command: "command", provider: "command-code", displayName: "Command Code", planMode: { option: "plan", value: true }, surface: "terminal", tier: "more", transport: "structured-cli", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, effortValues: ["low", "medium", "high"], profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH, localAuth: ["api-key", "oauth", "vendor-cli"], binary: "cmdc", npmPackage: "command-code", loginArgv: ["login"], statusArgv: ["status"], logoutArgv: ["logout"], modelArgvPrefix: ["--model"], modelDiscoveryArgv: ["--list-models"], effortArgvPrefix: ["--effort"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--permission-mode", "standard"] }, bypass: { argv: ["--yolo"] }, auto: { argv: ["--permission-mode", "auto-accept"] } }, profileEnv: "HOME", turn: { startArgv: ["--print", "--output-format", "json", "--skip-onboarding", "--no-auto-update"], resumeIdPrefix: ["--resume"], output: "json-lines", responseFields: ["result", "response", "text"] }, session: { resumeIdPrefix: ["--resume"], continueArgv: ["--continue"] } },
  // ---- Added from vendor documentation; none of these binaries was available
  // to run live, so every one-shot contract below is `experimental` and only
  // flags the vendor documents are declared. No session selectors are claimed:
  // an absent `session` means ClikCode launches but never pretends to resume.
  // Kimi CLI (MoonshotAI): `kimi --acp` is the documented ACP entry point and
  // the preferred transport. `--print` is its non-interactive mode and
  // `--command` carries the prompt; stream-json output is left undeclared.
  // Rewritten against the real CLI (Kimi Code 2.0.2, `@moonshot-ai/kimi-code`
  // on npm -- pypi's `kimi-cli` is the wound-down Python predecessor and npm's
  // bare `kimi-cli` is an unrelated front-end generator). The previous entry
  // could not have run a turn: it passed --print and --command, and this CLI
  // has neither; the flags are -p/--prompt and --output-format stream-json.
  // ACP is a subcommand here, not a --acp flag.
  //
  // The permission names invert: -y/--yolo is "Ask When Needed" (routine edits
  // run, risky ones still ask) and --auto is "Never Ask". So yolo maps to
  // ClikCode's `auto` and --auto maps to `bypass`, which is the opposite of
  // what the spellings suggest.
  //
  // Its sign-in is two files: `login` writes the provider (and where its OAuth
  // token lives) into config.toml, and the token into credentials/. Either
  // alone is not a sign-in -- "no provider configured" without the first.
  { command: "kimi", provider: "kimi", displayName: "Kimi CLI", surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["acp"] }, experimental: true, localAuth: ["api-key", "oauth", "vendor-cli"], binary: "kimi", npmPackage: "@moonshot-ai/kimi-code", authFiles: [{ path: "${KIMI_CODE_HOME:-~/.kimi-code}/credentials/" }, { path: "${KIMI_CODE_HOME:-~/.kimi-code}/config.toml", contains: "[providers." }], authEnv: ["KIMI_API_KEY"], loginArgv: ["login", "--region", "global"], modelArgvPrefix: ["--model"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--plan"] }, bypass: { argv: ["--auto"] }, auto: { argv: ["--yolo"] } }, turn: { startArgv: ["--output-format", "stream-json"], promptArgvPrefix: ["--prompt"], output: "json-lines", responseFields: ["text", "content", "response", "result"] }, session: { resumeIdPrefix: ["--session"], continueArgv: ["--continue"] } },
  // Augment Auggie: `--print` with `--output-format json` returns one JSON
  // document; `--acp` is documented. The JSON field holding the answer is not
  // confirmed, so responseFields is the usual best-effort list.
  // Read from `auggie --help` on a real install: -w/--workspace-root,
  // -c/--continue, -r/--resume [sessionId], --reasoning-effort <effort>.
  // No effortValues: the flag is real but the levels it accepts are
  // undocumented, and a picker offering invented ones is worse than a picker
  // offering none. -a/--ask is deliberately NOT mapped to the `ask`
  // permission mode -- it means "retrieval and non-editing tools only", which
  // is read-only, not approval-prompting, so mapping it would quietly make
  // the harness unable to edit whenever someone chose Ask.
  // turn.resumeIdPrefix, live against auggie 0.36.0 (2026-10-05,
  // vendor-sandbox): `--print --output-format json --resume <id>` reported the
  // same session_id and appended its request to that `<id>.json` as the
  // second exchange (one file, chatHistory 1 -> 2) -- the file is the history
  // auggie sends. The account was out of usage, so the model's recall is unproved.
  { command: "auggie", provider: "augment", displayName: "Augment Auggie", replyErrorPatterns: AUGGIE_REPLY_ERRORS, planMode: { option: "ask", value: true }, surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, customCommandDirs: [".augment/commands", "~/.augment/commands"], acp: { argv: ["--acp"] }, experimental: true, localAuth: ["oauth", "vendor-cli"], binary: "auggie", npmPackage: "@augmentcode/auggie", statusArgv: ["account", "status"], loginArgv: ["login", "--headless"], logoutArgv: ["logout"], modelDiscoveryArgv: ["model", "list"], modelArgvPrefix: ["--model"], workspaceArgvPrefix: ["--workspace-root"], effortValues: ["low", "medium", "high"], effortArgvPrefix: ["--reasoning-effort"], imageArgvPrefix: ["--image"], turn: { startArgv: ["--print", "--output-format", "json"], resumeIdPrefix: ["--resume"], output: "json", responseFields: ["result", "response", "text"], quotaSignals: ["You have run out of usage for", "run out of usage"] }, session: { resumeIdPrefix: ["--resume"], continueArgv: ["--continue"] } },
  // Mistral Vibe ships ACP as a SEPARATE executable, `vibe-acp`, with no argv.
  // `vibe --prompt` is its documented programmatic mode (plain text).
  // Read from mistral-vibe on a real install (pip/uv, not npm, so there is no
  // npmPackage to declare). ACP stays the primary path -- `vibe-acp` is a
  // binary it really ships -- and the CLI fallback below is no longer a
  // text-only stub: --output streaming is documented as "newline-delimited
  // JSON per message", and its agents (ask / smart-approve / auto-approve)
  // map onto the three permission modes without inventing anything.
  // Sign-in (2026-10-03, real vibe signed out): the steps pass its animated
  // welcome and theme screens; its method cards, provider choice, browser link
  // and titled key field are read on ClikCode's screen.
  { command: "vibe", provider: "mistral-vibe", displayName: "Mistral Vibe", surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { binary: "vibe-acp", argv: [], listsModels: true, usageTotals: "session", cumulativeChunks: true }, experimental: true, localAuth: ["api-key", "vendor-cli"], binary: "vibe", installer: HARNESS_INSTALLERS.vibe, loginArgv: ["--setup"], loginSteps: [{ when: "Where do you sign in?", send: "{enter}" }, { when: "Welcome to Mistral Vibe - Let", send: "{enter}" }, { when: "Select your preferred theme", send: "{enter}" }], authFiles: [{ path: "${VIBE_HOME:-~/.vibe}/.env", contains: "MISTRAL_API_KEY=", removeLine: true }], authEnv: ["MISTRAL_API_KEY"], profileEnv: "VIBE_HOME", modelArgvPrefix: [], workspaceArgvPrefix: ["--workdir"], permissionModes: ["ask", "bypass", "auto"], permissionArgv: { ask: { argv: ["--agent", "ask"] }, bypass: { argv: ["--auto-approve"] }, auto: { argv: ["--smart-approve"] } }, turn: { startArgv: ["--output", "streaming"], promptArgvPrefix: ["--prompt"], output: "json-lines", responseFields: ["text", "content", "response", "result"] }, session: { resumeIdPrefix: ["--resume"], continueArgv: ["-c"] } },
  // OpenHands CLI: `openhands acp` is documented; headless is `--headless`
  // with the task in `-t`. Its JSON event mode is left undeclared.
  // Checked against the real CLI (OpenHands SDK v1.21.0, `uv tool install
  // openhands`): --headless and the `acp` subcommand both exist, as declared.
  // Worth recording why that needed checking twice: PyPI's `openhands-ai` is
  // the OLD distribution, pinned below 1.0 on this machine's Python, and it
  // has neither -- the package moved to plain `openhands`, and reading the
  // stale one made a correct entry look broken.
  //
  // --json is documented as "Streams JSONL event outputs", so the turn reads
  // as lines rather than text. Only bypass and auto are offered: --headless
  // auto-approves by definition ("no UI output, auto-approve actions"), so an
  // `ask` mode on this path would be a promise the CLI cannot keep. The ACP
  // path above is the one that can actually prompt.
  { command: "openhands", provider: "openhands", displayName: "OpenHands CLI", surface: "terminal", tier: "more", transport: "acp", integration: "structured", parser: "generic-json", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, acp: { argv: ["acp"] }, experimental: true, localAuth: ["api-key", "vendor-cli"], binary: "openhands", installer: HARNESS_INSTALLERS.openhands, authFiles: [{ path: "${OPENHANDS_PERSISTENCE_DIR:-~/.openhands}/cloud/api_key.txt" }, { path: "${OPENHANDS_PERSISTENCE_DIR:-~/.openhands}/agent_settings.json", contains: "api_key" }], authEnv: ["LLM_API_KEY"], loginArgv: ["login"], logoutArgv: ["logout"], permissionModes: ["bypass", "auto"], permissionArgv: { bypass: { argv: ["--always-approve"] }, auto: { argv: ["--llm-approve"] } }, turn: { startArgv: ["--headless", "--json"], promptArgvPrefix: ["-t"], output: "json-lines", responseFields: ["text", "content", "response", "result"] }, session: { resumeIdPrefix: ["--resume"], continueArgv: ["--resume", "--last"] } },
  // Continue CLI: `cn -p` is the documented headless mode and prints the final
  // answer as text. No ACP mode is declared because none is documented.
  // Flags read from `cn --help` on a real install: -p/--print for headless,
  // --model <slug>, and a permission surface of --readonly (plan, read-only
  // tools) / --auto (all tools allowed) / --allow / --exclude. `--format json`
  // exists too but is left unwired: the flag is documented, the shape its
  // output takes is not, and a parser declared against an unverified shape
  // fails at the one moment it matters.
  { command: "cn", provider: "continue", displayName: "Continue", surface: "terminal", tier: "more", transport: "text-cli", integration: "compatibility", parser: "text", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, experimental: true, localAuth: ["api-key", "oauth", "vendor-cli"], binary: "cn", npmPackage: "@continuedev/cli", loginArgv: [], authFiles: [{ path: "${CONTINUE_GLOBAL_DIR:-~/.continue}/config.yaml", contains: "apiKey:" }], authEnv: ["ANTHROPIC_API_KEY"], modelArgvPrefix: ["--model"], permissionModes: ["ask", "bypass"], permissionArgv: { ask: { argv: ["--readonly"] }, bypass: { argv: ["--auto"] } }, turn: { startArgv: [], promptArgvPrefix: ["-p"], output: "text" } },
  // Official ACP entrypoints, source-checked but awaiting authenticated live
  // turns. Keep them in the experimental picker tier until those probes pass.
  { command: "dcode", provider: "deepagents-code", displayName: "Deep Agents Code", surface: "terminal", tier: "experimental", transport: "acp", integration: "structured", parser: "text", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, experimental: true, acp: { argv: ["--acp"], optionPlacement: "after" }, localAuth: ["api-key", "vendor-cli"], binary: "dcode", installer: HARNESS_INSTALLERS.dcode, loginArgv: [], loginKeyCommand: { providersArgv: ["auth", "list"], setArgv: ["auth", "set", "{provider}"] }, authEnv: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"], modelArgvPrefix: ["--model"] },
  { command: "devin", provider: "devin", displayName: "Devin CLI", surface: "terminal", tier: "experimental", transport: "acp", integration: "structured", parser: "text", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, experimental: true, acp: { argv: ["acp"], optionPlacement: "after" }, localAuth: ["oauth", "api-key", "vendor-cli"], binary: "devin", installer: HARNESS_INSTALLERS.devin, loginArgv: ["auth", "login"], statusArgv: ["auth", "status"], logoutArgv: ["auth", "logout"], authEnv: ["WINDSURF_API_KEY"], modelArgvPrefix: ["--model"] },
  { command: "junie", provider: "junie", displayName: "Junie CLI", surface: "terminal", tier: "experimental", transport: "acp", integration: "structured", parser: "text", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, experimental: true, acp: { argv: ["--acp", "true"] }, localAuth: ["oauth", "api-key", "vendor-cli"], binary: "junie", installer: HARNESS_INSTALLERS.junie, loginArgv: [], authEnv: ["JUNIE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"], modelArgvPrefix: ["--model"], effortArgvPrefix: ["--effort"], effortValues: ["low", "medium", "high"] },
  { command: "mcode", provider: "minimax-code", displayName: "MiniMax Code", surface: "terminal", tier: "experimental", transport: "acp", integration: "structured", parser: "text", memoryFile: "AGENTS.md", nativeSlashPassthrough: false, experimental: true, acp: { argv: ["acp"] }, localAuth: ["oauth", "api-key", "vendor-cli"], binary: "mcode", installer: HARNESS_INSTALLERS.mcode, loginArgv: ["login", "--region", "global"], logoutArgv: ["logout"], authEnv: ["MCODE_PROVIDER_API_KEY"] }
];
var AI_LOCAL_HARNESSES = CATALOG_HARNESSES.map((harness) => {
  if (harness.profileEnv) return harness;
  return { ...harness, profileEnv: "HOME", profileEnvPassthrough: HOME_REDIRECT_ENV_PASSTHROUGH };
});
var flag = (id, label, description, category, argv, extra = {}) => ({ id, label, description, category, kind: "boolean", argv, argvStyle: "flag", appliesTo: "both", ...extra });
var value = (id, label, description, category, argv, kind = "string", extra = {}) => ({ id, label, description, category, kind, argv, argvStyle: "value", appliesTo: "both", ...extra });
var AI_LOCAL_HARNESS_CAPABILITIES = {
  claude: {
    options: [
      value("agent", "Agent", "Use a configured Claude agent", "mode", ["--agent"]),
      value("tools", "Built-in tools", "Choose the built-in tools available to the session", "tools", ["--tools"], "string-list", { argvStyle: "csv" }),
      value("allowed-tools", "Allowed tools", "Tool patterns allowed without prompting", "permissions", ["--allowed-tools"], "string-list", { argvStyle: "csv" }),
      value("disallowed-tools", "Denied tools", "Tool patterns that must not run", "permissions", ["--disallowed-tools"], "string-list", { argvStyle: "csv" }),
      value("add-dir", "Additional directories", "Additional directories Claude may access", "context", ["--add-dir"], "path-list", { argvStyle: "repeat" }),
      value("fallback-model", "Fallback models", "Ordered models used when the primary is unavailable", "model", ["--fallback-model"]),
      value("max-budget-usd", "Maximum budget (USD)", "Maximum API spend for a print-mode turn", "safety", ["--max-budget-usd"], "number"),
      value("mcp-config", "MCP configuration", "JSON files or inline MCP configuration", "tools", ["--mcp-config"], "path-list", { argvStyle: "repeat" }),
      value("plugin-dir", "Plugin directories", "Plugin folders or archives loaded for this session", "tools", ["--plugin-dir"], "path-list", { argvStyle: "repeat" }),
      value("autocompact", "Auto compact", "Automatic context compaction threshold", "session", ["--autocompact"]),
      flag("safe-mode", "Safe mode", "Disable customizations, plugins, skills, hooks, and MCP", "safety", ["--safe-mode"]),
      flag("restricted", "Restricted mode", "Remove code-running tools and constrain file access", "safety", ["--restricted"]),
      flag("bare", "Bare mode", "Skip hooks, plugins, memory, settings, and instruction discovery", "safety", ["--bare"]),
      flag("disable-skills", "Disable skills", "Disable skill slash commands", "tools", ["--disable-slash-commands"]),
      flag("chrome", "Chrome integration", "Enable Claude in Chrome integration", "tools", ["--chrome"])
    ],
    managers: {
      // User scope: Claude's default is the current folder only. `--` keeps a
      // local server's own dash arguments from being read as Claude's options.
      mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove", "--scope", "user"] }, add: { argv: ["mcp", "add", "--scope", "user"], shape: "doubledash-local", transportPrefix: ["--transport"], headerPrefix: ["--header"], envPrefix: ["--env"] } },
      plugins: { label: "Plugins", listArgv: ["plugin", "list"], manageArgv: ["plugin"] },
      agents: { label: "Agents", listArgv: ["agents"], manageArgv: ["agents"] }
    },
    features: ["skills", "hooks", "custom commands", "settings layers"]
  },
  codex: {
    options: [
      value("profile", "Configuration profile", "Layer a named Codex profile over config.toml", "advanced", ["--profile"]),
      value("add-dir", "Additional writable directories", "Writable roots in addition to the workspace", "context", ["--add-dir"], "path-list", { argvStyle: "repeat" }),
      value("output-schema", "Output schema", "JSON Schema for the final response", "output", ["--output-schema"], "path"),
      value("local-provider", "Local provider", "Local OSS runtime used with OSS mode", "model", ["--local-provider"], "enum", { values: ["lmstudio", "ollama"] }),
      flag("oss", "Open-source model", "Use a configured local open-source provider", "model", ["--oss"]),
      flag("search", "Web search", "Enable the native web-search tool", "tools", ["--search"], { argvPlacement: "root" }),
      flag("network-access", "Network access", "Allow outbound network from Codex workspace-write commands (required for GitHub in Ask mode)", "safety", ["--config", "sandbox_workspace_write.network_access=true"], { argvPlacement: "root" }),
      flag("worktree", "Managed worktree", "Run in a new managed Git worktree", "session", ["--worktree"], { requiresNewSession: true }),
      flag("ephemeral", "Ephemeral session", "Do not persist native session files", "session", ["--ephemeral"], { requiresNewSession: true }),
      flag("ignore-user-config", "Ignore user config", "Do not load CODEX_HOME/config.toml", "safety", ["--ignore-user-config"]),
      flag("ignore-rules", "Ignore execution rules", "Do not load user or project execpolicy rules", "safety", ["--ignore-rules"]),
      flag("strict-config", "Strict configuration", "Fail on unrecognized configuration keys", "safety", ["--strict-config"])
    ],
    managers: {
      mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "url-or-doubledash" } },
      plugins: { label: "Plugins", listArgv: ["plugin", "list"], manageArgv: ["plugin"] },
      agents: { label: "Agents", listArgv: ["agents"], manageArgv: ["agents"] }
    },
    features: ["skills", "plugins", "approval policies", "feature flags", "configuration profiles"]
  },
  opencode: {
    options: [
      value("agent", "Agent", "Agent configuration used for the turn", "mode", ["--agent"]),
      value("title", "Session title", "Title assigned to a new native session", "session", ["--title"], "string", { appliesTo: "start" }),
      flag("pure", "Pure mode", "Run without external plugins", "safety", ["--pure"]),
      flag("auto-approve", "Auto approve", "Auto-approve permissions not explicitly denied", "permissions", ["--auto"], { dangerous: true }),
      flag("thinking-output", "Show thinking events", "Include provider thinking blocks in event output", "output", ["--thinking"]),
      flag("fork-native-session", "Fork native session", "Fork before continuing the selected session", "session", ["--fork"], { appliesTo: "resume", requiresNewSession: true }),
      flag("share", "Share session", "Publish the native session through OpenCode", "session", ["--share"])
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], add: { argv: ["mcp", "add"], shape: "named-flags", urlPrefix: ["--url"], remoteOnly: true } }, agents: { label: "Agents", manageArgv: ["agent"] } },
    features: ["plugins", "commands", "remote server attachment"]
  },
  copilot: {
    options: [
      value("agent", "Agent", "Custom Copilot agent", "mode", ["--agent"]),
      value("additional-mcp-config", "Additional MCP config", "Per-session MCP JSON or @file", "tools", ["--additional-mcp-config"]),
      value("allow-tool", "Allowed tools", "Tool or MCP permission patterns", "permissions", ["--allow-tool"], "string-list", { argvStyle: "repeat" }),
      value("deny-tool", "Denied tools", "Tool or MCP denial patterns", "permissions", ["--deny-tool"], "string-list", { argvStyle: "repeat" }),
      value("context-tier", "Context tier", "Context-window tier for supported models", "model", ["--context"], "enum", { values: ["default", "long_context"] }),
      value("max-autopilot-continues", "Autopilot continuation limit", "Maximum automatic continuation messages", "safety", ["--max-autopilot-continues"], "number"),
      flag("plan", "Plan mode", "Start in read-only planning mode", "mode", ["--plan"]),
      flag("no-ask-user", "Disable questions", "Prevent the agent from asking clarifying questions", "mode", ["--no-ask-user"]),
      flag("sandbox", "Shell sandbox", "Enable Copilot\u2019s OS-level shell sandbox", "safety", ["--sandbox"]),
      flag("no-custom-instructions", "Ignore custom instructions", "Do not load repository instruction files", "context", ["--no-custom-instructions"]),
      flag("no-remote", "Disable remote access", "Disable remote control for this session", "safety", ["--no-remote"]),
      flag("no-remote-export", "Disable remote export", "Do not export this session to GitHub remote clients", "safety", ["--no-remote-export"]),
      flag("worktree", "Managed worktree", "Run in a separate managed Git worktree", "session", ["--worktree"], { requiresNewSession: true })
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list", "--json"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "doubledash-local", transportPrefix: ["--transport"] } }, plugins: { label: "Plugins", manageArgv: ["plugin"] }, skills: { label: "Skills", manageArgv: ["skill"] }, agents: { label: "Instructions and agents", manageArgv: ["instruction"] } },
    features: ["skills", "custom agents", "hooks", "plugins", "built-in GitHub MCP"]
  },
  aider: {
    options: [
      value("edit-format", "Edit format", "Editing protocol used by the primary model", "mode", ["--edit-format"]),
      value("weak-model", "Weak model", "Model used for commits and history summarization", "model", ["--weak-model"]),
      value("editor-model", "Editor model", "Model used for editor tasks", "model", ["--editor-model"]),
      value("file", "Editable files", "Files added to the editable chat context", "context", ["--file"], "path-list", { argvStyle: "repeat" }),
      value("read", "Read-only files", "Files added as read-only context", "context", ["--read"], "path-list", { argvStyle: "repeat" }),
      value("lint-command", "Lint command", "Command Aider runs to lint changes", "tools", ["--lint-cmd"]),
      value("test-command", "Test command", "Command Aider runs for tests", "tools", ["--test-cmd"]),
      value("map-tokens", "Repository map tokens", "Token budget for the repository map", "context", ["--map-tokens"], "number"),
      value("map-refresh", "Repository map refresh", "When Aider refreshes its repository map", "context", ["--map-refresh"], "enum", { values: ["auto", "always", "files", "manual"] }),
      value("max-history-tokens", "History token limit", "Soft limit before chat-history summarization", "session", ["--max-chat-history-tokens"], "number"),
      flag("architect", "Architect mode", "Use architect/editor two-stage changes", "mode", ["--architect"]),
      flag("dry-run", "Dry run", "Analyze without modifying files", "safety", ["--dry-run"]),
      flag("no-git", "Disable Git integration", "Do not inspect or modify Git state", "safety", ["--no-git"]),
      flag("no-auto-commits", "Disable auto commits", "Do not automatically commit agent changes", "safety", ["--no-auto-commits"]),
      flag("cache-prompts", "Prompt caching", "Enable provider prompt caching", "advanced", ["--cache-prompts"])
    ],
    features: ["architect/ask/code modes", "lint and test commands", "repository map", "voice"]
  },
  goose: {
    options: [
      value("provider", "Inference provider", "Provider used for this run", "model", ["--provider"]),
      value("system", "Additional instructions", "Additional system instructions for the agent", "context", ["--system"]),
      value("max-tool-repetitions", "Tool repetition limit", "Maximum identical consecutive tool calls", "safety", ["--max-tool-repetitions"], "number"),
      value("max-turns", "Maximum turns", "Maximum autonomous turns without user input", "safety", ["--max-turns"], "number"),
      value("container", "Extension container", "Run extensions in the selected Docker container", "safety", ["--container"]),
      value("with-extension", "Stdio extensions", "Additional stdio extension commands", "tools", ["--with-extension"], "string-list", { argvStyle: "repeat" }),
      value("with-http-extension", "HTTP extensions", "Additional Streamable HTTP extension URLs", "tools", ["--with-streamable-http-extension"], "string-list", { argvStyle: "repeat" }),
      value("with-builtin", "Built-in extensions", "Built-in extensions enabled for the run", "tools", ["--with-builtin"], "string-list"),
      flag("ephemeral", "Ephemeral session", "Do not store the Goose session", "session", ["--no-session"], { requiresNewSession: true })
    ],
    managers: { mcp: { label: "MCP servers", manageArgv: ["configure"], configFile: { homeRelativeDir: [".config", "goose"], file: "config.yaml", key: "extensions", format: "yaml", entryShape: "goose-extension" } }, skills: { label: "Skills", listArgv: ["skills", "list"] }, plugins: { label: "Plugins", manageArgv: ["plugin"] } },
    features: ["extensions", "recipes", "ACP", "scheduled recipes", "session export"]
  },
  // MCP surfaces read from each CLI's own --help on a real install. These
  // three support MCP and had no capability entry at all, so ClikCode offered
  // them no /mcp even though the harness has one.
  //
  // Options read from `grok --help`: --allow/--deny are permission RULES (the
  // --allowedTools/--disallowedTools aliases sit beside them), while
  // --disallowed-tools removes built-in tools outright. --always-approve is
  // deliberately absent: it is a bypass-permission spelling the permission
  // selector already owns, and a raw row beside it would disagree with Ask.
  grok: {
    options: [
      value("agent", "Agent", "Agent name or definition file used for the session", "mode", ["--agent"]),
      value("allow", "Allowed tools", "Permission allow rules for tools", "permissions", ["--allow"], "string-list", { argvStyle: "repeat" }),
      value("deny", "Denied tools", "Permission deny rules for tools", "permissions", ["--deny"], "string-list", { argvStyle: "repeat" }),
      value("disallowed-tools", "Removed built-in tools", "Built-in tools to remove, comma-separated", "tools", ["--disallowed-tools"], "string-list", { argvStyle: "csv" }),
      flag("disable-web-search", "Disable web search", "Disable web search and web fetch tools", "tools", ["--disable-web-search"]),
      flag("no-subagents", "Disable subagents", "Disable subagent spawning", "mode", ["--no-subagents"]),
      flag("no-plan", "Disable plan mode", "Skip the plan phase before execution", "mode", ["--no-plan"]),
      value("rules", "Rules", "Extra rules appended to the system prompt", "context", ["--rules"], "path"),
      value("sandbox", "Sandbox", "Sandbox profile for filesystem and network access", "safety", ["--sandbox"]),
      value("system-prompt", "System prompt", "Override the agent system prompt", "context", ["--system-prompt-override"]),
      value("tools", "Built-in tools", "Built-in tools to allow, comma-separated", "tools", ["--tools"], "string-list", { argvStyle: "csv" }),
      flag("verbatim", "Verbatim prompt", "Send the prompt exactly as given", "output", ["--verbatim"]),
      value("json-schema", "Output schema", "JSON schema constraining the final response", "output", ["--json-schema"]),
      value("max-turns", "Maximum turns", "Maximum number of agent turns", "safety", ["--max-turns"], "number"),
      flag("worktree", "Managed worktree", "Start the session in a new Git worktree", "session", ["--worktree"], { requiresNewSession: true }),
      flag("fork-session", "Fork on resume", "Create a new session id when resuming", "session", ["--fork-session"], { appliesTo: "resume", requiresNewSession: true })
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove", "--scope", "user"] }, add: { argv: ["mcp", "add"], shape: "positional" } }, plugins: { label: "Plugins", manageArgv: ["plugin"] } },
    features: ["skills", "plugins", "subagents", "plan mode", "memory"]
  },
  kimi: {
    options: [
      value("agent", "Agent", "Agent profile starting the new session", "mode", ["--agent"], "string", { appliesTo: "start", requiresNewSession: true }),
      value("agent-file", "Agent definition file", "Markdown agent definition loaded for the session", "mode", ["--agent-file"], "path", { appliesTo: "start", requiresNewSession: true }),
      value("skills-dir", "Skills directory", "Load skills from this directory instead of auto-discovery", "tools", ["--skills-dir"], "path-list", { argvStyle: "repeat" }),
      value("add-dir", "Additional directories", "Additional workspace directories for the session", "context", ["--add-dir"], "path-list", { argvStyle: "repeat" })
      // No `plan` row here, and not because the flag is missing: Kimi's own
      // `--help` maps read-only planning to `--plan`, which is already the argv
      // ClikCode sends for Ask permissions. A second `--plan` row would race
      // the permission selector for the same flag on the same turn.
    ],
    // No MCP here: `kimi --help` lists export/fork/provider/session/acp/web/
    // server/rc/login/doctor/vis/install-desktop and mentions mcp nowhere.
    // An earlier entry claimed one on a misreading of that list.
    managers: { mcp: { label: "MCP servers", manageArgv: ["mcp"], configFile: { rootEnv: "KIMI_CODE_HOME", homeRelativeDir: [".kimi-code"], file: "mcp.json", key: "mcpServers" } } },
    features: ["skills", "agents", "ACP"]
  },
  openhands: {
    options: [
      value("file", "Seed file", "File whose contents seed the initial conversation", "context", ["--file"], "path"),
      flag("exit-without-confirmation", "Exit without confirmation", "Exit even when an action would require confirmation", "safety", ["--exit-without-confirmation"]),
      flag("override-with-envs", "Override env vars", "Read LLM_API_KEY, LLM_BASE_URL and LLM_MODEL from the environment", "advanced", ["--override-with-envs"])
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "positional", transportPrefix: ["--transport"], localTransport: "stdio" } } },
    features: ["ACP", "web UI"]
  },
  // Amp is the only harness of the 25 that reports a CREDIT BALANCE rather
  // than spend: `amp usage` is documented as "Show your current Amp usage and
  // credit balance", with --details for a credit/token/thread breakdown.
  //
  // Not wired, and deliberately so: it needs an Amp login to return anything
  // ("Invalid or missing API key"), so its output shape is unverified here. A
  // parser written against a guessed shape would put an invented money figure
  // on screen, which is worse than showing nothing. Wire it from a real
  // response, not from this comment.
  amp: {
    options: [
      value("mcp-config", "MCP configuration", "Per-turn MCP server configuration", "tools", ["--mcp-config"]),
      flag("fast", "Fast mode", "Use Amp Fast mode for this invocation", "mode", ["--fast"]),
      value("plugin-ready-timeout", "Plugin startup timeout", "Wait this many seconds for plugins before starting", "tools", ["--plugin-ready-timeout"], "number")
    ],
    managers: { mcp: { label: "MCP servers", manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "doubledash-local" } } },
    features: ["skills", "plugins", "orbs", "settings layers"]
  },
  antigravity: {
    options: [
      value("agent", "Agent", "Agent used for the current session", "mode", ["--agent"]),
      value("add-dir", "Additional directories", "Additional directories included in the workspace", "context", ["--add-dir"], "path-list", { argvStyle: "repeat" }),
      value("json-schema", "Output schema", "JSON schema string or file for the final result", "output", ["--json-schema"]),
      value("print-timeout", "Turn timeout", "Maximum print-mode duration, such as 15m", "safety", ["--print-timeout"]),
      value("project", "Project", "Project id or name for this session", "context", ["--project"], "string", { requiresNewSession: true }),
      value("mode", "Execution mode", "Use edit-accepting or read-only planning behavior", "mode", ["--mode"], "enum", { values: ["accept-edits", "plan"] }),
      flag("sandbox", "Terminal sandbox", "Run terminal commands with sandbox restrictions", "safety", ["--sandbox"]),
      flag("disable-skills", "Disable skills", "Disable slash-command and skill expansion", "tools", ["--disable-slash-commands"])
    ],
    managers: {
      mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "positional", transportPrefix: ["--type"] } },
      plugins: { label: "Plugins", listArgv: ["plugin", "list"], manageArgv: ["plugin"] },
      agents: { label: "Agents", listArgv: ["agents"], manageArgv: ["agents"] }
    },
    features: ["skills", "plugins", "custom agents", "remote control", "sandbox"]
  },
  pi: {
    options: [
      value("provider", "Inference provider", "Provider used for this turn", "model", ["--provider"]),
      value("tools", "Allowed tools", "Allowlist built-in, extension, and custom tools", "tools", ["--tools"], "string-list", { argvStyle: "csv" }),
      value("exclude-tools", "Excluded tools", "Disable matching tool names", "tools", ["--exclude-tools"], "string-list", { argvStyle: "csv" }),
      value("models", "Model cycle", "Models available for in-session cycling", "model", ["--models"], "string-list", { argvStyle: "csv" }),
      value("session-dir", "Session directory", "Custom directory for native session storage", "session", ["--session-dir"], "path", { requiresNewSession: true }),
      value("session-name", "Session name", "Name assigned to a new native session", "session", ["--name"], "string", { appliesTo: "start" }),
      flag("no-builtin-tools", "Disable built-in tools", "Keep extension tools but disable built-in tools", "tools", ["--no-builtin-tools"]),
      flag("no-tools", "Disable all tools", "Start without any tools enabled", "tools", ["--no-tools"]),
      flag("ephemeral", "Ephemeral session", "Do not save a native session", "session", ["--no-session"], { requiresNewSession: true })
    ],
    managers: { plugins: { label: "Packages and extensions", listArgv: ["list"], manageArgv: ["config"] } },
    features: ["extensions", "skills", "prompt templates", "provider/model registry"]
  },
  droid: {
    options: [
      value("restrict-tools", "Restricted tools", "Allow only the selected tool ids", "tools", ["--restrict-tools"], "string-list"),
      value("additional-tools", "Additional tools", "Enable tools beyond the defaults", "tools", ["--additional-tools"], "string-list"),
      value("disabled-tools", "Disabled tools", "Disable selected tool ids", "tools", ["--disabled-tools"], "string-list"),
      value("spec-model", "Specification model", "Model used during specification planning", "model", ["--spec-model"]),
      value("spec-effort", "Specification effort", "Reasoning effort used during specification planning", "reasoning", ["--spec-reasoning-effort"]),
      value("append-system-prompt", "Additional instructions", "Append text to Droid\u2019s system prompt", "context", ["--append-system-prompt"]),
      value("append-system-prompt-file", "Instruction file", "Append a file to Droid\u2019s system prompt", "context", ["--append-system-prompt-file"], "path"),
      flag("spec-mode", "Specification mode", "Plan in read-only specification mode before execution", "mode", ["--use-spec"]),
      flag("disable-builtin-skills", "Disable built-in skills", "Hide Factory-provided skills while retaining other skill sources", "tools", ["--disable-builtin-skills"]),
      flag("worktree", "Managed worktree", "Run in an isolated Droid worktree", "session", ["--worktree"], { requiresNewSession: true }),
      flag("mission", "Mission mode", "Run multi-agent mission orchestration", "mode", ["--mission"])
    ],
    managers: { mcp: { label: "MCP servers", manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "positional", transportPrefix: ["--type"] } }, plugins: { label: "Plugins", manageArgv: ["plugin"] } },
    features: ["skills", "custom droids", "hooks", "missions", "auto/spec modes", "JSON-RPC permission transport"]
  },
  kiro: {
    options: [
      value("agent-engine", "Agent engine", "Headless engine version", "advanced", ["--agent-engine"], "enum", { values: ["v1", "v2", "v3"], requiresNewSession: true }),
      value("trusted-tools", "Trusted tools", "Tool categories approved in advance", "permissions", ["--trust-tools"], "string-list", { argvStyle: "csv" }),
      flag("require-mcp-startup", "Require MCP startup", "Fail the run if any MCP server cannot start", "tools", ["--require-mcp-startup"])
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove", "--scope", "global", "--name"] }, add: { argv: ["mcp", "add", "--scope", "global", "--force"], shape: "named-flags", namePrefix: ["--name"], urlPrefix: ["--url"], commandPrefix: ["--command"], argsPrefix: ["--args"], argsStyle: "json-array" } } },
    features: ["skills", "custom agents", "hooks", "steering", "powers", "plan mode"]
  },
  // Every flag here read from `gemini --help` on a real install. --safe-mode
  // was in the entry this replaces and no longer exists in 0.60.0; --policy
  // and --extensions are new and did not. --allowed-tools is documented as
  // deprecated in favour of the policy engine but still accepted, so it stays
  // until it actually stops working.
  gemini: {
    options: [
      value("approval-mode", "Approval mode", "Tool-call approval policy", "permissions", ["--approval-mode"], "enum", { values: ["default", "auto_edit", "yolo", "plan"] }),
      value("allowed-tools", "Allowed tools", "Tools that bypass confirmation", "permissions", ["--allowed-tools"], "string-list"),
      value("policy", "Policy files", "Additional policy files or directories to load", "permissions", ["--policy"], "path-list"),
      value("allowed-mcp-servers", "Allowed MCP servers", "MCP servers enabled for this session", "tools", ["--allowed-mcp-server-names"], "string-list"),
      value("include-directories", "Additional directories", "Additional directories included in context", "context", ["--include-directories"], "path-list"),
      value("extensions", "Extensions", "Extensions to load; all are used when unset", "tools", ["--extensions"], "string-list")
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "positional", transportPrefix: ["--transport"] } }, plugins: { label: "Extensions", listArgv: ["extensions", "list"], manageArgv: ["extensions"] } },
    features: ["skills", "agents", "extensions", "custom commands", "memory"]
  },
  qwen: {
    options: [
      value("approval-mode", "Approval mode", "Tool-call approval policy", "permissions", ["--approval-mode"], "enum", { values: ["plan", "default", "auto-edit", "auto", "yolo"] }),
      value("include-directories", "Additional directories", "Additional roots included in context", "context", ["--include-directories"], "path-list"),
      value("max-session-turns", "Maximum turns", "Limit model/tool turns in this run", "safety", ["--max-session-turns"], "number"),
      value("max-wall-time", "Maximum wall time", "Wall-clock limit such as 10m", "safety", ["--max-wall-time"]),
      value("max-tool-calls", "Maximum tool calls", "Cumulative tool-call limit", "safety", ["--max-tool-calls"], "number"),
      flag("safe-mode", "Safe mode", "Disable context, hooks, extensions, skills, MCP, subagents, and memory", "safety", ["--safe-mode"])
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove", "--scope", "user"] }, add: { argv: ["mcp", "add"], shape: "positional", transportPrefix: ["-t"] } }, skills: { label: "Skills", manageArgv: ["skills"] } },
    features: ["skills", "extensions", "subagents", "workflows", "memory", "plan mode"]
  },
  cline: {
    options: [
      value("provider", "Inference provider", "Cline inference provider id", "model", ["--provider"]),
      value("system-prompt", "System prompt", "Override the default system prompt", "context", ["--system"]),
      value("auto-approve", "Auto approve", "Whether Cline auto-approves tool use", "permissions", ["--auto-approve"], "enum", { values: ["true", "false"], dangerous: true }),
      value("compaction", "Context compaction", "Context compaction strategy", "session", ["--compaction"], "enum", { values: ["agentic", "basic", "off"] }),
      value("retries", "Retry limit", "Maximum consecutive mistakes before stopping", "safety", ["--retries"], "number"),
      value("timeout", "Turn timeout", "Maximum run time in seconds; zero disables the limit", "safety", ["--timeout"], "number"),
      value("data-dir", "Data directory", "Isolated Cline state directory", "session", ["--data-dir"], "path", { requiresNewSession: true }),
      value("hooks-dir", "Hooks directory", "Additional runtime hooks directory", "tools", ["--hooks-dir"], "path"),
      flag("plan", "Plan mode", "Run read-only planning behavior", "mode", ["--plan"]),
      flag("worktree", "Managed worktree", "Run in a detached managed worktree", "session", ["--worktree"], { requiresNewSession: true })
    ],
    managers: { mcp: { label: "MCP servers", manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add", "--yes"], shape: "doubledash-local", transportPrefix: ["--transport"] } }, plugins: { label: "Plugins", manageArgv: ["plugin"] }, skills: { label: "Skills", manageArgv: ["skill"] }, hooks: { label: "Hooks", manageArgv: ["hook"] } },
    features: ["skills", "rules", "checkpoints", "plan/act modes", "schedules"]
  },
  kilo: {
    options: [
      value("agent", "Agent", "Agent configuration used for the turn", "mode", ["--agent"]),
      value("title", "Session title", "Title assigned to a new native session", "session", ["--title"], "string", { appliesTo: "start" }),
      flag("pure", "Pure mode", "Run without external plugins", "safety", ["--pure"]),
      flag("thinking-output", "Show thinking events", "Include provider thinking blocks in event output", "output", ["--thinking"]),
      flag("fork-native-session", "Fork native session", "Fork before continuing the selected session", "session", ["--fork"], { appliesTo: "resume", requiresNewSession: true }),
      flag("cloud-fork", "Fork cloud session", "Fetch and fork the selected cloud session locally", "session", ["--cloud-fork"], { appliesTo: "resume", requiresNewSession: true }),
      flag("share", "Share session", "Publish the native session through Kilo", "session", ["--share"])
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], add: { argv: ["mcp", "add"], shape: "named-flags", urlPrefix: ["--url"], remoteOnly: true } }, plugins: { label: "Plugins", manageArgv: ["plugin"] } },
    features: ["skills", "architect/ask/debug/orchestrator modes", "custom agents"]
  },
  cursor: {
    options: [
      value("mode", "Execution mode", "Read-only plan or question mode", "mode", ["--mode"], "enum", { values: ["plan", "ask"] }),
      value("sandbox", "Sandbox", "Explicitly enable or disable the Cursor sandbox", "safety", ["--sandbox"], "enum", { values: ["enabled", "disabled"] }),
      value("add-dir", "Additional directories", "Additional workspace roots", "context", ["--add-dir"], "path-list", { argvStyle: "repeat" }),
      value("plugin-dir", "Plugin directories", "Local plugins loaded for the session", "tools", ["--plugin-dir"], "path-list", { argvStyle: "repeat" }),
      flag("auto-review", "Auto review", "Automatically run safe tools and review the rest", "permissions", ["--auto-review"]),
      flag("approve-mcps", "Approve MCP servers", "Automatically approve configured MCP servers", "permissions", ["--approve-mcps"], { dangerous: true }),
      flag("trust", "Trust workspace", "Trust the current workspace without prompting", "permissions", ["--trust"], { dangerous: true }),
      flag("force", "Force commands", "Allow commands unless explicitly denied", "permissions", ["--force"], { dangerous: true }),
      flag("worktree", "Managed worktree", "Start in an isolated Cursor worktree", "session", ["--worktree"], { requiresNewSession: true })
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], configFile: { homeRelativeDir: [".cursor"], file: "mcp.json", key: "mcpServers" } }, plugins: { label: "Plugins", manageArgv: ["plugin"] } },
    features: ["plugins", "rules", "worktrees", "plan/ask modes"]
  },
  // Hermes is deliberately absent from the `mcp add` grammars even though it
  // has one: `hermes mcp add --url ...` opens an interactive prompt ("Does
  // this server require authentication?") and waits on stdin, so driving it
  // headlessly hangs the fan-out rather than failing it. Checked live.
  auggie: {
    // Options read from `auggie --help`. `-a/--ask` stays a raw row, not a
    // permission mode: it means "retrieval and non-editing tools only" (the
    // read-only mode), which is orthogonal to ClikCode's ask/bypass/auto
    // approval modes. --add-workspace folds into the /add-dir control.
    options: [
      value("persona", "Persona", "Agent persona used for the session", "mode", ["--persona"]),
      value("add-dir", "Additional workspaces", "Additional workspace directories to index", "context", ["--add-workspace"], "path-list", { argvStyle: "repeat" }),
      value("rules", "Additional rules", "Additional rules file loaded for the session", "context", ["--rules"], "path-list", { argvStyle: "repeat" }),
      flag("ask", "Read-only ask mode", "Retrieval and non-editing tools only", "mode", ["--ask"]),
      value("max-turns", "Maximum turns", "Limit the number of agentic turns", "safety", ["--max-turns"], "number"),
      value("mcp-config", "MCP configuration", "MCP server configuration", "tools", ["--mcp-config"], "string-list", { argvStyle: "repeat" }),
      value("plugin-dir", "Plugin directories", "Local plugin marketplace directories", "tools", ["--plugin-dir"], "path-list", { argvStyle: "repeat" }),
      value("permission", "Tool permissions", "Tool permission rules in tool-name:policy form", "permissions", ["--permission"], "string-list", { argvStyle: "repeat" }),
      value("remove-tool", "Removed tools", "Remove a tool by name", "tools", ["--remove-tool"], "string-list", { argvStyle: "repeat" }),
      value("shell", "Shell", "Shell used for commands", "advanced", ["--shell"], "enum", { values: ["bash", "zsh", "fish", "sh", "powershell"] }),
      value("retry-timeout", "Retry timeout", "Timeout for rate-limit retries, in seconds", "safety", ["--retry-timeout"], "number"),
      value("startup-script", "Startup script", "Inline startup script run before each command", "session", ["--startup-script"]),
      value("startup-script-file", "Startup script file", "Load the startup script from a file", "session", ["--startup-script-file"], "path"),
      flag("enhance-prompt", "Enhance prompt", "Enhance the prompt before sending", "advanced", ["--enhance-prompt"]),
      flag("show-cost", "Show cost", "Show the billing cost summary at the end of the run", "output", ["--show-cost"]),
      flag("allow-indexing", "Allow indexing", "Skip the indexing confirmation screen", "context", ["--allow-indexing"]),
      flag("wait-for-indexing", "Wait for indexing", "Wait for workspace indexing before inference", "context", ["--wait-for-indexing"]),
      flag("ephemeral", "Do not save session", "Do not save conversation history", "session", ["--dont-save-session"], { requiresNewSession: true }),
      value("augment-cache-dir", "Cache directory", "Cache directory, defaults to ~/.augment", "advanced", ["--augment-cache-dir"], "path")
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "named-flags", transportPrefix: ["-t"], urlPrefix: ["-u"], commandPrefix: ["-c"], argsPrefix: ["--args"], argsStyle: "joined" } } }
  },
  vibe: {
    // Options read from `vibe --help`. --smart-approve and --auto-approve are
    // deliberately absent: they are the permission selector's own spellings,
    // and a raw row beside Ask/Bypass/Auto would disagree with the selector.
    options: [
      value("max-turns", "Maximum turns", "Maximum number of assistant turns", "safety", ["--max-turns"], "number"),
      value("max-price", "Maximum price", "Maximum cost in dollars for the session", "safety", ["--max-price"], "number"),
      value("max-tokens", "Maximum tokens", "Maximum total prompt plus completion tokens", "safety", ["--max-tokens"], "number"),
      value("enabled-tools", "Enabled tools", "Enable specific tools; disables all others", "tools", ["--enabled-tools"], "string-list", { argvStyle: "repeat" }),
      value("disabled-tools", "Disabled tools", "Disable tools after enabled-tools filtering", "tools", ["--disabled-tools"], "string-list", { argvStyle: "repeat" }),
      value("agent", "Agent", "Agent used for the session", "mode", ["--agent"]),
      flag("trust", "Trust workspace", "Trust the working directory for this invocation only", "permissions", ["--trust"], { dangerous: true }),
      value("add-dir", "Additional directories", "Additional working directories for file access", "context", ["--add-dir"], "path-list", { argvStyle: "repeat" }),
      flag("worktree", "Managed worktree", "Run inside a Git worktree under $VIBE_HOME/worktrees", "session", ["--worktree"], { requiresNewSession: true })
    ],
    managers: { mcp: { label: "MCP servers", manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "named-flags", transportPrefix: ["--transport"], localTransport: "stdio", urlPrefix: ["--url"], commandPrefix: ["--command"], argsPrefix: ["--arg"], argsStyle: "repeat-equals", remoteExtraArgv: ["--no-login"] } } }
  },
  // `openclaw agent` (2026.9.6). --agent, --session-id/--session-key,
  // --model, --thinking and --message are the turn itself; delivery flags
  // (--channel, --deliver, --reply-*) send the reply to a chat app, which is
  // not a coding turn.
  openclaw: {
    options: [
      value("timeout", "Turn timeout (seconds)", "Override the agent command timeout", "safety", ["--timeout"], "number"),
      value("verbose", "Verbose", "Persist the agent verbose level for the session", "output", ["--verbose"], "enum", { values: ["on", "off"] })
    ],
    managers: { mcp: { label: "MCP servers", manageArgv: ["mcp"] }, plugins: { label: "Plugins", manageArgv: ["plugins"] }, skills: { label: "Skills", manageArgv: ["skills"] }, hooks: { label: "Hooks", manageArgv: ["hooks"] } },
    features: ["plugins", "skills", "hooks", "memory", "chat channels", "model fallbacks"]
  },
  hermes: {
    options: [
      value("toolsets", "Toolsets", "Toolsets enabled for the turn, from hermes tools list", "tools", ["--toolsets"], "string-list", { argvStyle: "csv" }),
      value("skills", "Preloaded skills", "Skills loaded for this session", "tools", ["--skills"], "string-list", { argvStyle: "csv" }),
      value("max-turns", "Maximum turns", "Maximum tool-calling iterations in one turn", "safety", ["--max-turns"], "number"),
      value("run-budget", "Run budget (seconds)", "Wall-clock budget for one run", "safety", ["--run-budget"], "number"),
      flag("worktree", "Isolated worktree", "Run in an isolated Git worktree", "session", ["--worktree"], { requiresNewSession: true }),
      flag("checkpoints", "Checkpoints", "Snapshot files before destructive edits", "safety", ["--checkpoints"]),
      flag("accept-hooks", "Accept hooks", "Auto-approve unseen shell hooks", "safety", ["--accept-hooks"]),
      flag("pass-session-id", "Pass session id", "Include the session id in the system prompt", "session", ["--pass-session-id"]),
      flag("verbose", "Verbose", "Verbose output", "output", ["--verbose"]),
      flag("safe-mode", "Safe mode", "Disable user config, rules, plugins, and MCP", "safety", ["--safe-mode"]),
      flag("ignore-user-config", "Ignore user config", "Use built-in defaults while retaining credentials", "safety", ["--ignore-user-config"]),
      flag("ignore-rules", "Ignore rules", "Skip AGENTS.md, memory, and preloaded skills", "safety", ["--ignore-rules"]),
      flag("yolo", "Bypass approvals", "Bypass dangerous-command approvals", "permissions", ["--yolo"], { dangerous: true })
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove"] }, add: { argv: ["mcp", "add"], shape: "named-flags", urlPrefix: ["--url"], commandPrefix: ["--command"], argsPrefix: ["--args"], argsStyle: "list", confirmStdin: "y\n" } }, skills: { label: "Skills", manageArgv: ["skills"] }, plugins: { label: "Plugins", manageArgv: ["plugins"] }, tools: { label: "Tools", manageArgv: ["tools"] }, hooks: { label: "Hooks", manageArgv: ["hooks"] } },
    features: ["skills", "bundles", "plugins", "hooks", "memory", "fallback providers", "toolsets"]
  },
  command: {
    options: [
      value("max-turns", "Maximum turns", "Maximum turns in print mode", "safety", ["--max-turns"], "number"),
      value("add-dir", "Additional directories", "Additional directories in workspace context", "context", ["--add-dir"], "path-list", { argvStyle: "repeat" }),
      value("mod", "Mods", "Mod files or directories loaded for this session", "tools", ["--mod"], "path-list", { argvStyle: "repeat" }),
      value("mod-option", "Mod options", "Mod-declared name=value settings", "tools", ["--mod-option"], "string-list", { argvStyle: "repeat" }),
      value("skill", "Skill paths", "Additional skill directories", "tools", ["--skill"], "path-list", { argvStyle: "repeat" }),
      flag("plan", "Plan mode", "Start in read-only planning mode", "mode", ["--plan"]),
      flag("local-only", "Local-only inference", "Use BYOK providers without Command Code traffic", "safety", ["--local-only"]),
      flag("trust", "Trust project", "Skip the initial workspace trust prompt", "permissions", ["--trust"], { dangerous: true }),
      flag("tools-all", "Enable all tools", "Enable tools normally withheld in headless mode", "tools", ["--tools-all"], { dangerous: true }),
      flag("no-skills", "Disable skills", "Skip automatic skill discovery", "tools", ["--no-skills"]),
      flag("worktree", "Managed worktree", "Run in an isolated managed worktree", "session", ["--worktree"], { requiresNewSession: true }),
      flag("ephemeral", "Ephemeral session", "Do not persist the native session", "session", ["--no-session"], { requiresNewSession: true })
    ],
    managers: { mcp: { label: "MCP servers", listArgv: ["mcp", "list"], manageArgv: ["mcp"], remove: { argv: ["mcp", "remove", "--scope", "user"] }, add: { argv: ["mcp", "add", "-s", "user"], shape: "positional", transportPrefix: ["-t"] } }, skills: { label: "Skills", manageArgv: ["skills"] }, plugins: { label: "Mods", manageArgv: ["mods"] } },
    features: ["skills", "mods", "taste learning", "MCP", "managed worktrees", "plan mode"]
  },
  // Continue: these are the raw vendor rows for the flags `cn --help` really
  // lists. --model stays the model selector's own flag (the help's --model
  // hub-slug spelling is the same flag name) and --prompt is the turn's own
  // prompt, so neither becomes a row beside its owner. The permission surface
  // (--readonly / --auto / --allow / --ask / --exclude) overlaps the selector:
  // only the two tool-list spellings --allow and --ask sit here as rows, and
  // they are the pieces of that surface the selector does not drive.
  cn: {
    options: [
      value("agent", "Agent", "Agent file loaded from the hub", "mode", ["--agent"]),
      value("config", "Config", "Configuration file path or hub slug", "advanced", ["--config"]),
      value("org", "Organization", "Organization slug used in headless mode", "advanced", ["--org"]),
      flag("verbose", "Verbose", "Verbose logging", "output", ["--verbose"]),
      flag("beta-status-tool", "Beta status tool", "Enable the beta status tool", "tools", ["--beta-status-tool"]),
      flag("beta-subagent-tool", "Beta subagent tool", "Enable the beta subagent tool", "tools", ["--beta-subagent-tool"]),
      value("rules", "Rules", "Rules added for the session", "context", ["--rule"], "string-list", { argvStyle: "repeat" }),
      value("mcp", "MCP servers", "MCP servers loaded from the hub as owner/package slugs", "tools", ["--mcp"], "string-list", { argvStyle: "repeat" }),
      value("allow", "Allowed tools", "Tools allowed, overriding default policies", "permissions", ["--allow"], "string-list", { argvStyle: "repeat" }),
      value("ask", "Ask about tools", "Tools that ask for permission before use", "permissions", ["--ask"], "string-list", { argvStyle: "repeat" }),
      value("exclude", "Excluded tools", "Tools excluded from use", "tools", ["--exclude"], "string-list", { argvStyle: "repeat" })
    ]
  }
};
var customHarnesses = [];
function allLocalHarnesses() {
  return customHarnesses.length ? [...AI_LOCAL_HARNESSES, ...customHarnesses] : AI_LOCAL_HARNESSES;
}
function localHarnessForCommand2(command) {
  const normalized = command.trim().replace(/^\//, "").toLowerCase();
  return allLocalHarnesses().find((item) => item.command === normalized);
}

// .tmp/key-login.ts
var controller = new AbortController();
var asked = [];
var screen = {
  signal: controller.signal,
  stop: () => void 0,
  show: () => void 0,
  ask: async (prompt, secret) => {
    asked.push(`ask:${prompt}${secret ? "(secret)" : ""}`);
    if (/API key/i.test(prompt)) return process.env.QK ?? "";
    controller.abort();
    return "";
  },
  choose: async (title) => {
    asked.push(`choose:${title}`);
    controller.abort();
    return void 0;
  }
};
setTimeout(() => controller.abort(), 9e4);
withSignInScreen(screen, () => loginNativeHarness(localHarnessForCommand2(process.argv[2]))).then(() => console.log("signed in"), (e) => console.log("END", e.message)).finally(() => {
  console.log("user was asked:", asked);
  process.exit(0);
});
