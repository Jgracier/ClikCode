var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/agent/computer/shared-state.ts
function sharedState(key, make) {
  const holder = globalThis;
  const name = `__clikcode_${key}`;
  return holder[name] ??= make();
}
var init_shared_state = __esm({
  "src/agent/computer/shared-state.ts"() {
    "use strict";
  }
});

// src/agent/computer/secret-scrubber.ts
function forms(value) {
  const out = /* @__PURE__ */ new Set([
    value,
    value.trim(),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1)
  ]);
  return [...out].filter((form) => form.length >= 4);
}
function registerSecret(value) {
  for (const form of forms(value)) live.set(form, value);
}
function scrubSecrets(text) {
  if (!live.size) return text;
  let out = text;
  for (const form of [...live.keys()].sort((a, b) => b.length - a.length)) if (out.includes(form)) out = out.split(form).join(MASK);
  return out;
}
function showsSecret(text) {
  return live.size > 0 && scrubSecrets(text) !== text;
}
var live, MASK;
var init_secret_scrubber = __esm({
  "src/agent/computer/secret-scrubber.ts"() {
    "use strict";
    init_shared_state();
    live = sharedState("secrets-live", () => /* @__PURE__ */ new Map());
    MASK = "[secret hidden]";
  }
});

// src/agent/tool-contract.ts
function defineTool(definition) {
  return definition;
}
var init_tool_contract = __esm({
  "src/agent/tool-contract.ts"() {
    "use strict";
  }
});

// src/agent/computer/browser-host.ts
import path from "node:path";
function computerProfile(stateDir) {
  return path.join(stateDir, "computer", "chrome");
}
function computerHostFile(stateDir) {
  return path.join(stateDir, "computer", "host.json");
}
var init_browser_host = __esm({
  "src/agent/computer/browser-host.ts"() {
    "use strict";
  }
});

// src/agent/computer/browser.ts
var browser_exports = {};
__export(browser_exports, {
  adoptPage: () => adoptPage,
  allComputerPages: () => allComputerPages,
  closeComputerBrowser: () => closeComputerBrowser,
  closeComputerPage: () => closeComputerPage,
  computerPage: () => computerPage,
  frontComputerPage: () => frontComputerPage,
  hiddenDisplayCommand: () => hiddenDisplayCommand,
  openComputerPage: () => openComputerPage,
  releaseComputerBrowser: () => releaseComputerBrowser,
  throwawayComputerPage: () => throwawayComputerPage
});
import { accessSync, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path2 from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
async function connect(stateDir) {
  const file3 = path2.join(computerProfile(stateDir), "DevToolsActivePort");
  let port2;
  try {
    port2 = Number((await fs.readFile(file3, "utf8")).split("\n")[0]);
  } catch {
    return void 0;
  }
  if (!Number.isInteger(port2) || port2 < 1 || port2 > 65535) return void 0;
  try {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port2}`, { timeout: 3e3 });
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close();
      return void 0;
    }
    return { browser, context };
  } catch {
    return void 0;
  }
}
async function externalChromeRunning(stateDir) {
  try {
    const lock = await fs.readlink(path2.join(computerProfile(stateDir), "SingletonLock"));
    const pid = Number(lock.match(/-(\d+)$/)?.[1]);
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function startHost(stateDir) {
  const dir = path2.join(stateDir, "computer");
  await fs.mkdir(dir, { recursive: true, mode: 448 });
  const lock = path2.join(dir, "host-start.lock");
  let owned2 = false;
  try {
    const handle = await fs.open(lock, "wx", 384);
    await handle.close();
    owned2 = true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      if (Date.now() - (await fs.stat(lock)).mtimeMs > 3e4) {
        await fs.unlink(lock);
        return startHost(stateDir);
      }
    } catch {
    }
  }
  if (owned2) {
    try {
      const existing = await connect(stateDir);
      if (existing) return existing;
      if (await externalChromeRunning(stateDir)) throw new Error("ClikCode Chrome is open outside ClikCode. Finish that browser step, close its window, and retry.");
      const entry = process.env.CLIKCODE_BROWSER_HOST_ENTRY || process.argv[1];
      if (!entry) throw new Error("ClikCode could not start its browser host.");
      const hostArgs = [process.execPath, entry, "computer-host", stateDir];
      const [command, ...argv] = hiddenDisplayCommand(hostArgs);
      const child = spawn(command, argv, { detached: true, stdio: "ignore", windowsHide: true });
      let startupError;
      child.once("error", (error) => {
        startupError = error;
      });
      child.unref();
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await connect(stateDir);
        if (result) return result;
        if (startupError || child.exitCode !== null) break;
        await pause(200);
      }
      throw new Error("ClikCode could not start its browser. Check that Chrome or Edge is installed and the desktop is available.");
    } finally {
      await fs.unlink(lock).catch(() => void 0);
    }
  }
  for (let attempt = 0; attempt < 110; attempt++) {
    const result = await connect(stateDir);
    if (result) return result;
    await pause(200);
  }
  throw new Error("ClikCode Chrome could not start.");
}
async function browserFor(stateDir, start) {
  let opening = running.get(stateDir);
  if (!opening) {
    opening = (async () => {
      const current = await connect(stateDir);
      if (current) return current;
      if (!start) throw new Error("ClikCode browser is closed. Open a URL with computer_web first.");
      return startHost(stateDir);
    })();
    running.set(stateDir, opening);
    void opening.then(({ browser }) => {
      browser.on("disconnected", () => {
        if (running.get(stateDir) === opening) running.delete(stateDir);
      });
    }).catch(() => void 0);
    opening.catch(() => {
      if (running.get(stateDir) === opening) running.delete(stateDir);
    });
  }
  return opening;
}
function mine(stateDir, tab) {
  const key = ownerKey(stateDir, tab);
  const stack = (owned.get(key) ?? []).filter((page) => !page.isClosed());
  owned.set(key, stack);
  return stack.at(-1);
}
function adoptPage(stateDir, page, tab) {
  const key = ownerKey(stateDir, tab);
  owned.set(key, [...(owned.get(key) ?? []).filter((old) => old !== page), page]);
}
async function openComputerPage(stateDir, tab) {
  const { context } = await browserFor(stateDir, true);
  const existing = mine(stateDir, tab);
  if (existing) return existing;
  const page = await context.newPage();
  adoptPage(stateDir, page, tab);
  return page;
}
async function computerPage(stateDir, tab) {
  await browserFor(stateDir, false);
  const page = mine(stateDir, tab);
  if (!page) throw new Error("This chat has no open tab. Open a URL with computer_web first.");
  return page;
}
async function frontComputerPage(stateDir) {
  const { context } = await browserFor(stateDir, false);
  const open2 = context.pages().filter((page2) => !page2.isClosed());
  for (const page2 of open2.reverse()) {
    try {
      if (await page2.evaluate(() => globalThis.document.visibilityState === "visible")) return page2;
    } catch {
    }
  }
  const page = open2[0];
  if (!page) throw new Error("ClikCode browser has no open tab.");
  return page;
}
async function allComputerPages(stateDir) {
  const { context } = await browserFor(stateDir, false);
  return context.pages().filter((page) => !page.isClosed());
}
async function closeComputerPage(stateDir, tab) {
  const key = ownerKey(stateDir, tab);
  const pages = owned.get(key) ?? [];
  owned.delete(key);
  for (const page of pages) await page.close().catch(() => void 0);
}
async function releaseComputerBrowser(stateDir) {
  owned.delete(stateDir);
  const opening = running.get(stateDir);
  running.delete(stateDir);
  await (await opening?.catch(() => void 0))?.browser.close().catch(() => void 0);
}
async function closeComputerBrowser(stateDir) {
  owned.delete(stateDir);
  const opening = running.get(stateDir);
  running.delete(stateDir);
  const connected = await opening?.catch(() => void 0);
  await connected?.browser.close().catch(() => void 0);
  try {
    const record = JSON.parse(await fs.readFile(computerHostFile(stateDir), "utf8"));
    if (Number.isSafeInteger(record.pid) && record.pid > 1) process.kill(record.pid, "SIGTERM");
  } catch {
  }
}
async function throwawayComputerPage(stateDir) {
  const { context } = await browserFor(stateDir, true);
  return context.newPage();
}
function hiddenDisplayCommand(command, env = process.env, platform = process.platform, hasXvfb = () => whichSync("xvfb-run")) {
  if (platform !== "linux" || env.CLIKCODE_BROWSER_VISIBLE === "1" || !hasXvfb()) return command;
  return ["xvfb-run", "-a", "-s", "-screen 0 1440x900x24", ...command];
}
function whichSync(name) {
  return (process.env.PATH ?? "").split(path2.delimiter).some((dir) => {
    try {
      accessSync(path2.join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}
var running, owned, ownerKey;
var init_browser = __esm({
  "src/agent/computer/browser.ts"() {
    "use strict";
    init_browser_host();
    init_shared_state();
    running = sharedState("browser-running", () => /* @__PURE__ */ new Map());
    owned = sharedState("browser-owned", () => /* @__PURE__ */ new Map());
    ownerKey = (stateDir, tab) => tab ? `${stateDir}\0${tab}` : stateDir;
  }
});

// src/agent/computer/settings.ts
import fs2 from "node:fs/promises";
import path3 from "node:path";
function computerSettingsPath(stateDir) {
  return path3.join(stateDir, "computer", "settings.json");
}
async function computerEnabled(stateDir) {
  try {
    return JSON.parse(await fs2.readFile(computerSettingsPath(stateDir), "utf8")).enabled !== false;
  } catch {
    return true;
  }
}
async function generatedPasswordsAllowed(stateDir) {
  try {
    return JSON.parse(await fs2.readFile(computerSettingsPath(stateDir), "utf8")).generatePasswords !== false;
  } catch {
    return true;
  }
}
async function unattendedEnabled(stateDir) {
  try {
    return JSON.parse(await fs2.readFile(computerSettingsPath(stateDir), "utf8")).unattended === true;
  } catch {
    return false;
  }
}
var COMPUTER_OFF;
var init_settings = __esm({
  "src/agent/computer/settings.ts"() {
    "use strict";
    COMPUTER_OFF = "Computer use is off. Run `clikcode computer on` to enable it.";
  }
});

// src/agent/images.ts
function sniffImage(bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString("latin1");
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 2303741511 && bytes.readUInt32BE(4) === 218765834) {
    return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && ascii(0, 4) === "GIF8") return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  if (bytes.length >= 16 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    const chunk = ascii(12, 16);
    if (chunk === "VP8X" && bytes.length >= 30) return { mimeType: "image/webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8 " && bytes.length >= 30) return { mimeType: "image/webp", width: bytes.readUInt16LE(26) & 16383, height: bytes.readUInt16LE(28) & 16383 };
    if (chunk === "VP8L" && bytes.length >= 25) {
      const [b0, b1, b2, b3] = [bytes[21], bytes[22], bytes[23], bytes[24]];
      return { mimeType: "image/webp", width: 1 + ((b1 & 63) << 8 | b0), height: 1 + ((b3 & 15) << 10 | b2 << 2 | (b1 & 192) >> 6) };
    }
    return { mimeType: "image/webp" };
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    for (let offset = 2; offset + 9 <= bytes.length && bytes[offset] === 255; ) {
      const marker = bytes[offset + 1];
      if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
        return { mimeType: "image/jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
    return { mimeType: "image/jpeg" };
  }
  return void 0;
}
var MAX_IMAGE_BYTES, MAX_TOOL_IMAGE_BYTES;
var init_images = __esm({
  "src/agent/images.ts"() {
    "use strict";
    MAX_IMAGE_BYTES = 20 * 1024 * 1024;
    MAX_TOOL_IMAGE_BYTES = 3.75 * 1024 * 1024;
  }
});

// src/agent/computer/sensitive-fields.ts
async function sensitiveValues(page) {
  try {
    const values = await page.locator(SENSITIVE).evaluateAll((nodes) => nodes.map((node) => node.value ?? ""));
    return [...new Set(values.filter((value) => value.length >= MIN_LENGTH))];
  } catch {
    return [];
  }
}
function keyFieldValuesInPage() {
  const doc = globalThis.document;
  const NAMED = /(?:^|[^a-z])(?:api[ _-]?|access[ _-]?|auth[ _-]?|private[ _-]?|client[ _-]?|app[ _-]?)?(?:key|token|secret|credential)s?(?![a-z])/i;
  const SHAPED = (value) => {
    if (value.length < 12 || value.length > 600 || !/^[A-Za-z0-9_\-+/=.:~]+$/.test(value) || /^https?:|@/.test(value) || /^\d+$/.test(value)) return false;
    if (!/[A-Za-z]/.test(value) || !(/\d/.test(value) || value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value))) return false;
    return new Set(value).size >= 6;
  };
  const out = /* @__PURE__ */ new Set();
  for (const element of Array.from(doc.querySelectorAll("input, textarea"))) {
    const type = String(element["type"] ?? "text").toLowerCase();
    if (["password", "hidden", "checkbox", "radio", "submit", "button", "file", "range", "color", "image", "reset"].includes(type)) continue;
    const value = String(element["value"] ?? "").trim();
    if (value.length < 8 || /\s/.test(value) && value.length < 20) continue;
    const labels = Array.from(element["labels"] ?? []).map((label) => label.textContent ?? "").join(" ");
    const get = (name) => String(element["getAttribute"].call(element, name) ?? "");
    const before = (() => {
      let text = "";
      let node = element;
      for (let step = 0; step < 3 && !text.trim(); step++) {
        text = node.previousSibling?.textContent ?? "";
        if (!text.trim() && node.parentElement) node = node.parentElement;
      }
      return text.trim().slice(-60);
    })();
    const hint = [labels, get("aria-label"), get("placeholder"), get("name"), get("id"), get("title"), before].join(" ");
    if (SHAPED(value) || NAMED.test(hint)) out.add(value);
  }
  return [...out];
}
async function keyFieldValues(page) {
  try {
    return await page.evaluate(keyFieldValuesInPage);
  } catch {
    return [];
  }
}
async function maskSensitive(page, text) {
  let out = text;
  for (const value of [...await sensitiveValues(page), ...await keyFieldValues(page)].sort((a, b) => b.length - a.length)) out = out.split(value).join("[hidden]");
  return out;
}
var SENSITIVE, MIN_LENGTH;
var init_sensitive_fields = __esm({
  "src/agent/computer/sensitive-fields.ts"() {
    "use strict";
    init_browser();
    SENSITIVE = 'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], input[autocomplete^="cc-"]';
    MIN_LENGTH = 3;
  }
});

// src/agent/computer/credential-vault.ts
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs3 from "node:fs/promises";
import path4 from "node:path";
function vaultDir(stateDir) {
  return path4.join(stateDir, "computer", "vault");
}
function keyFile(stateDir) {
  return path4.join(vaultDir(stateDir), "vault.key");
}
function siteOrigin(url2) {
  try {
    const value = new URL(url2);
    if (value.protocol === "https:" && !value.username && !value.password) return value.origin;
  } catch {
  }
  throw new CredentialError("Private credentials require an HTTPS website.");
}
function siteKey(url2) {
  const { protocol, hostname, port: port2 } = new URL(siteOrigin(url2));
  return `${protocol}//${hostname.replace(REGION_LABEL, "").replace(WWW_LABEL, "")}${port2 ? `:${port2}` : ""}`;
}
function sameSite(a, b) {
  try {
    return siteKey(a) === siteKey(b);
  } catch {
    return false;
  }
}
function seal(key, aad, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([iv, cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64url");
}
function open(key, aad, packet) {
  try {
    const bytes = Buffer.from(packet, "base64url");
    if (bytes.length < 29) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialError("The saved login could not be decrypted.");
  }
}
function cache(stateDir, key) {
  lockCredentialVault(stateDir);
  sessions.set(stateDir, { key, expires: Date.now() + SESSION_MS });
}
function currentKey(stateDir) {
  const session = sessions.get(stateDir);
  if (!session) return void 0;
  if (session.expires <= Date.now()) {
    lockCredentialVault(stateDir);
    return void 0;
  }
  return session.key;
}
function lockCredentialVault(stateDir) {
  sessions.get(stateDir)?.key.fill(0);
  sessions.delete(stateDir);
}
async function vaultKey(stateDir, create) {
  const cached2 = currentKey(stateDir);
  if (cached2) return cached2;
  const dir = vaultDir(stateDir);
  if (create) {
    await fs3.mkdir(dir, { recursive: true, mode: 448 });
    const generated2 = randomBytes(32);
    try {
      await fs3.writeFile(keyFile(stateDir), generated2, { mode: 384, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw new CredentialError("The local login vault could not be opened.");
    } finally {
      generated2.fill(0);
    }
  }
  let key;
  try {
    const info = await fs3.lstat(keyFile(stateDir));
    if (!info.isFile() || process.platform !== "win32" && (info.mode & 63) !== 0) throw new Error();
    key = await fs3.readFile(keyFile(stateDir));
  } catch {
    throw new CredentialError("The local login vault key is missing or not private.");
  }
  if (key.length !== 32) throw new CredentialError("The local login vault key is invalid.");
  cache(stateDir, key);
  return key;
}
function itemFields(item) {
  return { ...item.fields };
}
async function savedLoginFields(stateDir, url2, id) {
  return itemFields(await readCredential(stateDir, url2, id));
}
async function saveLoginFields(stateDir, url2, fields, id) {
  const origin = siteOrigin(url2);
  if (!Object.keys(fields).length || Object.values(fields).some((value) => !value)) throw new CredentialError("Complete the visible login fields.");
  const key = await vaultKey(stateDir, true);
  const username = fields.username?.trim().toLowerCase();
  id ??= username ? (await readItems(stateDir)).find(({ item: item2 }) => sameSite(item2.origin, url2) && item2.fields?.username?.trim().toLowerCase() === username)?.id : void 0;
  const item = id ? await readCredential(stateDir, url2, id) : { origin };
  const itemId = id ?? randomUUID();
  const dir = path4.join(vaultDir(stateDir), "items");
  await fs3.mkdir(dir, { recursive: true, mode: 448 });
  const { rejected: _worked, ...kept } = item;
  await fs3.writeFile(path4.join(dir, `${itemId}.json`), seal(key, `item:${itemId}`, JSON.stringify({ ...kept, fields: { ...item.fields, ...fields } })), { mode: 384, flag: id ? "w" : "wx" });
  return itemId;
}
async function setLoginRejected(stateDir, url2, id, rejected) {
  const key = await vaultKey(stateDir, false);
  const { rejected: _was, ...item } = await readCredential(stateDir, url2, id);
  await fs3.writeFile(path4.join(vaultDir(stateDir), "items", `${id}.json`), seal(key, `item:${id}`, JSON.stringify(rejected ? { ...item, rejected: true } : item)), { mode: 384 });
}
async function readCredential(stateDir, url2, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new CredentialError("Invalid saved login reference.");
  const key = await vaultKey(stateDir, false);
  let item;
  try {
    item = JSON.parse(open(key, `item:${id}`, await fs3.readFile(path4.join(vaultDir(stateDir), "items", `${id}.json`), "utf8")));
  } catch {
    throw new CredentialError("That saved login could not be opened.");
  }
  if (!sameSite(item.origin, url2)) throw new CredentialError("That saved login does not match this website.");
  return item;
}
function loginLabel(fields) {
  const order = ["accountId", "email", "username"];
  const keys = [...order.filter((key) => fields[key]), ...Object.keys(fields).filter((key) => !order.includes(key) && !/password/i.test(key) && fields[key])];
  const values = [...new Set(keys.map((key) => fields[key]))];
  return values.join(" \xB7 ") || "Saved login";
}
async function readItems(stateDir) {
  const dir = path4.join(vaultDir(stateDir), "items");
  let files;
  try {
    files = await fs3.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new CredentialError("Saved logins could not be read.");
  }
  if (files.length === 0) return [];
  const key = await vaultKey(stateDir, false);
  const items = [];
  for (const file3 of files) {
    const id = file3.replace(/\.json$/, "");
    if (!/^[0-9a-f-]{36}$/i.test(id) || file3 !== `${id}.json`) continue;
    try {
      items.push({ id, item: JSON.parse(open(key, `item:${id}`, await fs3.readFile(path4.join(dir, file3), "utf8"))) });
    } catch {
      throw new CredentialError("A saved login could not be opened.");
    }
  }
  return items;
}
async function savedLoginsForSite(stateDir, url2) {
  siteOrigin(url2);
  return (await readItems(stateDir)).filter(({ item }) => sameSite(item.origin, url2)).map(({ id, item }) => ({ id, label: loginLabel(itemFields(item)), rejected: item.rejected === true })).sort(byLabel);
}
function siteUrl(site) {
  const value = site.trim();
  if (!value) throw new CredentialError("Name the site whose saved login to remove.");
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}
async function forgetSavedLogins(stateDir, site, label) {
  const url2 = siteUrl(site);
  siteOrigin(url2);
  const wanted = label?.trim().toLowerCase();
  let removed = 0;
  for (const login of await savedLoginsForSite(stateDir, url2)) {
    if (wanted && login.label.toLowerCase() !== wanted && !login.label.toLowerCase().split(" \xB7 ").includes(wanted)) continue;
    if (await removeSavedLogin(stateDir, login.id)) removed++;
  }
  return removed;
}
async function removeSavedLogin(stateDir, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new CredentialError("Invalid saved login reference.");
  try {
    await fs3.unlink(path4.join(vaultDir(stateDir), "items", `${id}.json`));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new CredentialError("The saved login could not be removed.");
  }
}
function secretFile(stateDir, name) {
  if (!SECRET_NAME.test(name)) throw new CredentialError("A secret name uses letters, digits, dot, dash, underscore or slash, up to 64 characters.");
  const hash = createHash("sha256").update(name.toLowerCase()).digest("hex").slice(0, 32);
  return { file: path4.join(vaultDir(stateDir), "secrets", `${hash}.json`), aad: `secret:${hash}` };
}
async function saveNamedSecret(stateDir, name, value, meta = {}) {
  if (!value) throw new CredentialError("The secret is empty.");
  const { file: file3, aad } = secretFile(stateDir, name);
  const key = await vaultKey(stateDir, true);
  let before = {};
  try {
    before = JSON.parse(open(key, aad, await fs3.readFile(file3, "utf8")));
  } catch {
  }
  if (before.value !== void 0 && !before.meta) {
    const made = await fs3.stat(file3).then((info) => info.mtime.toISOString(), () => void 0);
    if (made) before.meta = { createdAt: made };
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const kept = (field) => {
    const v = meta[field]?.trim() || before.meta?.[field];
    return v ? { [field]: v } : {};
  };
  const saved = { ...kept("vendor"), ...kept("owner"), ...kept("env"), createdAt: before.meta?.createdAt ?? now, ...before.value !== void 0 && before.value !== value ? { rotatedAt: now } : before.meta?.rotatedAt ? { rotatedAt: before.meta.rotatedAt } : {} };
  await fs3.mkdir(path4.dirname(file3), { recursive: true, mode: 448 });
  await fs3.writeFile(file3, seal(key, aad, JSON.stringify({ name, value, meta: saved })), { mode: 384 });
}
async function readNamedSecret(stateDir, name) {
  const { file: file3, aad } = secretFile(stateDir, name);
  const key = await vaultKey(stateDir, false);
  try {
    return JSON.parse(open(key, aad, await fs3.readFile(file3, "utf8"))).value;
  } catch {
    throw new CredentialError(`No secret named "${name}" is saved.`);
  }
}
async function namedSecretNames(stateDir) {
  const dir = path4.join(vaultDir(stateDir), "secrets");
  let files;
  try {
    files = await fs3.readdir(dir);
  } catch {
    return [];
  }
  const key = await vaultKey(stateDir, false);
  const names = [];
  for (const file3 of files) {
    try {
      names.push(JSON.parse(open(key, `secret:${file3.replace(/\.json$/, "")}`, await fs3.readFile(path4.join(dir, file3), "utf8"))).name);
    } catch {
    }
  }
  return names.sort();
}
async function deleteNamedSecret(stateDir, name) {
  const { file: file3 } = secretFile(stateDir, name);
  try {
    await fs3.unlink(file3);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new CredentialError("The secret could not be removed.");
  }
}
async function writeVaultRecord(stateDir, folder, id, value) {
  if (!RECORD_FOLDER.test(folder) || !/^[0-9a-f-]{36}$/i.test(id)) throw new CredentialError("Invalid vault record.");
  const key = await vaultKey(stateDir, true);
  const dir = path4.join(vaultDir(stateDir), folder);
  await fs3.mkdir(dir, { recursive: true, mode: 448 });
  await fs3.writeFile(path4.join(dir, `${id}.json`), seal(key, `${folder}:${id}`, JSON.stringify(value)), { mode: 384 });
}
async function readVaultRecords(stateDir, folder) {
  if (!RECORD_FOLDER.test(folder)) throw new CredentialError("Invalid vault record.");
  const dir = path4.join(vaultDir(stateDir), folder);
  let files;
  try {
    files = await fs3.readdir(dir);
  } catch {
    return [];
  }
  if (!files.length) return [];
  const key = await vaultKey(stateDir, false);
  const out = [];
  for (const file3 of files) {
    const id = file3.replace(/\.json$/, "");
    if (!/^[0-9a-f-]{36}$/i.test(id) || file3 !== `${id}.json`) continue;
    try {
      out.push({ id, value: JSON.parse(open(key, `${folder}:${id}`, await fs3.readFile(path4.join(dir, file3), "utf8"))) });
    } catch {
    }
  }
  return out;
}
async function removeVaultRecord(stateDir, folder, id) {
  if (!RECORD_FOLDER.test(folder) || !/^[0-9a-f-]{36}$/i.test(id)) throw new CredentialError("Invalid vault record.");
  try {
    await fs3.unlink(path4.join(vaultDir(stateDir), folder, `${id}.json`));
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new CredentialError("The record could not be removed.");
  }
}
var SESSION_MS, sessions, CredentialError, REGION_LABEL, WWW_LABEL, byLabel, SECRET_NAME, RECORD_FOLDER;
var init_credential_vault = __esm({
  "src/agent/computer/credential-vault.ts"() {
    "use strict";
    SESSION_MS = 10 * 6e4;
    sessions = /* @__PURE__ */ new Map();
    CredentialError = class extends Error {
    };
    REGION_LABEL = /^[a-z]{2}(?:-[a-z]+)+-\d+\./;
    WWW_LABEL = /^www\./;
    byLabel = (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
    SECRET_NAME = /^[a-z0-9][a-z0-9._/-]{0,63}$/i;
    RECORD_FOLDER = /^[a-z][a-z-]{1,30}$/;
  }
});

// src/agent/computer/run-cli.ts
import { spawn as spawn2 } from "node:child_process";
function runCli(command, argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn2(command, argv, { stdio: [options.stdin === void 0 ? "ignore" : "pipe", "pipe", "pipe"], windowsHide: true });
    let text = "";
    const keep = options.maxChars ?? 2e5;
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 9e4);
    const stop = () => {
      child.kill();
    };
    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => {
      text = (text + String(chunk)).slice(-keep);
    });
    child.stderr.on("data", (chunk) => {
      text = (text + String(chunk)).slice(-keep);
    });
    if (options.stdin !== void 0) {
      child.stdin.on("error", () => void 0);
      child.stdin.end(options.stdin);
    }
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, text: "", missing: error.code === "ENOENT" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({ code, text, missing: false });
    });
  });
}
var init_run_cli = __esm({
  "src/agent/computer/run-cli.ts"() {
    "use strict";
  }
});

// src/agent/computer/cli-stdin-support.ts
import fs4 from "node:fs";
import path5 from "node:path";
function parseCliVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : void 0;
}
function versionAtLeast(text, min = STDIN_ARGS_JSON_MIN_VERSION) {
  const have = parseCliVersion(text);
  const need = parseCliVersion(min);
  if (!have) return false;
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}
function resolveOnPath(command) {
  for (const entry of (process.env.PATH ?? "").split(path5.delimiter)) {
    if (!entry) continue;
    const candidate = path5.join(entry, command);
    try {
      fs4.accessSync(candidate, fs4.constants.X_OK);
      if (fs4.statSync(candidate).isFile()) return candidate;
    } catch {
    }
  }
  return void 0;
}
async function cliReadsArgsJsonFromStdin(command, signal) {
  const found = resolveOnPath(command);
  if (!found) return false;
  let key = found;
  try {
    key = `${found}:${fs4.statSync(found).mtimeMs}`;
  } catch {
  }
  const known = cache2.get(key);
  if (known !== void 0) return known;
  const result = await runCli(command, ["--version"], { signal, timeoutMs: 15e3, maxChars: 2e3 });
  const supported = !result.missing && result.code === 0 && versionAtLeast(result.text);
  cache2.set(key, supported);
  return supported;
}
var STDIN_ARGS_JSON_MIN_VERSION, cache2;
var init_cli_stdin_support = __esm({
  "src/agent/computer/cli-stdin-support.ts"() {
    "use strict";
    init_run_cli();
    STDIN_ARGS_JSON_MIN_VERSION = "1.0.35";
    cache2 = /* @__PURE__ */ new Map();
  }
});

// src/agent/computer/secret-destinations.ts
import fs5 from "node:fs/promises";
import path6 from "node:path";
function normalizeSendTo(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && /^\s*[[{]/.test(value)) {
    try {
      return normalizeSendTo(JSON.parse(value));
    } catch {
      return void 0;
    }
  }
  if (typeof value === "string" && value) return [{ to: value }];
  if (value && typeof value === "object") return [value];
  return void 0;
}
function readConnectionValues(raw) {
  if (raw === void 0 || raw === null || raw === "") return {};
  let map = raw;
  if (typeof map === "string") {
    try {
      map = JSON.parse(map);
    } catch {
      return { problem: 'connectionValues must be a map such as {"app_id":"WJUQDEJ3SG"}.' };
    }
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return { problem: 'connectionValues must be a map such as {"app_id":"WJUQDEJ3SG"}.' };
  const values = {};
  for (const [name, value] of Object.entries(map)) {
    if (!VALUE_NAME.test(name)) return { problem: `connectionValues has a name "${name.slice(0, 41)}" that is not a plain identifier.` };
    if (typeof value !== "string" || !VALUE_TEXT.test(value)) return { problem: `connectionValues.${name} must be letters, digits, dot, dash or underscore (no spaces or slashes).` };
    values[name] = value;
  }
  return { values };
}
async function loadDestinations(stateDir) {
  let own = {};
  try {
    own = JSON.parse(await fs5.readFile(destinationsFile(stateDir), "utf8"));
  } catch {
  }
  const merged = { ...DEFAULT_DESTINATIONS, ...own };
  for (const [name, template] of Object.entries(merged)) {
    if (template.verify || !template.run.includes("connect_connector") || !slotsOf(template).includes("integration")) continue;
    merged[name] = { ...template, verify: "connection" };
  }
  return merged;
}
function slotsOf(template) {
  const text = [...template.run, template.stdin ?? ""].join("\n");
  return [...new Set([...text.matchAll(SLOT)].map((match) => match[1]))].filter((slot) => slot !== "secret");
}
async function destinationProblem(stateDir, list) {
  const all = await loadDestinations(stateDir);
  for (const [index, item] of list.entries()) {
    const at = `send_to[${index}]`;
    const d = item;
    if (!d || typeof d !== "object" || typeof d.to !== "string") return `${at} needs {to: "<destination>", with: {...}}. ${EXAMPLE}`;
    const template = all[d.to];
    if (!template) return `${at}: no destination named "${d.to}". Known: ${describeKnown(all)}. The user adds more with \`clikcode computer destination add\`. ${EXAMPLE}`;
    if (d.connectionValues !== void 0) {
      if (!takesConnectionValues(template)) return `${at}: connectionValues only goes with clikdeploy-connection or clikdeploy-connection-basic, not "${d.to}".`;
      const read = readConnectionValues(d.connectionValues);
      if (read.problem) return `${at}: ${read.problem}`;
    }
    const saved = template.vaultSlots?.length ? await namedSecretNames(stateDir).catch(() => []) : [];
    for (const slot of slotsOf(template)) {
      const value = d.with?.[slot];
      const ref = typeof value === "string" && template.vaultSlots?.includes(slot) ? VAULT_REF.exec(value) : null;
      if (ref) {
        if (!saved.includes(ref[1])) return `${at}: with.${slot} names a saved secret "${ref[1]}" that is not in the Secrets Manager.`;
        continue;
      }
      if (typeof value !== "string" || !SAFE_VALUE.test(value)) return `${at}: "${d.to}" needs with.${slot} (letters, digits, dot, dash, underscore, slash; not starting with a dash). ${EXAMPLE}`;
    }
  }
  return void 0;
}
function fill(text, params, secret) {
  return text.replace(SLOT, (_all, slot, json) => slot === "secret" ? json ? JSON.stringify(secret).slice(1, -1) : secret : params[slot] ?? "");
}
function firstJsonObject(text) {
  for (let at = text.indexOf("{"); at >= 0; at = text.indexOf("{", at + 1)) {
    if (at > 0 && text[at - 1] !== "\n") continue;
    try {
      const value = JSON.parse(text.slice(at));
      if (value && typeof value === "object") return value;
    } catch {
    }
    const end = text.lastIndexOf("}");
    if (end > at) {
      try {
        const value = JSON.parse(text.slice(at, end + 1));
        if (value && typeof value === "object") return value;
      } catch {
      }
    }
  }
  return void 0;
}
async function connectionState(integration, signal) {
  const shown = await runCli("clikdeploy", ["integrations", "show", integration], { signal, timeoutMs: 6e4, maxChars: 4e6 });
  if (shown.missing) return { connected: false, reason: "the clikdeploy command is not installed on this computer" };
  const parsed = firstJsonObject(shown.text);
  if (!parsed) return { connected: false, reason: `could not read the connection back (${say(shown.text) || "no answer"})` };
  if (parsed.status === "error") return { connected: false, reason: `could not read the connection back (${(parsed.message ?? "error").split("\n")[0]})` };
  const statuses = [parsed.data?.connection?.status, ...(parsed.data?.accounts ?? []).map((account) => account.status)].filter(Boolean);
  if (statuses.includes("active")) return { connected: true };
  return { connected: false, reason: statuses.length ? `${integration} shows a connection with status "${statuses[0]}", not active` : `ClikDeploy shows no connection for ${integration}` };
}
async function sendToDestinations(stateDir, list, value, signal) {
  const all = await loadDestinations(stateDir);
  const out = [];
  for (const d of list) {
    const template = all[d.to];
    const given = d.with ?? {};
    const label = `${d.to}${Object.keys(given).length ? ` (${Object.values(given).join(", ")})` : ""}`;
    const params = {};
    let unreadable;
    for (const [slot, raw] of Object.entries(given)) {
      const ref = template.vaultSlots?.includes(slot) ? VAULT_REF.exec(raw) : null;
      if (!ref) {
        params[slot] = raw;
        continue;
      }
      const stored2 = (await readNamedSecret(stateDir, ref[1]).catch(() => "")).trim();
      if (!stored2 || !SAFE_VALUE.test(stored2)) {
        unreadable = `The saved secret "${ref[1]}" is missing or is not a plain id, so ${slot} could not be filled.`;
        break;
      }
      params[slot] = stored2;
    }
    if (unreadable) {
      out.push({ label, ok: false, message: unreadable });
      continue;
    }
    const [program, ...args] = template.run.map((part) => fill(part, params, value));
    let stdin = template.stdin !== void 0 ? fill(template.stdin, params, value) : void 0;
    const extra = takesConnectionValues(template) ? readConnectionValues(d.connectionValues) : {};
    if (extra.problem) {
      out.push({ label, ok: false, message: `NOT connected: ${extra.problem}` });
      continue;
    }
    if (stdin !== void 0 && extra.values && Object.keys(extra.values).length) stdin = JSON.stringify({ ...JSON.parse(stdin), baseUrlVariables: extra.values });
    const dash = args.indexOf("--args-json");
    if (stdin !== void 0 && dash >= 0 && args[dash + 1] === "-" && !await cliReadsArgsJsonFromStdin(program, signal)) {
      args[dash + 1] = stdin;
      stdin = void 0;
    }
    const result = await runCli(program, args, { ...stdin !== void 0 ? { stdin } : {}, signal, timeoutMs: 9e4 });
    if (result.missing) {
      out.push({ label, ok: false, message: `The ${program} command is not installed on this computer.` });
      continue;
    }
    if (template.verify === "connection" && params.integration) {
      const said = scrubSecrets(say(result.text)).replace(/\s+/g, " ").slice(0, 160);
      const state = await connectionState(params.integration, signal);
      const failed = result.code !== 0 || /"status"\s*:\s*"error"/.test(result.text) || /"success"\s*:\s*false/.test(result.text);
      const reason = failed ? said || `the connect command failed (exit ${result.code})` : state.reason ? `${state.reason}${said ? `; the command said: ${said}` : ""}` : "";
      out.push(state.connected && !failed ? { label, ok: true, message: "connected" } : { label, ok: false, message: `NOT connected: ${scrubSecrets(reason || "no active connection found after connecting")}` });
      continue;
    }
    const ok = result.code === 0;
    out.push({ label, ok, message: scrubSecrets(say(result.text)).trim() || (ok ? "delivered (the command succeeded and printed nothing)" : `failed (exit ${result.code ?? "none"}, the command printed nothing)`) });
  }
  return out.map((delivery) => delivery.message.trim() ? delivery : { ...delivery, message: delivery.ok ? "delivered" : "NOT delivered: no reason was given" });
}
var JSON_ARGS, DEFAULT_DESTINATIONS, EXAMPLE, SAFE_VALUE, VAULT_REF, VALUE_NAME, VALUE_TEXT, takesConnectionValues, SLOT, destinationsFile, describeKnown, say;
var init_secret_destinations = __esm({
  "src/agent/computer/secret-destinations.ts"() {
    "use strict";
    init_run_cli();
    init_cli_stdin_support();
    init_credential_vault();
    init_secret_scrubber();
    JSON_ARGS = (fields) => `{${fields}}`;
    DEFAULT_DESTINATIONS = {
      "clikdeploy-secret": {
        about: "a ClikDeploy platform secret (key)",
        run: ["clikdeploy", "tools", "run", "admin_platform_set_secret", "--args-json", "-", "--confirm"],
        stdin: JSON_ARGS('"key":"{{key}}","value":"{{secret|json}}"')
      },
      "clikdeploy-app-secret": {
        about: "a ClikDeploy app secret (app, key)",
        run: ["clikdeploy", "tools", "run", "set_secret", "--args-json", "-", "--confirm"],
        stdin: JSON_ARGS('"appId":"{{app}}","key":"{{key}}","value":"{{secret|json}}"')
      },
      "clikdeploy-compute": {
        about: "one field of a ClikDeploy compute provider card (provider, field)",
        run: ["clikdeploy", "tools", "run", "admin_compute_save_credentials", "--args-json", "-", "--confirm"],
        stdin: JSON_ARGS('"provider":"{{provider}}","credentials":{"{{field}}":"{{secret|json}}"}')
      },
      // The secret is the OAuth client secret; the client id is not one and is a slot. Adding needs only the admin's
      // API key (the CLI's own sign-in): no code and no password, as long as the connector has no client stored.
      "clikdeploy-connector": {
        about: "a ClikDeploy connector's OAuth app (integration, client_id); the key is its client secret; client_id may be secret:<saved name>",
        vaultSlots: ["client_id"],
        run: ["clikdeploy", "tools", "run", "admin_platform_save_connector_credentials", "--args-json", "-", "--confirm"],
        stdin: JSON_ARGS('"integrationId":"{{integration}}","clientId":"{{client_id}}","clientSecret":"{{secret|json}}"')
      },
      "clikdeploy-connection": {
        about: "connect an API key to a ClikDeploy connector (integration) for the signed-in account; the result is `connected` or `NOT connected: <reason>`, read back from ClikDeploy",
        verify: "connection",
        run: ["clikdeploy", "tools", "run", "connect_connector", "--args-json", "-", "--confirm"],
        stdin: JSON_ARGS('"integrationId":"{{integration}}","apiKey":"{{secret|json}}"')
      },
      // Some vendors expose a token id as the basic-auth username. It can be read from the vault at send time.
      "clikdeploy-connection-basic": {
        about: "connect a username and password to a ClikDeploy connector (integration, username; username may be secret:<saved name>); the result is `connected` or `NOT connected: <reason>`",
        vaultSlots: ["username"],
        verify: "connection",
        run: ["clikdeploy", "tools", "run", "connect_connector", "--args-json", "-", "--confirm"],
        stdin: JSON_ARGS('"integrationId":"{{integration}}","username":"{{username}}","password":"{{secret|json}}"')
      },
      "github-secret": { about: "a GitHub repository secret (repo, key)", run: ["gh", "secret", "set", "{{key}}", "--repo", "{{repo}}"], stdin: "{{secret}}" }
    };
    EXAMPLE = 'Example: {"to":"clikdeploy-secret","with":{"key":"SALAD_API_KEY"}}';
    SAFE_VALUE = /^[A-Za-z0-9_][\w.@:/ -]{0,119}$/;
    VAULT_REF = /^secret:([A-Za-z0-9][\w./-]{0,80})$/;
    VALUE_NAME = /^[A-Za-z_][\w-]{0,40}$/;
    VALUE_TEXT = /^[A-Za-z0-9][\w.-]{0,119}$/;
    takesConnectionValues = (template) => template.verify === "connection";
    SLOT = /\{\{([a-z][a-z0-9_]*)(\|json)?\}\}/g;
    destinationsFile = (stateDir) => path6.join(stateDir, "computer", "destinations.json");
    describeKnown = (all) => Object.entries(all).map(([name, template]) => `${name}${slotsOf(template).length ? `(${slotsOf(template).join(", ")})` : ""}${template.about ? ` - ${template.about}` : ""}`).join("; ");
    say = (text) => {
      const start = text.indexOf("{");
      if (start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start));
          const failure = typeof parsed.error === "object" ? parsed.error.message ?? parsed.error.code : parsed.error;
          const inner = typeof parsed.data?.error === "object" ? parsed.data.error.message : parsed.data?.error;
          const line = [parsed.message ?? failure ?? parsed.data?.message ?? inner, parsed.data?.appliedToWebProcess !== void 0 ? `appliedToWebProcess=${parsed.data.appliedToWebProcess}` : "", parsed.data?.reloadReason].filter(Boolean).join(" \xB7 ");
          return line;
        } catch {
        }
      }
      return text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    };
  }
});

// src/agent/tools/store-secret.ts
var DESTINATION, SEND_TO_SCHEMA, SEND_TO_HELP, storeSecretTool;
var init_store_secret = __esm({
  "src/agent/tools/store-secret.ts"() {
    "use strict";
    init_tool_contract();
    init_credential_vault();
    init_secret_destinations();
    init_secret_scrubber();
    DESTINATION = { type: "object", additionalProperties: false, required: ["to"], properties: { to: { type: "string" }, with: { type: "object" }, connectionValues: { type: ["object", "string"], additionalProperties: { type: "string" }, description: `clikdeploy-connection and clikdeploy-connection-basic only: the per-account values a connector's base URL needs, e.g. {"app_id":"WJUQDEJ3SG"} (Algolia), {"cluster":"..."} (Weaviate), {"projectId":"..."} (Sanity). Not secrets.` } } };
    SEND_TO_SCHEMA = { type: ["array", "object", "string"], items: DESTINATION, additionalProperties: false, properties: DESTINATION.properties };
    SEND_TO_HELP = `Where the key goes, decided now: {to, with} or a list of them, e.g. {to:"clikdeploy-secret", with:{key:"SALAD_API_KEY"}}. Destinations: clikdeploy-secret (key) sets a ClikDeploy platform secret; clikdeploy-app-secret (app, key); clikdeploy-compute (provider, field) fills one field of a compute provider card, e.g. {to:"clikdeploy-compute", with:{provider:"GCP", field:"serviceAccountJson"}}; clikdeploy-connector (integration, client_id) registers a connector's OAuth app: the key is its client secret, the client id (not a secret, but it looks like one) is the slot: pass it as "secret:<the name you saved it under>" and it is read from the vault without being shown, e.g. {to:"clikdeploy-connector", with:{integration:"googlesheets", client_id:"1234-abc.apps.googleusercontent.com"}}; clikdeploy-connection (integration) and clikdeploy-connection-basic (integration, username) connect the key to a connector, and take an optional connectionValues map for a connector whose base URL has a per-account value, e.g. {to:"clikdeploy-connection", with:{integration:"algolia"}, connectionValues:{app_id:"WJUQDEJ3SG"}}; github-secret (repo, key). The user may have added others (an unknown name is answered with the full list).`;
    storeSecretTool = defineTool({
      name: "store_secret",
      class: "exec",
      description: "Send a secret saved in ClikCode Secrets Manager on to other places without seeing it. Normally capture_secret does this in one step with the same send_to; use this to send again. " + SEND_TO_HELP,
      parameters: { type: "object", additionalProperties: false, required: ["secret"], properties: {
        secret: { type: "string", description: "Name the key was saved under." },
        to: { type: "string", description: "The destination name, e.g. clikdeploy-secret." },
        with: { type: ["object", "string"], description: `Values for the destination's slots, e.g. {key:"SALAD_API_KEY"}.` },
        send_to: { ...SEND_TO_SCHEMA, description: "Several destinations at once: a list of {to, with}. For one, use to and with." }
      } },
      label: (args) => `Send ${args.secret}`,
      async run(args, ctx) {
        try {
          const withSlots = typeof args.with === "string" ? (() => {
            try {
              return JSON.parse(args.with);
            } catch {
              return void 0;
            }
          })() : args.with;
          const plan = normalizeSendTo(args.send_to ?? (args.to ? { to: args.to, ...withSlots ? { with: withSlots } : {} } : void 0));
          if (!plan?.length) throw new Error('Say where it goes: to and with, e.g. {"to":"clikdeploy-secret","with":{"key":"SALAD_API_KEY"}}.');
          const problem = await destinationProblem(ctx.stateDir, plan);
          if (problem) throw new Error(problem);
          const value = await readNamedSecret(ctx.stateDir, args.secret);
          registerSecret(value);
          const sent = await sendToDestinations(ctx.stateDir, plan, value, ctx.signal);
          const output = sent.map((delivery) => `${delivery.ok ? "SENT" : "NOT SENT"} - ${delivery.label}: ${delivery.message}`).join("\n");
          return { output: scrubSecrets(output), ...sent.every((delivery) => delivery.ok) ? {} : { isError: true } };
        } catch (error) {
          return { output: scrubSecrets(error instanceof Error ? error.message : String(error)), isError: true };
        }
      }
    });
  }
});

// src/agent/computer/login-fill.ts
function loginValueFor(saved, field) {
  if (field.password) return /new-password/.test(field.hint.autocomplete) ? void 0 : saved.password;
  if (/one-time|verification|\bcode\b|\botp\b/i.test(`${field.hint.autocomplete} ${field.hint.text}`)) return void 0;
  if (field.hint.type === "email" || /username|email/.test(field.hint.autocomplete) || ACCOUNT.test(field.hint.text)) return saved.username ?? saved.email;
  return void 0;
}
var ACCOUNT;
var init_login_fill = __esm({
  "src/agent/computer/login-fill.ts"() {
    "use strict";
    ACCOUNT = /user.?name|\blogin\b|e-?mail|identifier|account|sign.?in/i;
  }
});

// src/agent/computer/secret-finder.ts
function labelledValues(text) {
  const found = /* @__PURE__ */ new Set();
  for (const match of text.matchAll(LABEL_THEN_VALUE)) found.add(match[1].replace(/[.,;:)]+$/, ""));
  return found;
}
function entropy(text) {
  const counts = /* @__PURE__ */ new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
function keyShaped(value) {
  if (value.length < 16 || value.length > 512 || value.length > 130 && !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value) || !/^[A-Za-z0-9_\-+/=.:~]+$/.test(value)) return false;
  if (/^https?:|@/.test(value) || /^\d+$/.test(value)) return false;
  if (!/\d/.test(value) && !PREFIXED.test(value) && !(value.length >= 32 && mixedCase(value))) return false;
  if (/^[a-z][a-z-]*\/[\w-]+$/.test(value)) return false;
  return entropy(value) >= 3;
}
function walk(node, key, out, depth = 0) {
  if (depth > 6 || out.length > 200) return;
  if (typeof node === "string") {
    if (keyShaped(node)) out.push({ value: node, ...key ? { keyName: key } : {} });
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node.slice(0, 50)) walk(item, key, out, depth + 1);
    return;
  }
  if (node && typeof node === "object") for (const [name, child] of Object.entries(node).slice(0, 100)) walk(child, name, out, depth + 1);
}
function decide(input) {
  const scored = /* @__PURE__ */ new Map();
  const responseFor = /* @__PURE__ */ new Map();
  for (const found of input.responses) responseFor.set(found.value, found);
  const candidates = /* @__PURE__ */ new Set([...input.after.filter((value) => !input.before.has(value) && keyShaped(value)), ...responseFor.keys()]);
  for (const value of candidates) {
    const onPage = input.after.includes(value) && !input.before.has(value);
    const response = responseFor.get(value);
    const strong = !!response?.keyName && STRONG_KEY.test(response.keyName);
    if (!onPage && !strong) continue;
    if (input.existing && !strong && !input.labelled?.has(value) && !PREFIXED.test(value)) continue;
    scored.set(value, (onPage ? 3 : 0) + (response ? 2 : 0) + (strong ? 2 : 0) + (PREFIXED.test(value) ? 2 : 0) + (input.labelled?.has(value) ? 2 : 0) + (mixedCase(value) ? 1 : 0) + (value.length >= 24 ? 1 : 0) + (input.hint ? 1 : 0));
  }
  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  if (!top || top[1] < 5) return { kind: "none" };
  if (next && next[1] > top[1] - 2) return { kind: "ambiguous" };
  return { kind: "found", value: top[0] };
}
function pageTokens() {
  const doc = globalThis.document;
  const tokens = /* @__PURE__ */ new Set();
  for (const word of doc.body.innerText.split(/\s+/)) tokens.add(word.replace(/^[("'`]+|[)"'`,.;]+$/g, ""));
  for (const element of Array.from(doc.querySelectorAll("input, textarea"))) if (element.value) tokens.add(element.value);
  for (const element of Array.from(doc.querySelectorAll("[data-clipboard-text], [data-copy], [data-value], [data-key], [data-secret]"))) {
    for (const name of ["data-clipboard-text", "data-copy", "data-value", "data-key", "data-secret"]) {
      const attribute = element.getAttribute(name);
      if (attribute) tokens.add(attribute);
    }
  }
  return { tokens: [...tokens].filter((token) => token.length >= 16 && token.length <= 512), hint: false, labelled: /* @__PURE__ */ new Set() };
}
async function snapshot(page) {
  try {
    const taken = await page.evaluate(pageTokens);
    const text = await page.evaluate(() => globalThis.document.body.innerText);
    return { tokens: taken.tokens, hint: WORTH_SAVING_HINT.test(text), labelled: labelledValues(text) };
  } catch {
    return { tokens: [], hint: false, labelled: /* @__PURE__ */ new Set() };
  }
}
async function armFinder(page, existing = false) {
  const before = existing ? /* @__PURE__ */ new Set() : new Set((await snapshot(page)).tokens);
  const responses = [];
  const listen = async (response) => {
    try {
      const type = response.request().resourceType();
      if (type !== "fetch" && type !== "xhr" || !/json/i.test(response.headers()["content-type"] ?? "")) return;
      const body = await response.text();
      if (body.length > 5e5) return;
      walk(JSON.parse(body), void 0, responses);
    } catch {
    }
  };
  page.on("response", listen);
  return {
    async look() {
      const now = await snapshot(page);
      return decide({ before, after: now.tokens, responses, hint: now.hint, labelled: now.labelled, existing });
    },
    dispose() {
      page.off("response", listen);
    }
  };
}
function hideKeyLikeText(text) {
  const labelled = labelledValues(text);
  const copyHint = WORTH_SAVING_HINT.test(text);
  let hidden = 0;
  text = text.replace(SECRET_UUID, (match, label) => {
    hidden++;
    return typeof label === "string" ? `${label}[secret hidden]` : "[secret hidden]";
  });
  const longNumber = (bare) => /^\d{24,}$/.test(bare);
  const randomLooking = (bare) => keyShaped(bare) && (mixedCase(bare) || PREFIXED.test(bare) || bare.length >= 32 && /^[0-9a-f]+$/i.test(bare));
  const lines = text.split("\n").map((line) => {
    const isUrl = /^\s*- \/url:/.test(line);
    return line.replace(/[A-Za-z0-9_\-+/=.:~]{24,}/g, (token) => {
      const bare = token.replace(/[.,;:)]+$/, "");
      if (longNumber(bare)) {
        if (isUrl) return token;
        hidden++;
        return "[secret hidden]";
      }
      if (!keyShaped(bare)) return token;
      const marked = mixedCase(bare) && labelled.has(bare) || copyHint && bare.length >= 32;
      if (isUrl ? !marked : !(marked || randomLooking(bare))) return token;
      hidden++;
      return "[secret hidden]";
    });
  });
  const NAMED = /\b(?:secret|token|api[ _-]?key|app[ _-]?key|client[ _-]?secret|password|credential)s?\b/i;
  const guarded = lines.map((line, index) => {
    if (!NAMED.test(line) && !(index > 0 && NAMED.test(lines[index - 1]))) return line;
    return line.replace(/(?<![\w-])[A-Za-z0-9_-]{12,23}(?![\w-])/g, (token) => {
      if (!/\d/.test(token) || !/[A-Za-z]/.test(token) || /^ref=|^f\d*e\d+$/.test(token)) return token;
      hidden++;
      return "[secret hidden]";
    });
  });
  const BOX = /^(\s*- (?:textbox|searchbox|text|textarea)\b[^\n]*?\]):\s+(\S{8,})\s*$/;
  const boxed = guarded.map((line) => {
    const match = BOX.exec(line);
    if (!match) return line;
    const value = match[2].replace(/^"|"$/g, "");
    const named = /(?:^|[^a-z])(?:key|token|secret|credential)s?(?![a-z])/i.test(match[1]);
    const shaped = value.length >= 12 && /^[A-Za-z0-9_\-+/=.:~]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value) && !/^https?:|@/.test(value);
    if (value === "[secret hidden]" || value === "[hidden]" || !(named || shaped)) return line;
    hidden++;
    return `${match[1]}: [secret hidden]`;
  });
  return { text: boxed.join("\n"), hidden };
}
var STRONG_KEY, PREFIXED, LABEL_THEN_VALUE, SECRET_UUID, mixedCase, WORTH_SAVING_HINT;
var init_secret_finder = __esm({
  "src/agent/computer/secret-finder.ts"() {
    "use strict";
    STRONG_KEY = /api.?key|secret|access.?token|private.?key|auth.?token|bearer|credential/i;
    PREFIXED = /^(?:[a-z]{2,12}(?:_[a-z]+)*_[A-Za-z0-9]{12,}|sk-|ghp_|github_pat_|AKIA|AIza|AQ\.|xox[abp]-|eyJ)/;
    LABEL_THEN_VALUE = /\b(?:api[ _-]?key|secret(?:[ _-]?key)?|access[ _-]?token|token|key|credential|password)s?(?:[ \t]*[:=][ \t]*|[ \t]+)([A-Za-z0-9_\-+/=.:~]{16,512})/gi;
    SECRET_UUID = /(\bsecret[ _-]?(?:key|token)?s?(?:[ \t]*[:=][ \t]*|[ \t]+))([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
    mixedCase = (value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && (/\d/.test(value) || entropy(value) >= 4.5);
    WORTH_SAVING_HINT = /\bcopy\b|won'?t be (?:shown|displayed|visible)|only (?:once|time)|(?:save|store) (?:this|it|your)|make sure to (?:copy|save)|never (?:be )?shown again/i;
  }
});

// src/agent/computer/signup-recipes.ts
import fs6 from "node:fs/promises";
import path7 from "node:path";
function normalizeHost(host) {
  const safe = host.trim().toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "_").slice(0, 100);
  if (!safe || safe.startsWith(".")) throw new Error("A recipe needs a site name such as app.asana.com.");
  return safe;
}
function stepProblem(step, index) {
  const at = `Step ${index + 1}`;
  if (!step || typeof step !== "object") return `${at} is not a step.`;
  const s = step;
  if (!DOS.has(s.do)) return `${at}: unknown action "${String(s.do)}".`;
  if (s.target !== void 0 && (typeof s.target !== "string" || s.target.length > 200)) return `${at}: target must be short text.`;
  if (s.target && REF.test(s.target.trim())) return `${at}: target "${s.target}" is a page reference that changes every visit. Use the visible text or label of the control.`;
  if ((s.do === "click" || s.do === "fill" || s.do === "choose" || s.do === "upload") && !s.target?.trim()) return `${at}: ${s.do} needs a target (the visible text or label).`;
  if (s.text === void 0) return void 0;
  if (typeof s.text !== "string" || s.text.length > 200) return `${at}: text must be at most 200 characters.`;
  if (s.do === "fill") {
    if (SECRET_FIELD.test(s.target ?? "")) return `${at}: not saved, "${s.target}" looks like a password or code field. Leave the text out: a fill with no text uses the profile autofill.`;
    const words2 = s.text.split(/\s+/).map((word) => word.replace(/^[("'`]+|[)"'`,.;]+$/g, ""));
    if (words2.some(keyShaped)) return `${at}: not saved, the text looks like a key or token. Recipes never hold secrets.`;
    const t = s.text.trim();
    if (t.length >= 8 && !/\s/.test(t) && !t.includes("@") && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) && /[^A-Za-z0-9]/.test(t)) return `${at}: not saved, the text looks like a password. Leave the text out to use the profile autofill.`;
  }
  return void 0;
}
function recipeProblem(input, options = {}) {
  if (!LOGIN_ROUTES.includes(input.loginRoute)) return `login_route must be one of ${LOGIN_ROUTES.join(", ")}.`;
  if (!Array.isArray(input.steps) || !input.steps.length && !options.allowEmpty) return "A recipe needs a list of steps.";
  if (input.steps.length > MAX_STEPS) return `A recipe holds at most ${MAX_STEPS} steps.`;
  for (const [i, step] of input.steps.entries()) {
    const why = stepProblem(step, i);
    if (why) return why;
  }
  if (input.keyPage !== void 0) {
    try {
      const u = new URL(String(input.keyPage));
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search.length > 200 || keyShaped(u.pathname.split("/").pop() ?? "")) return "key_page must be a plain http(s) address without credentials or tokens.";
    } catch {
      return "key_page must be a web address.";
    }
  }
  if (input.captureHint !== void 0 && (typeof input.captureHint !== "string" || input.captureHint.length > 500 || input.captureHint.split(/\s+/).some((w) => keyShaped(w.replace(/^[("'`]+|[)"'`,.;]+$/g, ""))))) return "capture_hint must be short text without a key or token.";
  return void 0;
}
async function readAll(stateDir, host) {
  try {
    const parsed = JSON.parse(await fs6.readFile(file(stateDir, host), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
async function getRecipe(stateDir, host, route) {
  const all = await readAll(stateDir, host);
  const pool = route ? all.filter((r) => r.loginRoute === route) : all;
  return [...pool].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
}
async function saveRecipe(stateDir, input, now = /* @__PURE__ */ new Date(), options = {}) {
  const host = normalizeHost(input.host);
  const why = recipeProblem(input, options);
  if (why) throw new Error(`Recipe not saved: ${why}`);
  const recipe = { host, loginRoute: input.loginRoute, steps: input.steps.map((s) => ({ ...s })), ...input.keyPage ? { keyPage: input.keyPage } : {}, ...input.captureHint ? { captureHint: input.captureHint } : {}, verifiedAt: now.toISOString() };
  const rest = (await readAll(stateDir, host)).filter((r) => r.loginRoute !== recipe.loginRoute);
  await fs6.mkdir(path7.dirname(file(stateDir, host)), { recursive: true, mode: 448 });
  await fs6.writeFile(file(stateDir, host), `${JSON.stringify([...rest, recipe], null, 2)}
`, { mode: 384 });
  return recipe;
}
async function listRecipes(stateDir) {
  let names = [];
  try {
    names = await fs6.readdir(path7.join(stateDir, "computer", "recipes"));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) out.push(...await readAll(stateDir, name.slice(0, -5)));
  return out.sort((a, b) => a.host.localeCompare(b.host));
}
function describeRecipe(recipe) {
  const steps = recipe.steps.map((s, i) => `${i + 1}. ${s.do}${s.target ? ` "${s.target}"` : ""}${s.do === "fill" ? s.text === void 0 ? " (from profile)" : ` "${s.text}"` : s.text ? ` "${s.text}"` : ""}${s.key ? ` ${s.key}` : ""}`).join("\n");
  return `${recipe.host} via ${recipe.loginRoute}, verified ${recipe.verifiedAt.slice(0, 10)}${recipe.keyPage ? `
Key page: ${recipe.keyPage}` : ""}${recipe.captureHint ? `
Capture: ${recipe.captureHint}` : ""}
${steps}`;
}
function detectBlocker(pageText) {
  for (const [name, pattern] of BLOCKERS) if (pattern.test(pageText)) return name;
  return void 0;
}
async function replayRecipe(recipe, run, readPage) {
  let blocker;
  const result = await run(recipe.steps.map((s) => ({ ...s })), async () => {
    blocker = detectBlocker(await readPage().catch(() => ""));
    return blocker;
  });
  const head = `Recipe for ${recipe.host} (${recipe.loginRoute})`;
  if (blocker) return { output: `${head} stopped at ${blocker}. That step is for the person: not bypassed. Hand it over (handoff for a captcha or code, ask_user, or record it with queue), then carry on from the page below.

${result.output}`, completed: false, blocker };
  if (result.isError) return { output: `${head} stopped at the first step that failed; the page below is where it is now, so take over from here. Save a corrected recipe when you finish.

${result.output}`, isError: true, completed: false };
  if (/\d+ later steps? (?:was|were) not run/.test(result.output)) return { output: `${head} stopped early (a step is waiting on the page); take over from the page below.

${result.output}`, completed: false };
  return { output: `${head} ran all ${recipe.steps.length} steps.${recipe.keyPage ? ` Key page: ${recipe.keyPage}.` : ""}${recipe.captureHint ? ` Capture: ${recipe.captureHint}` : ""}

${result.output}`, completed: true };
}
var LOGIN_ROUTES, MAX_STEPS, REF, DOS, SECRET_FIELD, file, fillPlaceholders, BLOCKERS;
var init_signup_recipes = __esm({
  "src/agent/computer/signup-recipes.ts"() {
    "use strict";
    init_secret_finder();
    LOGIN_ROUTES = ["google", "github", "email"];
    MAX_STEPS = 40;
    REF = /^(?:f\d+)?e\d+$/;
    DOS = /* @__PURE__ */ new Set(["click", "fill", "choose", "press", "scroll", "wait", "upload"]);
    SECRET_FIELD = /pass(?:word|code|phrase)?|secret|token|api[ _-]?key|private[ _-]?key|\bpin\b|otp|cvv|cvc|card number|one[- ]time|2fa|verification code/i;
    file = (stateDir, host) => path7.join(stateDir, "computer", "recipes", `${normalizeHost(host)}.json`);
    fillPlaceholders = (text, values) => text?.replace(/\{\{(sso_email)\}\}/g, (all, name) => values[name] ?? all);
    BLOCKERS = [
      ["a captcha", /captcha|verify (?:that )?you(?:'| a)?re (?:a )?human|i'?m not a robot|are you a robot|cloudflare turnstile|checking (?:if|that) you are human|press (?:and|&) hold/i],
      ["an SMS or authenticator code", /(?:sent|texted) (?:a|the|your)? ?(?:\w+ )?(?:code )?(?:to|via) (?:your )?(?:phone|mobile|number|\+?\d)|text message|\bsms\b|authenticator app|two-factor|2-step verification|two-step verification|\bmfa\b|security key|enter the \d-digit code from your (?:phone|device)/i],
      ["a payment page", /card number|credit card|debit card|add (?:a )?payment method|payment (?:method|details|information)|billing (?:details|information|address)|enter your card|\bcvv\b|\bcvc\b|expiry date/i],
      ["a review page", /(?:under|pending|awaiting) (?:manual )?review|being reviewed|submit for review|review (?:can|may|will) take|we(?:'| a)re reviewing|application (?:is )?(?:pending|under)|waitlist/i]
    ];
  }
});

// src/agent/computer/site-notes.ts
import fs7 from "node:fs/promises";
import path8 from "node:path";
function notesFile(stateDir, host) {
  const safe = host.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9.-]/g, "_").slice(0, 100);
  if (!safe || safe.startsWith(".")) throw new Error("Notes need a site name such as app.asana.com.");
  return path8.join(stateDir, "computer", "notes", `${safe}.md`);
}
async function readSiteNotes(stateDir, host) {
  try {
    return (await fs7.readFile(notesFile(stateDir, host), "utf8")).trim();
  } catch {
    return "";
  }
}
async function addSiteNote(stateDir, host, text) {
  const note = text.trim();
  if (!note) throw new Error("Notes need text to save.");
  if (note.split(/\s+/).some((word) => keyShaped(word.replace(/^[("'`]+|[)"'`,.;]+$/g, "")))) throw new Error("Not saved: the note contains something shaped like a key or token. Notes are for steps and addresses, never secrets.");
  const file3 = notesFile(stateDir, host);
  await fs7.mkdir(path8.dirname(file3), { recursive: true, mode: 448 });
  const all = `${await readSiteNotes(stateDir, host)}
- ${note.replace(/\n+/g, " ")}`.trim();
  const kept = all.length > MAX_CHARS ? `\u2026${all.slice(-MAX_CHARS)}` : all;
  await fs7.writeFile(file3, `${kept}
`, { mode: 384 });
  return kept;
}
var MAX_CHARS;
var init_site_notes = __esm({
  "src/agent/computer/site-notes.ts"() {
    "use strict";
    init_secret_finder();
    MAX_CHARS = 4e3;
  }
});

// src/agent/computer/profiles.ts
var profiles_exports = {};
__export(profiles_exports, {
  PASSWORD_SECRET: () => PASSWORD_SECRET,
  PROFILE_KEYS: () => PROFILE_KEYS,
  assertCustomKey: () => assertCustomKey,
  bestProfileFor: () => bestProfileFor,
  birthdayFor: () => birthdayFor,
  customFieldFor: () => customFieldFor,
  defaultProfile: () => defaultProfile,
  describeProfile: () => describeProfile,
  listProfiles: () => listProfiles,
  normalizePhone: () => normalizePhone,
  phoneFor: () => phoneFor,
  profileKeyFor: () => profileKeyFor,
  readProfileSecret: () => readProfileSecret,
  removeProfile: () => removeProfile,
  saveProfile: () => saveProfile,
  saveProfileSecret: () => saveProfileSecret,
  secretFieldFor: () => secretFieldFor
});
import { randomUUID as randomUUID2 } from "node:crypto";
async function listProfiles(stateDir) {
  return (await readVaultRecords(stateDir, FOLDER)).map(({ id, value }) => ({ id, label: value.label, fields: value.fields, ...value.custom ? { custom: value.custom } : {}, ...value.secrets ? { secrets: value.secrets } : {} })).sort((a, b) => a.label.localeCompare(b.label));
}
function defaultProfile(profiles) {
  const standard = (profile) => PROFILE_KEYS.filter((key) => profile.fields[key]).length;
  return [...profiles].sort((a, b) => Number(b.label.toLowerCase() === "personal") - Number(a.label.toLowerCase() === "personal") || standard(b) - standard(a) || a.label.localeCompare(b.label))[0];
}
async function saveProfile(stateDir, input) {
  const fields = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (!PROFILE_KEYS.includes(key)) throw new Error(`Unknown profile field "${key}". Fields: ${PROFILE_KEYS.join(", ")}.`);
    if (typeof value === "string" && value.trim()) fields[key] = (key === "phone" ? normalizePhone(value) : value.trim()).slice(0, 200);
  }
  const all = await listProfiles(stateDir);
  const existing = all.find((profile) => profile.id === input.id) ?? (input.label ? all.find((profile) => profile.label.toLowerCase() === input.label.toLowerCase()) : !input.id ? defaultProfile(all) : void 0);
  const custom = mergeCustom(existing?.custom, input.custom);
  const saved = existing ? { ...existing, label: input.id ? input.label?.trim() || existing.label : existing.label, fields: { ...existing.fields, ...fields }, ...custom ? { custom } : {} } : { id: randomUUID2(), label: input.label?.trim() || "Personal", fields, ...custom ? { custom } : {} };
  await writeVaultRecord(stateDir, FOLDER, saved.id, { label: saved.label, fields: saved.fields, ...saved.custom ? { custom: saved.custom } : {}, ...saved.secrets ? { secrets: saved.secrets } : {} });
  return saved;
}
async function removeProfile(stateDir, id) {
  const profile = (await listProfiles(stateDir)).find((item) => item.id === id);
  for (const key of Object.keys(profile?.secrets ?? {})) await deleteNamedSecret(stateDir, secretName(id, key)).catch(() => false);
  return removeVaultRecord(stateDir, FOLDER, id);
}
async function saveProfileSecret(stateDir, id, key, value, spec = {}) {
  assertCustomKey(key, true);
  const profile = (await listProfiles(stateDir)).find((item) => item.id === id);
  if (!profile) throw new Error("No such profile.");
  if (!value) throw new Error(`The secret "${key}" is empty.`);
  await saveNamedSecret(stateDir, secretName(id, key), value);
  const label = (spec.label?.trim() || profile.secrets?.[key]?.label || key.replace(/_/g, " ")).slice(0, 80);
  const match = spec.match ? spec.match.map((item) => item.trim().toLowerCase()).filter((item) => item.length >= 3 && item.length <= 60).slice(0, 8) : profile.secrets?.[key]?.match;
  if (Object.keys(profile.secrets ?? {}).length >= MAX_SECRETS && !profile.secrets?.[key]) throw new Error(`A profile holds at most ${MAX_SECRETS} secrets.`);
  const secrets = { ...profile.secrets, [key]: { label, ...match?.length ? { match } : {} } };
  await writeVaultRecord(stateDir, FOLDER, id, { label: profile.label, fields: profile.fields, ...profile.custom ? { custom: profile.custom } : {}, secrets });
}
async function readProfileSecret(stateDir, profile, key) {
  return profile.secrets?.[key] ? readNamedSecret(stateDir, secretName(profile.id, key)).catch(() => void 0) : void 0;
}
function assertCustomKey(key, secret = false) {
  if (!CUSTOM_KEY.test(key)) throw new Error(`A custom field name is lower-case letters, digits and underscores, starting with a letter (got "${key}").`);
  if (!secret && PROFILE_KEYS.includes(key)) throw new Error(`"${key}" is a standard profile field: save it with fields, not custom.`);
}
function mergeCustom(existing, input) {
  if (!input || !Object.keys(input).length) return existing;
  const next = { ...existing };
  for (const [key, given] of Object.entries(input)) {
    assertCustomKey(key);
    const value = typeof given.value === "string" ? given.value.trim() : "";
    if (!value) {
      delete next[key];
      continue;
    }
    if (value.length > MAX_CUSTOM_VALUE) throw new Error(`The value of "${key}" is longer than ${MAX_CUSTOM_VALUE} characters.`);
    if (value.split(/\s+/).some(keyShaped)) throw new Error(`The value of "${key}" looks like a key or token. A profile holds details, not secrets: capture it with capture_secret instead.`);
    const label = (given.label?.trim() || next[key]?.label || key.replace(/_/g, " ")).slice(0, 80);
    const match = given.match ? given.match.map((item) => item.trim().toLowerCase()).filter((item) => item.length >= 3 && item.length <= 60).slice(0, 8) : next[key]?.match;
    next[key] = { label, value, ...match?.length ? { match } : {} };
  }
  if (Object.keys(next).length > MAX_CUSTOM_FIELDS) throw new Error(`A profile holds at most ${MAX_CUSTOM_FIELDS} custom fields.`);
  return Object.keys(next).length ? next : void 0;
}
function describeProfile(profile) {
  const standard = PROFILE_KEYS.filter((key) => profile.fields[key]).map((key) => `${key}=${profile.fields[key]}`);
  const custom = Object.entries(profile.custom ?? {}).map(([key, field]) => `${key}=${field.value.length > 300 ? `${field.value.slice(0, 300)}\u2026` : field.value}`);
  const secrets = Object.keys(profile.secrets ?? {}).map((key) => `${key}=(secret, hidden)`);
  return `${profile.label}: ${[...standard, ...custom, ...secrets].join(", ") || "(empty)"}`;
}
function isSecretField(hint) {
  return hint.type === "password" || /password|passcode|one-time|verification|security.?code|\botp\b|card|cvv|cvc/.test(`${hint.autocomplete} ${hint.text}`.toLowerCase());
}
function customFieldFor(profile, hint) {
  if (!profile?.custom || isSecretField(hint)) return void 0;
  const asked = words(hint.text);
  let best;
  for (const [key, field] of Object.entries(profile.custom)) {
    for (const phrase of field.match?.length ? field.match : [field.label, key.replace(/_/g, " ")]) {
      const needle = words(phrase);
      if (needle.trim().length >= 3 && asked.includes(needle) && (!best || needle.length > best.length)) best = { key, field, length: needle.length };
    }
  }
  return best ? { key: best.key, field: best.field } : void 0;
}
function secretFieldFor(profile, hint) {
  if (!profile?.secrets) return void 0;
  if (hint.type === "password" && profile.secrets[PASSWORD_SECRET] && !/one-time|verification|security.?code|\botp\b|current-password/i.test(`${hint.autocomplete} ${hint.text}`)) return PASSWORD_SECRET;
  const asked = words(hint.text);
  let best;
  for (const [key, field] of Object.entries(profile.secrets)) {
    if (key === PASSWORD_SECRET) continue;
    for (const phrase of field.match?.length ? field.match : [field.label, key.replace(/_/g, " ")]) {
      const needle = words(phrase);
      if (needle.trim().length >= 3 && asked.includes(needle) && (!best || needle.length > best.length)) best = { key, length: needle.length };
    }
  }
  return best?.key;
}
function profileKeyFor(hint) {
  if (isSecretField(hint)) return void 0;
  for (const token of hint.autocomplete.toLowerCase().split(/\s+/)) if (TOKENS[token]) return TOKENS[token];
  const text = hint.text.toLowerCase();
  for (const [pattern, key] of WORDS) if (pattern.test(text)) return key;
  return hint.type === "email" ? "email" : hint.type === "tel" ? "phone" : void 0;
}
function phoneFor(value, placeholder = "", currentValue = "") {
  const digits = value.replace(/\D/g, "");
  const national = value.trim().startsWith("+1") || digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (currentValue.trim().startsWith("+")) return value.trim().startsWith("+") ? value.trim() : `+1${national}`;
  if (national.length === 10 && /\(/.test(placeholder)) return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  if (national.length === 10 && /\d{3}-\d{3}/.test(placeholder)) return `${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`;
  if (national.length === 10 && /^\d{10}$/.test(placeholder.trim())) return national;
  return value.trim();
}
function normalizePhone(value) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return value.trim().startsWith("+") ? `+${digits}` : digits;
}
function birthdayFor(value, words2 = "") {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return value.trim();
  const [, month, day, year] = match;
  const hint = words2.toLowerCase();
  if (/\b(yyyy|year)\b/.test(hint) && !/\b(mm|dd|month|day)\b/.test(hint)) return year;
  if (/\b(dd|day)\b/.test(hint) && !/\b(mm|month|yyyy|year)\b/.test(hint)) return day;
  if (/\b(mm|month)\b/.test(hint) && !/\b(dd|day|yyyy|year)\b/.test(hint)) return /\bmm\b/.test(hint) ? month : MONTHS[Number(month) - 1] ?? month;
  const order = /\d{2}[-/. ]\d{2}[-/. ]\d{4}|dd[-/. ]mm|mm[-/. ]dd|yyyy[-/. ]mm/.exec(hint)?.[0] ?? "";
  if (/^yyyy/.test(order)) return `${year}-${month}-${day}`;
  if (/^dd/.test(order)) return `${day}/${month}/${year}`;
  return `${month}/${day}/${year}`;
}
function bestProfileFor(profiles, hints, label) {
  if (profiles.length <= 1) return profiles[0];
  const named = label ? profiles.find((candidate) => candidate.label.toLowerCase() === label.trim().toLowerCase()) : void 0;
  if (named) return named;
  const score = (candidate) => hints.filter((hint) => {
    const key = profileKeyFor(hint);
    return key && candidate.fields[key] || customFieldFor(candidate, hint);
  }).length;
  const personalProfile = profiles.find((candidate) => candidate.label.toLowerCase() === "personal");
  if (personalProfile) {
    const askedBy = (candidate) => hints.filter((hint) => customFieldFor(candidate, hint)).length;
    const better = profiles.filter((candidate) => candidate !== personalProfile && askedBy(candidate) > askedBy(personalProfile));
    return better.sort((a, b) => askedBy(b) - askedBy(a) || score(b) - score(a))[0] ?? personalProfile;
  }
  const size = (candidate) => Object.keys(candidate.fields).length + Object.keys(candidate.custom ?? {}).length;
  return [...profiles].sort((a, b) => score(b) - score(a) || size(b) - size(a))[0];
}
var PROFILE_KEYS, PASSWORD_SECRET, FOLDER, secretName, CUSTOM_KEY, MAX_CUSTOM_FIELDS, MAX_SECRETS, MAX_CUSTOM_VALUE, TOKENS, WORDS, words, MONTHS;
var init_profiles = __esm({
  "src/agent/computer/profiles.ts"() {
    "use strict";
    init_credential_vault();
    init_secret_finder();
    PROFILE_KEYS = ["given_name", "family_name", "email", "phone", "address_line1", "address_line2", "city", "state", "postal_code", "country", "organization", "job_title", "website", "birthday", "sso_email"];
    PASSWORD_SECRET = "password";
    FOLDER = "profile";
    secretName = (id, key) => `profile/${id.slice(0, 8)}/${key}`;
    CUSTOM_KEY = /^[a-z][a-z0-9_]{0,39}$/;
    MAX_CUSTOM_FIELDS = 40;
    MAX_SECRETS = 20;
    MAX_CUSTOM_VALUE = 2e3;
    TOKENS = {
      "given-name": "given_name",
      "family-name": "family_name",
      email: "email",
      tel: "phone",
      "tel-national": "phone",
      "street-address": "address_line1",
      "address-line1": "address_line1",
      "address-line2": "address_line2",
      "address-level2": "city",
      "address-level1": "state",
      "postal-code": "postal_code",
      country: "country",
      "country-name": "country",
      organization: "organization",
      "organization-title": "job_title",
      url: "website",
      bday: "birthday",
      "bday-day": "birthday",
      "bday-month": "birthday",
      "bday-year": "birthday"
    };
    WORDS = [
      [/first.?name|given.?name|forename|\bfname\b/, "given_name"],
      [/last.?name|family.?name|surname|\blname\b/, "family_name"],
      [/e-?mail/, "email"],
      [/phone|mobile|\btel\b|cell/, "phone"],
      [/address.?(?:line)?.?2|apt|suite|unit|\bapartment\b/, "address_line2"],
      [/address|street/, "address_line1"],
      [/\bcity\b|town/, "city"],
      [/\bstate\b|province|region(?!al)/, "state"],
      [/zip|postal|post.?code/, "postal_code"],
      [/country|territory/, "country"],
      [/company|organi[sz]ation|employer|business.?name/, "organization"],
      [/job.?title|position|\brole\b/, "job_title"],
      [/website|\burl\b/, "website"],
      [/birth|\bdob\b|\bbday\b|\b(?:dd|mm|yyyy)\b/, "birthday"]
    ];
    words = (text) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
    MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  }
});

// src/agent/computer/password-policy.ts
import { randomInt } from "node:crypto";
function parseRules(text) {
  const t = text.replace(/\s+/g, " ");
  const rules = {};
  if (new RegExp(`${NEGATION}[^.;]{0,60}\\b(?:repeat\\w*|duplicat\\w*|identical|same (?:character|letter|digit))`, "i").test(t)) rules.noRepeat = true;
  if (new RegExp(`${NEGATION}[^.;]{0,60}\\b(?:sequen\\w*|consecutive (?:letters?|numbers?|digits?|characters?)|ascending|descending|abc\\b|123\\b|keyboard (?:pattern|run|sequence)|qwerty)`, "i").test(t)) rules.noSequence = true;
  const most = /(?:no more than|not more than|at most|maximum of|max\.? of|up to|cannot (?:have|contain|use) more than)\s+(\d)\s+(?:\w+\s+){0,2}?(?:identical|same|repeated|repeating|consecutive|duplicate)/i.exec(t);
  const orMore = /(\d)\s+or more\s+(?:\w+\s+){0,2}?(?:identical|same|repeated|repeating|consecutive)/i.exec(t);
  const limit = most ? Number(most[1]) : orMore ? Number(orMore[1]) - 1 : 0;
  if (limit >= 1) {
    rules.maxIdentical = limit;
    if (/in a row|consecutive|adjacent|back to back|side by side|repeating/i.test(t)) rules.inRow = true;
  }
  if (!FORBIDS_SYMBOLS.test(t) && /(?:at least one|one|1|\ba\b|\ban\b|contain\w*|include\w*|with|must have|requires?|needs?)\s+(?:\w+\s+){0,3}?(?:special|symbol|punctuation)\b/i.test(t) && !new RegExp(`${NEGATION}\\s+(?:\\w+\\s+){0,2}(?:special|symbols?)`, "i").test(t)) rules.requireSymbol = true;
  return Object.keys(rules).length ? rules : void 0;
}
function listedSymbols(text) {
  const match = /(?:special characters?|symbols?|punctuation)[^.\n]{0,40}?(?:[:(]|e\.?g\.?,?|such as|like|include|from|are|allowed)\s*([^\s\w]{1,2}(?:[ ,]*[^\s\w]{1,2}){1,20})/i.exec(text);
  if (!match?.[1]) return "";
  return [...new Set([...match[1]].filter((char) => /[!-/:-@[-`{-~]/.test(char)))].join("");
}
function parsePolicy(hints = {}) {
  const list = Array.isArray(hints) ? hints : [hints];
  let min = DEFAULT_POLICY.minLength;
  let max = HARD_MAX;
  let symbols = DEFAULT_SYMBOLS;
  const patterns = [];
  let rules;
  for (const hint of list) {
    if (hint.minlength && hint.minlength > 0) min = Math.max(min, hint.minlength);
    if (hint.maxlength && hint.maxlength > 0 && hint.maxlength < 1e4) max = Math.min(max, hint.maxlength);
    if (hint.pattern) patterns.push(hint.pattern);
    const text = (hint.text ?? "").replace(/\s+/g, " ");
    const range = /(\d{1,3})\s*(?:-|–|to|and)\s*(\d{1,3})\s*(?:characters?|chars?|letters?|digits?)/i.exec(text);
    if (range) {
      min = Math.max(min, Number(range[1]));
      max = Math.min(max, Number(range[2]));
    }
    for (const found of text.matchAll(/(?:at least|minimum(?: of| length)?|min\.?(?: of| length)?|no (?:fewer|less) than|longer than|\bmust be|more than)\s*:?\s*(\d{1,3})\s*\+?\s*(?:or more\s*)?(?:characters?|chars?|letters?|symbols?|digits?)?/gi)) {
      const value = Number(found[1]);
      if (/longer than|more than/i.test(found[0])) {
        if (/\bcharacters?|chars?/i.test(found[0]) || /\bpassword\b[^.]{0,30}$/i.test(text.slice(0, found.index))) min = Math.max(min, value + 1);
      } else if (value >= 4 && value <= 128) min = Math.max(min, value);
    }
    for (const found of text.matchAll(/(\d{1,3})\s*\+\s*(?:characters?|chars?)/gi)) min = Math.max(min, Number(found[1]));
    for (const found of text.matchAll(/(?:at most|maximum(?: of| length)?|max\.?(?: of| length)?|no more than|up to|not (?:be )?(?:longer|exceed)(?: than)?|fewer than|shorter than|under)\s*:?\s*(\d{1,3})\s*(?:characters?|chars?)/gi)) {
      const value = Number(found[1]);
      if (value >= 6) max = Math.min(max, /fewer than|shorter than|under/i.test(found[0]) ? value - 1 : value);
    }
    rules = mergeRules(rules, parseRules(text));
    if (FORBIDS_SYMBOLS.test(text)) symbols = "";
    else {
      const named = listedSymbols(text);
      if (named) symbols = [...DEFAULT_SYMBOLS].filter((char) => named.includes(char)).join("") || named;
    }
  }
  if (max < min) min = max;
  min = Math.min(min, HARD_MAX);
  if (rules?.requireSymbol && !symbols) symbols = DEFAULT_SYMBOLS;
  return { length: clamp(DEFAULT_POLICY.length, min, max), minLength: min, maxLength: max, symbols, patterns, ...rules ? { rules } : {} };
}
function hasKeyboardRun(password) {
  const lowered = password.toLowerCase();
  for (let i = 2; i < lowered.length; i++) {
    const three = lowered.slice(i - 2, i + 1);
    const backwards = [...three].reverse().join("");
    if (KEYBOARD_ROWS.some((row) => row.includes(three) || row.includes(backwards))) return true;
  }
  return false;
}
function hasTooManyIdentical(password, limit, inRow = false) {
  const lowered = password.toLowerCase();
  if (inRow) {
    let run = 1;
    for (let i = 1; i < lowered.length; i++) {
      run = lowered[i] === lowered[i - 1] ? run + 1 : 1;
      if (run > limit) return true;
    }
    return false;
  }
  const counts = /* @__PURE__ */ new Map();
  for (const char of lowered) {
    const next = (counts.get(char) ?? 0) + 1;
    if (next > limit) return true;
    counts.set(char, next);
  }
  return false;
}
function hasRepeatOrSequence(password) {
  if (hasKeyboardRun(password)) return true;
  const lowered = password.toLowerCase();
  for (let i = 1; i < password.length; i++) {
    const a = lowered.charCodeAt(i - 2), b = lowered.charCodeAt(i - 1), c = lowered.charCodeAt(i);
    if (b === c) return true;
    if (i >= 2 && (b - a === 1 && c - b === 1 || a - b === 1 && b - c === 1)) return true;
  }
  return false;
}
function matchesPatterns(password, patterns) {
  return patterns.every((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`, "u").test(password);
    } catch {
      try {
        return new RegExp(`^(?:${pattern})$`).test(password);
      } catch {
        return true;
      }
    }
  });
}
function generatePassword(policy = DEFAULT_POLICY) {
  const symbols = policy.symbols || (policy.rules?.requireSymbol ? DEFAULT_SYMBOLS : "");
  const classes = [LOWER, UPPER, DIGITS, ...symbols ? [symbols] : []];
  const length = clamp(policy.length, Math.min(policy.minLength, policy.maxLength), policy.maxLength);
  const all = classes.join("");
  const total = policy.rules?.maxIdentical && !policy.rules.inRow ? policy.rules.maxIdentical : 0;
  const build = (sets, set) => {
    const used = /* @__PURE__ */ new Map();
    const draw = (source) => {
      let char = source[randomInt(source.length)];
      for (let tries = 0; total && (used.get(char.toLowerCase()) ?? 0) >= total && tries < 60; tries++) char = source[randomInt(source.length)];
      used.set(char.toLowerCase(), (used.get(char.toLowerCase()) ?? 0) + 1);
      return char;
    };
    const chars = sets.slice(0, length).map(draw);
    while (chars.length < length) chars.push(draw(set));
    return shuffle(chars).join("");
  };
  const limit = policy.rules?.maxIdentical;
  const fine = (value) => matchesPatterns(value, policy.patterns) && !hasRepeatOrSequence(value) && !(limit && hasTooManyIdentical(value, limit, policy.rules?.inRow));
  let candidate = build(classes, all);
  for (let tries = 0; tries < 2e3 && !fine(candidate); tries++) candidate = build(classes, all);
  if (!matchesPatterns(candidate, policy.patterns)) {
    const plain = [LOWER, UPPER, DIGITS];
    for (let tries = 0; tries < 200 && !fine(candidate); tries++) candidate = build(plain, plain.join(""));
  }
  return candidate;
}
function classifyRejection(text) {
  const out = {};
  const lower = text.toLowerCase();
  const learned = parsePolicy({ text });
  const rules = learned.rules;
  if (/too short|at least|minimum|not long enough|longer|more characters|min(?:imum)? length|\d+\s*\+\s*char/.test(lower)) out.tooShort = learned.minLength > DEFAULT_POLICY.minLength ? learned.minLength : true;
  if (/too long|at most|maximum|no more than|exceed|shorter|fewer|up to \d+|max(?:imum)? length/.test(lower)) out.tooLong = learned.maxLength < HARD_MAX ? learned.maxLength : true;
  const asksForSymbol = !!rules?.requireSymbol && !FORBIDS_SYMBOLS.test(text);
  const aboutRules = !!(rules?.noRepeat || rules?.noSequence || rules?.maxIdentical) && !FORBIDS_SYMBOLS.test(text);
  if (!asksForSymbol && /special|symbol|not allowed|illegal|unsupported|alphanumeric|forbidden|disallow|punctuation|spaces?/.test(lower) || !aboutRules && !asksForSymbol && /character|invalid|weak|letters? and/.test(lower) && !out.tooShort && !out.tooLong) out.characters = true;
  return out;
}
function relax(policy, rejection, attempt) {
  const said = classifyRejection(rejection);
  const learned = parsePolicy({ text: rejection });
  let minLength = Math.max(policy.minLength, learned.minLength);
  let maxLength = Math.min(policy.maxLength, learned.maxLength);
  let length = policy.length;
  if (typeof said.tooShort === "number") length = Math.max(length, said.tooShort);
  else if (said.tooShort) {
    length = Math.min(Math.max(length + 8, 16), HARD_MAX);
    minLength = Math.max(minLength, length);
  }
  if (typeof said.tooLong === "number") length = Math.min(length, said.tooLong);
  else if (said.tooLong) {
    length = Math.max(Math.min(length - 8, 16), 8);
    maxLength = Math.min(maxLength, length);
  }
  const rules = mergeRules(policy.rules, learned.rules);
  let symbols = policy.symbols;
  if (attempt === 1 && said.characters) symbols = policy.symbols.length > 3 ? "!@#" : policy.symbols;
  else if (attempt >= 2 && (said.characters || attempt >= 3)) symbols = "";
  else if (attempt === 1 && !said.tooShort && !said.tooLong) symbols = policy.symbols.length > 3 ? "!@#" : policy.symbols;
  if (!symbols && rules?.requireSymbol) symbols = "!@#";
  if (attempt >= 3 && !said.tooShort) length = Math.min(length, Math.max(minLength, 16));
  if (maxLength < minLength) minLength = maxLength;
  return { length: clamp(length, Math.min(minLength, maxLength), maxLength), minLength: Math.min(minLength, maxLength), maxLength, symbols, patterns: policy.patterns, ...rules ? { rules } : {} };
}
var NEGATION, FORBIDS_SYMBOLS, mergeRules, DEFAULT_SYMBOLS, HARD_MAX, DEFAULT_POLICY, MAX_PASSWORD_ATTEMPTS, LOWER, UPPER, DIGITS, clamp, shuffle, KEYBOARD_ROWS;
var init_password_policy = __esm({
  "src/agent/computer/password-policy.ts"() {
    "use strict";
    NEGATION = String.raw`(?:\bno\b|\bnot\b|\bwithout\b|\bavoid\b|\bcannot\b|can'?t|\bmust not\b|don'?t|\bnever\b|\bnone\b)`;
    FORBIDS_SYMBOLS = /(?:no|without|not (?:allow|support|accept)|don'?t (?:use|include)|avoid|exclud\w*)\s+(?:any\s+)?(?:special|symbols?|punctuation)|(?:letters?|alphanumeric|alpha-numeric)\s*(?:and|&|or|\+)\s*(?:numbers?|digits?)\s*only|only\s+(?:letters?|alphanumeric)|alphanumeric\s+(?:characters\s+)?only|special (?:characters?|symbols?) (?:are )?not allowed/i;
    mergeRules = (a, b) => {
      if (!a || !b) return a ?? b;
      const maxIdentical = a.maxIdentical && b.maxIdentical ? Math.min(a.maxIdentical, b.maxIdentical) : a.maxIdentical ?? b.maxIdentical;
      return { ...a.noRepeat || b.noRepeat ? { noRepeat: true } : {}, ...a.noSequence || b.noSequence ? { noSequence: true } : {}, ...maxIdentical ? { maxIdentical } : {}, ...a.inRow || b.inRow ? { inRow: true } : {}, ...a.requireSymbol || b.requireSymbol ? { requireSymbol: true } : {} };
    };
    DEFAULT_SYMBOLS = "!@#$%^*-_";
    HARD_MAX = 128;
    DEFAULT_POLICY = { length: 24, minLength: 8, maxLength: HARD_MAX, symbols: DEFAULT_SYMBOLS, patterns: [] };
    MAX_PASSWORD_ATTEMPTS = 3;
    LOWER = "abcdefghijkmnopqrstuvwxyz";
    UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    DIGITS = "23456789";
    clamp = (value, low, high) => Math.max(low, Math.min(high, value));
    shuffle = (items) => {
      for (let index = items.length - 1; index > 0; index--) {
        const other = randomInt(index + 1);
        [items[index], items[other]] = [items[other], items[index]];
      }
      return items;
    };
    KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];
  }
});

// src/agent/computer/signup-login.ts
function pendingSignupPassword(page) {
  return pending.get(page)?.password;
}
function pendingSignupUsername(page) {
  return pending.get(page)?.username;
}
function expectSignup(page, password) {
  pending.set(page, { password });
}
async function holdSignup(stateDir, page, password, username) {
  if (pending.get(page)?.password === password) return;
  const held = { password, ...username ? { username } : {} };
  if (username) {
    const old = await savedPasswordFor(stateDir, page.url(), username, { rejected: true });
    held.itemId = await saveLoginFields(stateDir, page.url(), { username, password, ...old && old !== password ? { previous_password: old } : {} });
  }
  pending.set(page, held);
}
async function savedPasswordFor(stateDir, url2, username, options = {}) {
  if (!username) return void 0;
  try {
    const found = (await savedLoginsForSite(stateDir, url2)).find((login) => login.label.split(" \xB7 ").some((value) => value.toLowerCase() === username.toLowerCase()));
    return found && (options.rejected || !found.rejected) ? (await savedLoginFields(stateDir, url2, found.id)).password : void 0;
  } catch {
    return void 0;
  }
}
async function sitePasswordFor(stateDir, page, email) {
  const typed = pendingSignupPassword(page);
  if (typed) return typed;
  const byEmail = await savedPasswordFor(stateDir, page.url(), email);
  if (byEmail) return byEmail;
  try {
    const usable = (await savedLoginsForSite(stateDir, page.url())).filter((login) => !login.rejected);
    return usable.length === 1 ? (await savedLoginFields(stateDir, page.url(), usable[0].id)).password : void 0;
  } catch {
    return void 0;
  }
}
async function settleSignup(stateDir, page) {
  const waiting = pending.get(page);
  if (!waiting || page.isClosed()) return void 0;
  try {
    const username = await page.locator(NAME_FIELD).evaluateAll((nodes) => nodes.map((node) => node.value ?? "").find((value) => value.includes("@")));
    if (username) waiting.username = username;
    if (await page.locator(`${PASSWORD_FIELD}:visible`).count()) return void 0;
    pending.delete(page);
    if (!waiting.username) return void 0;
    const old = await savedPasswordFor(stateDir, page.url(), waiting.username, { rejected: true });
    await saveLoginFields(stateDir, page.url(), { username: waiting.username, password: waiting.password, ...old && old !== waiting.password ? { previous_password: old } : {} }, waiting.itemId);
    return `Saved the new login for ${new URL(page.url()).hostname} (${waiting.username}) in ClikCode Secrets Manager.`;
  } catch {
    return void 0;
  }
}
var pending, PASSWORD_FIELD, NAME_FIELD;
var init_signup_login = __esm({
  "src/agent/computer/signup-login.ts"() {
    "use strict";
    init_credential_vault();
    init_shared_state();
    init_password_policy();
    pending = sharedState("signup-pending", () => /* @__PURE__ */ new WeakMap());
    PASSWORD_FIELD = 'input[type="password"]';
    NAME_FIELD = 'input[type="email"], input[autocomplete="username"], input[autocomplete="email"]';
  }
});

// src/agent/computer/password-retry.ts
function generatedFor(page) {
  return generated.get(page);
}
async function readPasswordPolicy(page) {
  try {
    const hints = await page.locator(PASSWORD_BOX).evaluateAll((boxes) => boxes.map((node) => {
      const box = node;
      const described = (box.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => box.ownerDocument.getElementById(id)?.textContent ?? "").join(" ");
      let near = box.parentElement;
      for (let level = 0; level < 2 && near?.parentElement && (near.innerText ?? "").length < 200; level++) near = near.parentElement;
      const min = Number(box.getAttribute("minlength"));
      const max = Number(box.getAttribute("maxlength"));
      return {
        text: `${described} ${box.getAttribute("title") ?? ""} ${box.getAttribute("placeholder") ?? ""} ${(near?.innerText ?? "").slice(0, 600)}`,
        ...min > 0 ? { minlength: min } : {},
        ...max > 0 ? { maxlength: max } : {},
        ...box.getAttribute("pattern") ? { pattern: box.getAttribute("pattern") } : {}
      };
    }));
    return parsePolicy(hints);
  } catch {
    return parsePolicy();
  }
}
async function readPasswordRejection(page) {
  try {
    return await page.locator(PASSWORD_BOX).evaluateAll((boxes) => {
      const about = /password|passphrase|character|symbol|special|upper|lower|digit|number|letter|too (?:short|long|weak|simple|common)|weak|at least|at most|must (?:contain|include|be|have)|not allowed|invalid|not accepted|requirement/i;
      const failing = /error|invalid|danger|alert|fail|warn|problem|help-block|feedback|validation/i;
      const lines = [];
      for (const node of boxes) {
        const box = node;
        const flagged = box.getAttribute("aria-invalid") === "true" || (box.checkValidity ? !box.checkValidity() : false);
        const scope = box.closest("form") ?? box.parentElement?.parentElement?.parentElement ?? box.parentElement;
        const described = (box.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => box.ownerDocument.getElementById(id)).filter(Boolean);
        const candidates = [...Array.from(scope?.querySelectorAll('[role="alert"], [aria-live], [class], [id], [data-error], [data-testid]') ?? []), ...described];
        for (const item of candidates) {
          const text = (item.innerText ?? "").replace(/\s+/g, " ").trim();
          if (!text || text.length > 300 || !item.getClientRects().length || !about.test(text)) continue;
          const marked = item.getAttribute("role") === "alert" || failing.test(`${item.getAttribute("class") ?? ""} ${item.getAttribute("id") ?? ""} ${item.getAttribute("data-testid") ?? ""}`) || described.includes(item) && flagged;
          if (marked) lines.push(text);
        }
        if (flagged && !lines.length && box.validationMessage && about.test(box.validationMessage)) lines.push(box.validationMessage);
      }
      return [...new Set(lines)].slice(0, 3).join(" ");
    });
  } catch {
    return "";
  }
}
async function typePassword(page, password) {
  const boxes = page.locator(PASSWORD_BOX);
  const count = await boxes.count();
  for (let index = 0; index < count; index++) {
    const box = boxes.nth(index);
    await box.fill("", { timeout: 1e4 });
    await box.pressSequentially(password, { timeout: 1e4 });
    await box.blur().catch(() => void 0);
  }
  return count;
}
function rememberGenerated(page, password, policy) {
  const before = generated.get(page);
  if (before?.password === password) return;
  generated.set(page, { password, policy, attempts: before?.attempts ?? 0, past: /* @__PURE__ */ new Set([...before?.past ?? [], ...before ? [before.password] : []]) });
}
async function retryRejectedPassword(options) {
  const { page } = options;
  const state = generated.get(page);
  if (!state || state.attempts >= MAX_PASSWORD_ATTEMPTS || page.isClosed()) return void 0;
  let rejection = await readPasswordRejection(page);
  if (!rejection) return void 0;
  const first = rejection;
  let tries = 0;
  while (rejection && state.attempts < MAX_PASSWORD_ATTEMPTS) {
    state.attempts += 1;
    tries += 1;
    state.policy = relax(state.policy, rejection, state.attempts);
    const next = generatePassword(state.policy);
    registerSecret(next);
    state.past.add(state.password);
    state.password = next;
    await holdSignup(options.stateDir, page, next, options.username);
    if (!await typePassword(page, next)) break;
    if (options.resubmit) {
      await options.resubmit().catch(() => void 0);
      await options.settle(page);
    }
    if (page.isClosed() || !await page.locator(PASSWORD_BOX).count().catch(() => 0)) {
      rejection = "";
      break;
    }
    rejection = await readPasswordRejection(page);
  }
  const said = scrubSecrets(first).slice(0, 120);
  const refused = !page.isClosed() && state.attempts >= MAX_PASSWORD_ATTEMPTS && await readPasswordRejection(page) !== "";
  return refused ? `The site refused the generated password ${state.attempts} times ("${said}"). The last one is saved with the login; do not retry, hand off to the user for this form.` : `The site refused the first generated password ("${said}"); a new one under looser rules was typed in (${tries} ${tries === 1 ? "retry" : "retries"}).`;
}
var PASSWORD_BOX, generated;
var init_password_retry = __esm({
  "src/agent/computer/password-retry.ts"() {
    "use strict";
    init_signup_login();
    init_password_policy();
    init_secret_scrubber();
    init_shared_state();
    PASSWORD_BOX = 'input[type="password"]:visible';
    generated = sharedState("generated-password", () => /* @__PURE__ */ new WeakMap());
  }
});

// src/agent/computer/login-error.ts
var LoginError;
var init_login_error = __esm({
  "src/agent/computer/login-error.ts"() {
    "use strict";
    LoginError = class extends Error {
    };
  }
});

// src/agent/computer/login-fields.ts
async function loginScope(page) {
  try {
    if (await page.locator("input:visible").count()) return page;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      if (await frame.locator("input:visible").count()) return frame;
    }
  } catch {
  }
  return page;
}
function safeLabel(value) {
  return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[account]").replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]").slice(0, 80);
}
async function loginFields(page) {
  const raw = await (await loginScope(page)).locator("input:visible").evaluateAll((inputs) => inputs.map((node, index) => {
    const input = node;
    const doc = globalThis.document;
    const labelled = input.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => doc.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
    return {
      index,
      type: input.type.toLowerCase(),
      autocomplete: input.autocomplete.toLowerCase(),
      name: input.name,
      id: input.id,
      required: input.required,
      label: input.getAttribute("aria-label") || labelled || [...input.labels ?? []].map((label) => label.textContent?.trim()).filter(Boolean).join(" ") || input.placeholder || ""
    };
  }));
  const keys = /* @__PURE__ */ new Map();
  return raw.slice(0, 30).flatMap((field) => {
    if (!["text", "email", "password", "tel", "number"].includes(field.type)) return [];
    const hint = `${field.label} ${field.name} ${field.id} ${field.autocomplete}`.toLowerCase();
    if (/captcha|search|coupon|promo|referral|invite|discount|zip|postal|country|area code/.test(hint)) return [];
    if (/new-password/.test(field.autocomplete)) return [];
    const password = field.type === "password" || /current-password|password/.test(hint);
    const code = !password && (/one-time-code/.test(field.autocomplete) || /one.time|\botp\b|\btotp\b|verification|security code|passcode|authenticator|\b2fa\b|\bmfa\b|\bcode\b/.test(hint));
    const key = code ? "code" : password ? "password" : /account[ -]?id|account[ -]?alias/.test(hint) ? "accountId" : field.type === "email" || /\bemail\b/.test(field.autocomplete) ? "email" : /username|identifier|email|phone|login/.test(hint) ? "username" : `field_${field.index + 1}`;
    const count = keys.get(key) ?? 0;
    keys.set(key, count + 1);
    const finalKey = count ? `${key}_${count + 1}` : key;
    const label = safeLabel(field.label || (key === "code" ? "Verification code" : key === "password" ? "Password" : key === "accountId" ? "Account ID" : key === "email" ? "Email" : key === "username" ? "Email or username" : field.name || field.id || "Login field"));
    return [{ index: field.index, key: finalKey, label, kind: password ? "password" : "text", required: field.required, ...code ? { transient: true } : {} }];
  });
}
function uniqueLabels(labels) {
  const seen = /* @__PURE__ */ new Map();
  return labels.map((label) => {
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return count === 1 ? label : `${label} (${count})`;
  });
}
var init_login_fields = __esm({
  "src/agent/computer/login-fields.ts"() {
    "use strict";
  }
});

// src/agent/computer/login-page.ts
function loginOutcomeMessage(outcome) {
  switch (outcome) {
    case "signed_in":
      return "Browser advanced beyond sign-in. ClikCode Secrets Manager is ready for this site.";
    case "session_reused":
      return "Browser advanced without asking for a password. An existing session may have been reused; no new login was saved.";
    case "verification_needed":
      return "Verification is still pending, so the new login was not saved. Approve it on your phone or finish it in the open browser, or use handoff to finish it from another device.";
    case "saved_login_rejected":
      return 'The site did not accept the saved password. Run login again and choose "Use a different account" to enter an updated one.';
    default:
      return "Sign-in could not be verified. The new login was not saved.";
  }
}
function checkedOrigin(url2) {
  const site = new URL(url2);
  if (site.protocol !== "https:" || site.username || site.password) throw new LoginError("Private login needs an HTTPS website.");
  return site.origin;
}
function onSite(url2, startUrl) {
  checkedOrigin(url2);
  return sameSite(url2, startUrl);
}
function signature(url2, fields) {
  return `${url2}
${fields.map((field) => `${field.index}:${field.key}:${field.label}`).join("|")}`;
}
async function visible(page) {
  try {
    return await loginFields(page);
  } catch {
    return [];
  }
}
async function loading(page) {
  try {
    return await page.evaluate(() => globalThis.document.readyState !== "complete");
  } catch {
    return false;
  }
}
async function progress(page, before, signal, nudge) {
  let deadline = STEP_POLLS;
  let nudged = !nudge;
  for (let poll = 0; poll < Math.min(deadline, MAX_POLLS); poll++) {
    if (signal?.aborted) throw new LoginError("Private login cancelled.");
    await page.waitForTimeout(250);
    if (signature(page.url(), await visible(page)) !== before) return true;
    if (!nudged && poll >= NUDGE_POLLS && !await loading(page)) {
      nudged = true;
      await nudge().catch(() => void 0);
    }
    if (poll + 1 >= deadline && deadline < MAX_POLLS && await loading(page)) deadline += 20;
  }
  return false;
}
async function pressSubmit(page) {
  const scope = await loginScope(page);
  const button = scope.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
  if (await button.count()) {
    await button.click({ timeout: 3e3 });
    return;
  }
  await scope.getByRole("button", { name: /^(sign in|log in|login|next|continue|submit|verify|confirm)\b/i }).first().click({ timeout: 3e3 });
}
function leftSignIn(startUrl, currentUrl) {
  if (currentUrl === startUrl) return false;
  const current = new URL(currentUrl);
  return current.protocol === "https:" && !AUTH_PATH.test(current.pathname);
}
async function loginComputerPage(input) {
  const startUrl = input.page.url();
  const origin = checkedOrigin(startUrl);
  let lastSubmit = Date.now() - 12e4;
  const accounts = await savedLoginsForSite(input.stateDir, startUrl);
  let id;
  let saved = {};
  let accountChosen = false;
  const supplied = {};
  let submitted = false;
  let submittedPassword = false;
  let sentSaved = false;
  const refused = async () => {
    if (id) await setLoginRejected(input.stateDir, startUrl, id, true);
    return "saved_login_rejected";
  };
  let codeAttempts = 0;
  let announcedVerification = false;
  let waited = 0;
  for (let step = 0; step < 10; step++) {
    if (input.signal?.aborted) throw new LoginError("Private login cancelled.");
    const url2 = input.page.url();
    const fields = await visible(input.page);
    if (fields.filter((field) => field.kind === "password").length > 1) throw new LoginError("Several password fields are visible. Use handoff.");
    if (fields.filter((field) => field.transient).length > 1) throw new LoginError("This page asks for a code in several boxes. Use handoff.");
    if (!fields.length) {
      if (submittedPassword && leftSignIn(startUrl, url2)) {
        if (Object.keys(supplied).length) {
          await saveLoginFields(input.stateDir, startUrl, supplied, id ?? accounts.find((account) => account.label === loginLabel(supplied))?.id);
        } else if (id && accounts.find((account) => account.id === id)?.rejected) await setLoginRejected(input.stateDir, startUrl, id, false);
        return "signed_in";
      }
      if (submitted && leftSignIn(startUrl, url2)) return "session_reused";
      if (!submitted && waited++ < 24) {
        await input.page.waitForTimeout(500);
        step--;
        continue;
      }
      if (!submitted) throw new LoginError("No sign-in form is visible. If a verification or CAPTCHA is showing, use handoff.");
      if (!announcedVerification) {
        input.onVerification?.();
        announcedVerification = true;
      }
      for (let poll = 0; poll < VERIFY_POLLS; poll++) {
        if (input.signal?.aborted) throw new LoginError("Private login cancelled.");
        await input.page.waitForTimeout(1e3);
        const nextFields = await visible(input.page);
        if (nextFields.length || leftSignIn(startUrl, input.page.url())) break;
        if (poll === VERIFY_POLLS - 1) return "verification_needed";
      }
      step--;
      continue;
    }
    if (!onSite(url2, startUrl)) return sentSaved && fields.some((field) => field.kind === "password") ? refused() : "unverified";
    if (submittedPassword && fields.some((field) => field.kind === "password")) {
      let gone = false;
      for (let poll = 0; poll < 32 && !gone; poll++) {
        await input.page.waitForTimeout(250);
        gone = !(await visible(input.page)).some((field) => field.kind === "password");
      }
      if (gone) {
        step--;
        continue;
      }
      return sentSaved ? refused() : "unverified";
    }
    if (codeAttempts >= CODE_ATTEMPTS && fields.some((field) => field.transient)) return "unverified";
    if (!accountChosen) {
      accountChosen = true;
      if (input.newAccount) id = void 0;
      else if (accounts.length > 1 || accounts[0]?.rejected) {
        const labels = uniqueLabels(accounts.map((account) => account.label));
        const answers = await input.ask(origin, [{ index: -1, key: "account", label: "Choose an account", kind: "choice", required: true, options: [...labels, NEW_ACCOUNT] }], input.signal);
        if (!answers || input.signal?.aborted) throw new LoginError("Private login cancelled.");
        id = accounts[labels.indexOf(answers.account)]?.id;
      } else id = accounts[0]?.id;
      saved = id ? await savedLoginFields(input.stateDir, startUrl, id) : {};
      if (id && accounts.find((account) => account.id === id)?.rejected) delete saved.password;
      step--;
      continue;
    }
    const codes = {};
    const needed = fields.filter((field) => field.transient || !saved[field.key] && !supplied[field.key]);
    const early = !fields.some((field) => field.kind === "password") && !saved.password && !supplied.password && needed.some((field) => ["email", "username", "accountId"].includes(field.key));
    if (early) needed.push({ index: -1, key: "password", label: "Password", kind: "password", required: true });
    if (input.mailCode) {
      for (const field of needed.filter((candidate) => candidate.transient)) {
        const code = await input.mailCode(lastSubmit - 5e3);
        if (code) {
          codes[field.key] = code;
          needed.splice(needed.indexOf(field), 1);
        }
      }
    }
    if (needed.length) {
      const answers = await input.ask(origin, needed, input.signal);
      if (!answers || input.signal?.aborted) throw new LoginError("Private login cancelled.");
      if (!onSite(input.page.url(), startUrl)) return "unverified";
      for (const field of needed) {
        if (!answers[field.key]) throw new LoginError("Complete the visible login fields.");
        if (field.transient) codes[field.key] = answers[field.key];
        else supplied[field.key] = answers[field.key];
      }
    }
    const before = signature(url2, fields);
    for (const field of fields) {
      if (!onSite(input.page.url(), startUrl)) return sentSaved && fields.some((candidate) => candidate.kind === "password") ? refused() : "unverified";
      await (await loginScope(input.page)).locator("input:visible").nth(field.index).fill(field.transient ? codes[field.key] : saved[field.key] ?? supplied[field.key]);
    }
    for (const key of Object.keys(codes)) delete codes[key];
    await (await loginScope(input.page)).locator("input:visible").nth(fields.at(-1).index).press("Enter");
    submitted = true;
    lastSubmit = Date.now();
    if (fields.some((field) => field.kind === "password")) {
      submittedPassword = true;
      if (saved.password && !supplied.password) sentSaved = true;
    }
    if (fields.some((field) => field.transient)) codeAttempts++;
    if (!await progress(input.page, before, input.signal, () => pressSubmit(input.page))) return sentSaved && (await visible(input.page)).some((field) => field.kind === "password") ? refused() : "unverified";
  }
  return "unverified";
}
var AUTH_PATH, NEW_ACCOUNT, STEP_POLLS, MAX_POLLS, NUDGE_POLLS, VERIFY_POLLS, CODE_ATTEMPTS;
var init_login_page = __esm({
  "src/agent/computer/login-page.ts"() {
    "use strict";
    init_credential_vault();
    init_login_error();
    init_login_fields();
    AUTH_PATH = /(?:^|\/)(?:login|signin|sign-in|auth|oauth|authenticate|challenge|verify|verification|mfa|otp|2fa|2sv|two-factor|sso|saml)(?:\/|$)/i;
    NEW_ACCOUNT = "Use a different account";
    STEP_POLLS = 60;
    MAX_POLLS = 240;
    NUDGE_POLLS = 12;
    VERIFY_POLLS = 600;
    CODE_ATTEMPTS = 2;
  }
});

// src/agent/computer/profile-login.ts
async function profileLoginAnswers(stateDir, fields) {
  if (!fields.length || fields.some((field) => field.transient || field.kind === "choice")) return void 0;
  const listed = await listProfiles(stateDir);
  const first = defaultProfile(listed);
  const profiles = first ? [first, ...listed.filter((profile) => profile !== first)] : listed;
  const email = profiles.map((profile) => profile.fields.sso_email ?? profile.fields.email).find(Boolean);
  const holder = profiles.find((profile) => profile.secrets?.[PASSWORD_SECRET]);
  const answers = {};
  for (const field of fields) {
    if (field.kind === "password" || field.key === "password") {
      const password = holder ? await readProfileSecret(stateDir, holder, PASSWORD_SECRET) : void 0;
      if (!password) return void 0;
      registerSecret(password);
      answers[field.key] = password;
    } else if (ACCOUNT_KEYS.has(field.key) && email) answers[field.key] = email;
    else return void 0;
  }
  return answers;
}
var ACCOUNT_KEYS;
var init_profile_login = __esm({
  "src/agent/computer/profile-login.ts"() {
    "use strict";
    init_profiles();
    init_secret_scrubber();
    ACCOUNT_KEYS = /* @__PURE__ */ new Set(["email", "username", "accountId"]);
  }
});

// src/agent/computer/work-queue.ts
var work_queue_exports = {};
__export(work_queue_exports, {
  TASK_KINDS: () => TASK_KINDS,
  TASK_REASONS: () => TASK_REASONS,
  TASK_STATUSES: () => TASK_STATUSES,
  describeTask: () => describeTask,
  listTasks: () => listTasks,
  saveTask: () => saveTask,
  summarizeTasks: () => summarizeTasks,
  taskId: () => taskId
});
import { createHash as createHash2 } from "node:crypto";
function taskId(vendor, kind) {
  const hex = createHash2("sha256").update(`${vendor.trim().toLowerCase()}|${kind}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
async function listTasks(stateDir, filter = {}) {
  return (await readVaultRecords(stateDir, FOLDER2)).map(({ id, value }) => ({ ...value, id })).filter((task) => (!filter.status || task.status === filter.status) && (!filter.reason || task.reason === filter.reason)).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.kind.localeCompare(b.kind));
}
async function saveTask(stateDir, input) {
  const vendor = input.vendor.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9 ._-]{0,59}$/.test(vendor)) throw new Error(`A vendor is a short name of letters and digits (got "${input.vendor}").`);
  const kind = input.kind ?? "oauth-app";
  if (!TASK_KINDS.includes(kind)) throw new Error(`Unknown task kind "${kind}". Kinds: ${TASK_KINDS.join(", ")}.`);
  if (input.status && !TASK_STATUSES.includes(input.status)) throw new Error(`Unknown status "${input.status}". Statuses: ${TASK_STATUSES.join(", ")}.`);
  if (input.reason && !TASK_REASONS.includes(input.reason)) throw new Error(`Unknown reason "${input.reason}". Reasons: ${TASK_REASONS.join(", ")}.`);
  const id = taskId(vendor, kind);
  const before = (await listTasks(stateDir)).find((task) => task.id === id);
  const status2 = input.status ?? before?.status ?? "queued";
  const reason = input.reason ?? (input.status && input.status !== before?.status && !["needs-human", "blocked"].includes(status2) ? void 0 : before?.reason);
  const connectors = input.connectors ? [.../* @__PURE__ */ new Set([...before?.connectors ?? [], ...input.connectors])].sort() : before?.connectors;
  const note = input.note !== void 0 ? input.note.trim().slice(0, MAX_NOTE) : before?.note;
  const owner = input.owner?.trim() || before?.owner;
  const saved = { vendor, kind, status: status2, ...reason ? { reason } : {}, ...note ? { note } : {}, ...owner ? { owner } : {}, ...connectors?.length ? { connectors } : {}, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
  await writeVaultRecord(stateDir, FOLDER2, id, saved);
  return { ...saved, id };
}
function describeTask(task) {
  return `${task.vendor} (${task.kind}): ${task.status}${task.reason ? ` [${task.reason}]` : ""}${task.owner ? `, owner ${task.owner}` : ""}${task.note ? ` \u2014 ${task.note}` : ""}`;
}
function summarizeTasks(tasks) {
  const by = /* @__PURE__ */ new Map();
  for (const task of tasks) by.set(task.status, (by.get(task.status) ?? 0) + 1);
  const waiting = /* @__PURE__ */ new Map();
  for (const task of tasks) if (task.status === "needs-human") waiting.set(task.reason ?? "other", (waiting.get(task.reason ?? "other") ?? 0) + 1);
  return `${tasks.length} tasks: ${TASK_STATUSES.filter((s) => by.get(s)).map((s) => `${by.get(s)} ${s}`).join(", ") || "none"}${waiting.size ? `. Waiting on you: ${[...waiting].map(([r, n]) => `${n} ${r}`).join(", ")}` : ""}.`;
}
var TASK_STATUSES, TASK_REASONS, TASK_KINDS, FOLDER2, MAX_NOTE;
var init_work_queue = __esm({
  "src/agent/computer/work-queue.ts"() {
    "use strict";
    init_credential_vault();
    TASK_STATUSES = ["queued", "working", "done", "needs-human", "blocked", "no-self-serve"];
    TASK_REASONS = ["captcha", "sms", "email", "payment", "identity", "review", "two-factor", "no-logo", "unsupported-protocol", "other"];
    TASK_KINDS = ["oauth-app", "api-key", "test-account", "webhook", "connector-proof", "other"];
    FOLDER2 = "task";
    MAX_NOTE = 500;
  }
});

// src/agent/computer/parking.ts
function vendorOf(site) {
  try {
    const parts = new URL(site).hostname.replace(/^www\./, "").split(".");
    const name = parts.length > 2 && ["co", "com", "org", "net"].includes(parts.at(-2)) ? parts.at(-3) : parts.at(-2) ?? parts[0];
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60) || "unknown";
  } catch {
    return "unknown";
  }
}
function reasonFor(fields) {
  const labels = fields.map((field) => field.label.toLowerCase()).join(" ");
  if (/captcha|robot|not a robot/.test(labels)) return "captcha";
  if (fields.some((field) => field.transient) || /\b(code|verification|authenticator|otp|2fa|two-factor)\b/.test(labels)) return "two-factor";
  if (/\b(phone|sms|text message)\b/.test(labels)) return "sms";
  return "other";
}
async function park(stateDir, site, fields, why) {
  const vendor = vendorOf(site);
  const asks = fields.map((field) => field.label).join(", ").slice(0, 200);
  await saveTask(stateDir, { vendor, kind: "other", status: "needs-human", reason: reasonFor(fields), note: `needs from you: ${asks}${why ? ` (${why})` : ""}` });
  throw new Parked(`Parked: ${vendor} needs ${asks} from the user${why ? ` (${why})` : ""}. It is recorded in the queue as needs-human. Do not ask the user; go on to the next vendor.`);
}
var Parked;
var init_parking = __esm({
  "src/agent/computer/parking.ts"() {
    "use strict";
    init_work_queue();
    Parked = class extends Error {
    };
  }
});

// src/agent/computer/page-dialogs.ts
async function withDialogs(page, accept, act2) {
  const seen = [];
  const onDialog = (dialog) => {
    seen.push(`${dialog.type()}: "${dialog.message().replace(/\s+/g, " ").slice(0, 200)}" (${accept ? "accepted" : "declined"})`);
    void (accept ? dialog.accept() : dialog.dismiss()).catch(() => void 0);
  };
  page.on("dialog", onDialog);
  try {
    const result = await act2();
    await page.waitForTimeout(300);
    return { result, dialogs: seen };
  } finally {
    page.off("dialog", onDialog);
  }
}
function dialogNote(dialogs, accepted) {
  if (!dialogs.length) return "";
  return ` The page showed a browser dialog: ${dialogs.join("; ")}.${accepted ? "" : " To answer yes, click again with accept_dialog true."}`;
}
var init_page_dialogs = __esm({
  "src/agent/computer/page-dialogs.ts"() {
    "use strict";
  }
});

// src/agent/computer/clipboard-watch.ts
function hookCopy() {
  const w = globalThis;
  if (w.__clikcodeCopied !== void 0) return;
  w.__clikcodeCopied = null;
  const clipboard = w.navigator.clipboard;
  if (clipboard) {
    const original = clipboard.writeText.bind(clipboard);
    clipboard.writeText = (text) => {
      w.__clikcodeCopied = String(text);
      return original(text);
    };
  }
  if (clipboard?.write) {
    const originalWrite = clipboard.write.bind(clipboard);
    clipboard.write = async (items) => {
      try {
        const item = items[0];
        const blob = await item?.getType?.("text/plain");
        if (blob) w.__clikcodeCopied = await blob.text();
      } catch {
      }
      return originalWrite(items);
    };
  }
  if (w.document.execCommand) {
    const originalExec = w.document.execCommand.bind(w.document);
    w.document.execCommand = (command, ...rest) => {
      if (command === "copy") {
        const selected = String(w.document.getSelection() ?? "");
        if (selected) w.__clikcodeCopied = selected;
      }
      return originalExec(command, ...rest);
    };
  }
  w.document.addEventListener("copy", () => {
    const selected = String(w.document.getSelection() ?? "");
    if (selected) w.__clikcodeCopied = selected;
  }, true);
}
function plausibleCopy(value) {
  const text = value?.trim();
  if (!text || text.length < 8 || text.length > 4096 || /\s/.test(text)) return void 0;
  return text;
}
function copyRank(label) {
  const text = label.toLowerCase();
  if (/secret|private|token|password|passphrase/.test(text)) return 3;
  if (/\b(?:id|identifier|name|url|uri|endpoint|region|email|username|user)\b/.test(text)) return 0;
  return /key|credential|bearer/.test(text) ? 2 : 1;
}
async function bestCopy(buttons) {
  const count = Math.min(await buttons.count(), 8);
  let best = 0;
  let bestRank = -1;
  let bestLabel = "";
  for (let index = 0; index < count; index++) {
    const near = await buttons.nth(index).evaluate((element) => {
      for (let node = element.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
        const text = (node.textContent ?? "").slice(0, 80);
        if (/key|token|secret|password|credential|bearer|\bid\b|name|url|endpoint/i.test(text)) return text;
      }
      return "";
    }).catch(() => "");
    const rank = copyRank(near);
    if (rank > bestRank) {
      best = index;
      bestRank = rank;
      bestLabel = LABEL_WORDS.exec(near)?.[0] ?? "";
    }
  }
  return { button: buttons.nth(best), label: bestLabel };
}
async function listenForCopies(page) {
  try {
    await page.addInitScript(hookCopy);
    await page.evaluate(hookCopy);
    await page.evaluate(() => {
      globalThis.__clikcodeCopied = null;
    });
  } catch {
  }
}
async function copiedSince(page) {
  return plausibleCopy(await page.evaluate(() => globalThis.__clikcodeCopied).catch(() => void 0));
}
async function readClipboard(page) {
  try {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  } catch {
  }
  return page.evaluate(async () => {
    try {
      return await globalThis.navigator.clipboard.readText();
    } catch {
      return void 0;
    }
  }).catch(() => void 0);
}
async function copyWithSiteButton(page, waitMs = 3e3) {
  const buttons = page.getByRole("button", { name: COPY_KEY_BUTTON }).filter({ hasNotText: COPIES_OTHER }).locator("visible=true");
  let label = "";
  let before;
  try {
    if (!await buttons.count()) return void 0;
    before = await readClipboard(page);
    const chosen = await bestCopy(buttons);
    label = chosen.label;
    await page.addInitScript(hookCopy);
    await page.evaluate(hookCopy);
    await page.evaluate(() => {
      globalThis.__clikcodeCopied = null;
    });
    await chosen.button.click({ timeout: 3e3 });
  } catch {
    return void 0;
  }
  for (let waited = 0; waited < waitMs; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const found = plausibleCopy(await page.evaluate(() => globalThis.__clikcodeCopied).catch(() => void 0));
    if (found) {
      await page.evaluate(() => {
        globalThis.__clikcodeCopied = null;
      }).catch(() => void 0);
      return { value: found, label };
    }
  }
  const after = plausibleCopy(await readClipboard(page));
  return after && after !== before?.trim() ? { value: after, label } : void 0;
}
var COPY_KEY_BUTTON, COPIES_OTHER, LABEL_WORDS;
var init_clipboard_watch = __esm({
  "src/agent/computer/clipboard-watch.ts"() {
    "use strict";
    COPY_KEY_BUTTON = /^copy\b(?: [\w'’-]+){0,5}?(?: to clipboard)?$/i;
    COPIES_OTHER = /\b(?:id|identifier|name|url|uri|link|curl|command|snippet|endpoint|email|address|username)\b/i;
    LABEL_WORDS = /\b(?:access key id|secret access key|secret key|client secret|client id|access key|api key|private key|key id|secret|token|password|passphrase)\b/i;
  }
});

// src/agent/computer/download-capture.ts
import fs8 from "node:fs/promises";
function watchDownload(page) {
  let reading;
  const read = async (download) => {
    try {
      const file3 = await download.path();
      if (!file3) return void 0;
      const info = await fs8.stat(file3);
      if (info.size > MAX_BYTES) return void 0;
      return (await fs8.readFile(file3, "utf8")).trim() || void 0;
    } catch {
      return void 0;
    } finally {
      await download.delete().catch(() => void 0);
    }
  };
  const onDownload = (download) => {
    reading ??= read(download);
  };
  page.on("download", onDownload);
  return {
    // Resolves with the file's text once a download has finished; undefined while there is none.
    result: async () => reading ? reading : void 0,
    stop: () => {
      page.off("download", onDownload);
    }
  };
}
function secretParts(content) {
  try {
    const parts = [];
    const walk2 = (node, field = "") => {
      if (typeof node === "string") {
        if (node.length >= 16 && SECRET_FIELD2.test(field)) parts.push(node);
      } else if (Array.isArray(node)) node.forEach((item) => walk2(item, field));
      else if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) walk2(child, key);
    };
    walk2(JSON.parse(content));
    return parts;
  } catch {
    return [];
  }
}
var MAX_BYTES, SECRET_FIELD2;
var init_download_capture = __esm({
  "src/agent/computer/download-capture.ts"() {
    "use strict";
    MAX_BYTES = 256 * 1024;
    SECRET_FIELD2 = /(?:private_key|secret|password|token|credential|api_?key)$/i;
  }
});

// src/agent/computer/key-check.ts
import { createSign } from "node:crypto";
async function status(recipe, key, fetcher) {
  const { url: url2, headers } = recipe.request(key);
  try {
    return (await fetcher(url2, { headers, signal: AbortSignal.timeout(8e3) })).status;
  } catch {
    return void 0;
  }
}
function serviceAccountOf(key) {
  try {
    const parsed = JSON.parse(key);
    return parsed.type === "service_account" && parsed.client_email && parsed.private_key ? { client_email: parsed.client_email, private_key: parsed.private_key } : void 0;
  } catch {
    return void 0;
  }
}
async function checkServiceAccount(account, fetcher, options) {
  const pause2 = options.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last = await tryServiceAccount(account, fetcher);
  for (let attempt = 1; options.fresh && last.verdict === "rejected" && /invalid_grant/.test(last.detail) && attempt < FRESH_TRIES; attempt++) {
    await pause2(FRESH_GAP_MS);
    last = await tryServiceAccount(account, fetcher);
  }
  return last;
}
async function tryServiceAccount(account, fetcher) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1e3);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: GOOGLE_TOKEN, iat: now, exp: now + 300 })}`;
  let assertion;
  try {
    assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url")}`;
  } catch {
    return { verdict: "rejected", service: "Google", detail: "the private key in the file is not a usable key" };
  }
  try {
    const response = await fetcher(GOOGLE_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }), signal: AbortSignal.timeout(8e3) });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.access_token) return { verdict: "works", service: "Google", detail: `Google gave ${account.client_email} an access token with it` };
    if (response.status === 400 || response.status === 401) return { verdict: "rejected", service: "Google", detail: `Google refused it (${body.error ?? `HTTP ${response.status}`}${body.error_description ? `: ${body.error_description}` : ""})` };
    return { verdict: "untested", service: "Google", detail: `Google answered HTTP ${response.status}, which does not show whether the key works` };
  } catch {
    return { verdict: "untested", service: "Google", detail: "Google could not be reached" };
  }
}
async function checkKey(pageUrl, key, fetcher = fetch, options = {}) {
  const account = serviceAccountOf(key);
  if (account) return checkServiceAccount(account, fetcher, options);
  let host;
  try {
    host = new URL(pageUrl).hostname;
  } catch {
    return { verdict: "untested", detail: "no check is known for this site" };
  }
  const recipe = RECIPES.find((candidate) => candidate.host.test(host));
  if (!recipe) return { verdict: "untested", detail: "no check is known for this site" };
  const rejects = recipe.rejects ?? [401, 403];
  const real = await status(recipe, key, fetcher);
  if (real === void 0) return { verdict: "untested", service: recipe.service, detail: `${recipe.service} could not be reached` };
  if (rejects.includes(real)) return { verdict: "rejected", service: recipe.service, detail: `${recipe.service} refused it (HTTP ${real})` };
  if (real !== 200) return { verdict: "untested", service: recipe.service, detail: `${recipe.service} answered HTTP ${real}, which does not show whether the key works` };
  const control = await status(recipe, `${key.slice(0, -3)}xyz`, fetcher);
  if (control !== void 0 && rejects.includes(control)) return { verdict: "works", service: recipe.service, detail: `${recipe.service} accepted it` };
  return { verdict: "untested", service: recipe.service, detail: `${recipe.service} answers a damaged key the same way, so this check proves nothing` };
}
var bearer, RECIPES, GOOGLE_TOKEN, FRESH_TRIES, FRESH_GAP_MS;
var init_key_check = __esm({
  "src/agent/computer/key-check.ts"() {
    "use strict";
    bearer = (url2) => (key) => ({ url: url2, headers: { Authorization: `Bearer ${key}` } });
    RECIPES = [
      { host: /(^|\.)huggingface\.co$/, service: "Hugging Face", request: bearer("https://huggingface.co/api/whoami-v2") },
      {
        host: /(^|\.)aistudio\.google\.com$/,
        service: "Google AI Studio",
        rejects: [400, 401, 403],
        request: (key) => ({ url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: { "x-goog-api-key": key } })
      },
      { host: /(^|\.)together\.(ai|xyz)$/, service: "Together AI", request: bearer("https://api.together.xyz/v1/models") },
      { host: /(^|\.)platform\.openai\.com$/, service: "OpenAI", request: bearer("https://api.openai.com/v1/models") },
      {
        host: /(^|\.)console\.anthropic\.com$/,
        service: "Anthropic",
        request: (key) => ({ url: "https://api.anthropic.com/v1/models", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
      },
      { host: /(^|\.)console\.groq\.com$/, service: "Groq", request: bearer("https://api.groq.com/openai/v1/models") },
      { host: /(^|\.)console\.mistral\.ai$/, service: "Mistral", request: bearer("https://api.mistral.ai/v1/models") },
      { host: /(^|\.)platform\.deepseek\.com$/, service: "DeepSeek", request: bearer("https://api.deepseek.com/models") },
      { host: /(^|\.)openrouter\.ai$/, service: "OpenRouter", request: bearer("https://openrouter.ai/api/v1/key") },
      // A 403 from these can mean "valid, but this key's scope does not include that call", so only 401 is a refusal.
      { host: /(^|\.)scaleway\.com$/, service: "Scaleway", rejects: [401], request: bearer("https://api.scaleway.ai/v1/models") },
      { host: /(^|\.)(fireworks\.ai)$/, service: "Fireworks", rejects: [401], request: bearer("https://api.fireworks.ai/inference/v1/models") },
      { host: /(^|\.)console\.x\.ai$/, service: "xAI", rejects: [400, 401], request: bearer("https://api.x.ai/v1/models") },
      { host: /(^|\.)dashboard\.cohere\.com$/, service: "Cohere", rejects: [401], request: bearer("https://api.cohere.com/v1/models") },
      { host: /(^|\.)replicate\.com$/, service: "Replicate", rejects: [401], request: bearer("https://api.replicate.com/v1/account") },
      { host: /(^|\.)cloud\.lambda(labs)?\.(ai|com)$/, service: "Lambda", rejects: [401, 403], request: bearer("https://cloud.lambdalabs.com/api/v1/instance-types") },
      { host: /(^|\.)my\.vultr\.com$/, service: "Vultr", rejects: [401], request: bearer("https://api.vultr.com/v2/account") },
      { host: /(^|\.)console\.hetzner\.(cloud|com)$/, service: "Hetzner", rejects: [401], request: bearer("https://api.hetzner.cloud/v1/servers?per_page=1") },
      // 403 here means a good key on an account with no credit; only 401 is a refused key.
      { host: /(^|\.)reka\.ai$/, service: "Reka", rejects: [401], request: bearer("https://api.reka.ai/v1/models") },
      { host: /(^|\.)publicai\.co$/, service: "Public AI", rejects: [401], request: (key) => ({ url: "https://api.publicai.co/v1/models", headers: { Authorization: `Bearer ${key}`, "User-Agent": "ClikCode/1.0" } }) },
      { host: /(^|\.)akashml\.com$/, service: "AkashML", rejects: [401], request: bearer("https://api.akashml.com/v1/models") },
      { host: /^github\.com$/, service: "GitHub", rejects: [401], request: bearer("https://api.github.com/user") }
    ];
    GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
    FRESH_TRIES = 8;
    FRESH_GAP_MS = 8e3;
  }
});

// src/agent/computer/secret-capture.ts
async function captureSecret(input) {
  const stop = new AbortController();
  let clicked = false;
  const outer = () => {
    if (!clicked) stop.abort();
  };
  input.signal?.addEventListener("abort", outer, { once: true });
  if (input.signal?.aborted) stop.abort();
  const finder = await armFinder(input.page, input.existing ?? !input.trigger);
  const download = watchDownload(input.page);
  await listenForCopies(input.page);
  const clipboardBefore = input.trigger ? (await readClipboard(input.page))?.trim() : void 0;
  try {
    let value;
    let via = "the page";
    const own = input.paste ? void 0 : (await input.readTarget?.().catch(() => void 0))?.trim();
    if (own && (keyShaped(own) || shortKeyText(own))) {
      value = own;
      via = "the text of the target itself";
    } else if (input.trigger) {
      clicked = true;
      await input.trigger();
    }
    let ambiguous = false;
    let presses = 0;
    for (let poll = 0; poll < (input.paste ? 0 : LOOK_POLLS) && !value; poll++) {
      if (!clicked && stop.signal.aborted) throw new LoginError("Not saved: capture was cancelled.");
      await input.page.waitForTimeout(500);
      value = await download.result();
      if (value) {
        via = "a file the site handed over";
        break;
      }
      value = await copiedSince(input.page);
      if (value) {
        via = "the Copy button that was pressed";
        break;
      }
      if (clicked) {
        const copied = plausibleCopy(await readClipboard(input.page));
        if (copied && copied !== clipboardBefore) {
          value = copied;
          via = "the clipboard after the click";
          break;
        }
      }
      const decision = await finder.look();
      if ((input.trigger || decision.kind !== "found") && presses < 2) {
        presses++;
        const copied = await copyWithSiteButton(input.page);
        if (copied) {
          value = copied.value;
          via = `the site's Copy button${copied.label ? ` next to "${copied.label}"` : ""}`;
        }
      }
      if (value) break;
      if (decision.kind === "found") {
        value = decision.value;
        via = "text on the page";
      } else if (decision.kind === "ambiguous") {
        ambiguous = true;
        break;
      }
    }
    const found = !!value;
    if (!value && input.paste) {
      value = await input.ask(input.name, `Copy the ${input.name} from the site. Paste it here`, input.signal ? AbortSignal.any([stop.signal, input.signal]) : stop.signal);
      if (!value) throw new LoginError("Not saved: no key was found and none was pasted.");
    }
    if (!value) {
      throw new LoginError(`Not saved: ${ambiguous ? "more than one possible key is on the page" : "the key could not be read from the page"}. Do not ask the user. Try another way: press the control that shows it ("Show", "Reveal", an eye icon) and capture that, target the Copy button or the text itself, or rotate/refresh the secret and capture straight away.`);
    }
    if (!found) via = "pasted by the user";
    registerSecret(value);
    for (const part of secretParts(value)) registerSecret(part);
    for (const other of await namedSecretNames(input.stateDir)) {
      if (other.toLowerCase() !== input.name.toLowerCase() && await readNamedSecret(input.stateDir, other).catch(() => void 0) === value) {
        throw new LoginError(`Not saved: this is the same value already saved as "${other}", not a different secret. Press the Copy button for the other value, or paste it.`);
      }
    }
    const check = await (input.check ?? ((url2, key, options) => checkKey(url2, key, fetch, options)))(input.page.url(), value, { fresh: clicked });
    if (check.verdict === "rejected" && !clicked) throw new LoginError(`Not saved: ${check.detail}. What was on the page is not a working key (it may be the key's id or another value).`);
    await saveNamedSecret(input.stateDir, input.name, value, input.meta);
    const sent = input.sendTo?.length && check.verdict !== "rejected" ? await sendToDestinations(input.stateDir, input.sendTo, value, input.signal) : [];
    return { length: value.length, found, shape: describeShape(value), via, check, sent };
  } catch (error) {
    throw clicked && error instanceof Error ? Object.assign(error, { afterClick: true }) : error;
  } finally {
    finder.dispose();
    download.stop();
    stop.abort();
    input.signal?.removeEventListener("abort", outer);
  }
}
function shortKeyText(text) {
  if (/^\d{20,100}$/.test(text)) return true;
  return text.length >= 12 && text.length <= 64 && /^[A-Za-z0-9_-]+$/.test(text) && /\d/.test(text) && /[A-Za-z]/.test(text);
}
function describeShape(value) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return "a UUID";
  if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value) && value.startsWith("eyJ")) return "a JWT";
  if (/^\s*\{/.test(value)) return "JSON";
  if (/^[0-9a-f]+$/i.test(value)) return "hexadecimal";
  if (/^[A-Z0-9]+$/.test(value)) return "upper-case letters and digits";
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return "letters and digits (base64-like)";
  return "mixed characters";
}
var LOOK_POLLS;
var init_secret_capture = __esm({
  "src/agent/computer/secret-capture.ts"() {
    "use strict";
    init_credential_vault();
    init_clipboard_watch();
    init_download_capture();
    init_login_error();
    init_key_check();
    init_secret_finder();
    init_secret_destinations();
    init_secret_scrubber();
    LOOK_POLLS = 20;
  }
});

// src/agent/computer/email-consumed.ts
import fs9 from "node:fs/promises";
import path9 from "node:path";
async function locked(stateDir, work) {
  const lock = `${file2(stateDir)}.lock`;
  await fs9.mkdir(path9.dirname(lock), { recursive: true, mode: 448 });
  for (let attempt = 0; ; attempt++) {
    try {
      (await fs9.open(lock, "wx")).close();
      break;
    } catch {
      const age = await fs9.stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > 1e4) await fs9.rm(lock, { force: true });
      else if (attempt > 200) throw new Error("The consumed-email record is busy.");
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await work();
  } finally {
    await fs9.rm(lock, { force: true });
  }
}
async function claimMessage(stateDir, id) {
  return locked(stateDir, async () => {
    let record = {};
    try {
      record = JSON.parse(await fs9.readFile(file2(stateDir), "utf8"));
    } catch {
    }
    const now = Date.now();
    for (const [key, at] of Object.entries(record)) if (now - at > KEEP_MS) delete record[key];
    if (record[id]) return false;
    record[id] = now;
    await fs9.writeFile(file2(stateDir), JSON.stringify(record), { mode: 384 });
    return true;
  });
}
async function isClaimed(stateDir, id) {
  try {
    return Boolean(JSON.parse(await fs9.readFile(file2(stateDir), "utf8"))[id]);
  } catch {
    return false;
  }
}
var KEEP_MS, file2;
var init_email_consumed = __esm({
  "src/agent/computer/email-consumed.ts"() {
    "use strict";
    KEEP_MS = 24 * 36e5;
    file2 = (stateDir) => path9.join(stateDir, "computer", "email-consumed.json");
  }
});

// src/agent/computer/email-api.ts
import { createHash as createHash3, randomBytes as randomBytes2 } from "node:crypto";
import http from "node:http";
async function emailClient(stateDir) {
  try {
    const client = JSON.parse(await readNamedSecret(stateDir, EMAIL_CLIENT_SECRET));
    if (client.clientId && client.clientSecret) return { clientId: client.clientId, clientSecret: client.clientSecret };
  } catch {
  }
  try {
    const clientId2 = await readNamedSecret(stateDir, `${EMAIL_CLIENT_SECRET}-id`), clientSecret2 = await readNamedSecret(stateDir, `${EMAIL_CLIENT_SECRET}-secret`);
    if (clientId2 && clientSecret2) return { clientId: clientId2, clientSecret: clientSecret2 };
  } catch {
  }
  const clientId = process.env.CLIKCODE_GOOGLE_CLIENT_ID, clientSecret = process.env.CLIKCODE_GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };
  throw new CredentialError(`No Google OAuth client is set up for email. Save a Desktop-app client as the secrets "${EMAIL_CLIENT_SECRET}-id" and "${EMAIL_CLIENT_SECRET}-secret" (or one JSON secret "${EMAIL_CLIENT_SECRET}") or set CLIKCODE_GOOGLE_CLIENT_ID and CLIKCODE_GOOGLE_CLIENT_SECRET.`);
}
async function stored(stateDir) {
  try {
    return JSON.parse(await readNamedSecret(stateDir, EMAIL_TOKEN_SECRET));
  } catch {
    return void 0;
  }
}
async function emailConnected(stateDir) {
  return await stored(stateDir) !== void 0;
}
async function startConsent(stateDir, options = {}) {
  const endpoints = options.endpoints ?? GOOGLE;
  const client = await emailClient(stateDir);
  const verifier = b64u(randomBytes2(32));
  const challenge = b64u(createHash3("sha256").update(verifier).digest());
  const state = b64u(randomBytes2(16));
  let finish, fail;
  const done = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  done.catch(() => void 0);
  const server = http.createServer((req, res) => {
    const url2 = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url2.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const page = (text) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>ClikCode</title><body style="font:16px system-ui;margin:3rem">${text}</body>`);
    };
    const code = url2.searchParams.get("code");
    if (url2.searchParams.get("state") !== state || !code) {
      page("Email was not connected. You can close this tab.");
      fail(new Error(url2.searchParams.get("error") ? `Google did not grant access (${url2.searchParams.get("error")}).` : "The redirect did not match this request."));
      return;
    }
    exchange(stateDir, client, code, verifier, redirect(server), endpoints).then(
      (email) => {
        page("Email connected. You can close this tab.");
        finish({ email });
      },
      (error) => {
        page("Email was not connected. You can close this tab.");
        fail(error);
      }
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const timer = setTimeout(() => fail(new Error("Consent was not completed in time.")), options.timeoutMs ?? 18e4);
  timer.unref();
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
  };
  done.then(close, close);
  const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirect(server), response_type: "code", scope: GMAIL_SCOPE, access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256", ...options.loginHint ? { login_hint: options.loginHint } : {} });
  return { url: `${endpoints.auth}?${params}`, done, cancel: () => fail(new Error("Consent was cancelled.")) };
}
function redirect(server) {
  return `http://127.0.0.1:${server.address().port}/callback`;
}
async function exchange(stateDir, client, code, verifier, redirectUri, endpoints) {
  const res = await fetch(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(2e4),
    body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: verifier })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google refused the code (${body.error ?? res.status}).`);
  if (!body.refresh_token) throw new Error("Google gave no refresh token; remove the app at myaccount.google.com/permissions and connect again.");
  const profile = await (await fetch(`${endpoints.gmail}/profile`, { headers: { authorization: `Bearer ${body.access_token}` }, signal: AbortSignal.timeout(2e4) })).json().catch(() => ({}));
  const email = profile.emailAddress ?? "";
  await saveNamedSecret(stateDir, EMAIL_TOKEN_SECRET, JSON.stringify({ refreshToken: body.refresh_token, email, connectedAt: (/* @__PURE__ */ new Date()).toISOString() }), { vendor: "gmail", owner: email, env: "oauth" });
  cached.set(stateDir, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3e3) * 1e3 - 6e4 });
  return email;
}
async function accessToken(stateDir, endpoints) {
  const hit = cached.get(stateDir);
  if (hit && hit.expires > Date.now()) return hit.token;
  const saved = await stored(stateDir);
  if (!saved) throw new CredentialError("No mailbox is connected. Run `clikcode computer email connect`, or the browser tool action email_connect.");
  const client = await emailClient(stateDir);
  const res = await fetch(endpoints.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(2e4),
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: saved.refreshToken, grant_type: "refresh_token" })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    if (body.error === "invalid_grant") throw new CredentialError("Google no longer accepts the saved mailbox consent (an app still in testing mode expires it after 7 days). Reconnect with `clikcode computer email connect`.");
    throw new Error(`Google would not refresh the mailbox token (${body.error ?? res.status}).`);
  }
  cached.set(stateDir, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3e3) * 1e3 - 6e4 });
  return body.access_token;
}
function collect(part, kind, out = []) {
  if (!part) return out;
  if (part.mimeType === kind && part.body?.data) out.push(decode(part.body.data));
  for (const child of part.parts ?? []) collect(child, kind, out);
  return out;
}
function htmlToText(html) {
  return html.replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
function hrefs(html) {
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&")).filter((href) => /^https:/.test(href));
}
function senderMatch(mail, site, options = {}) {
  const name = vendorOf(site);
  const forms2 = [.../* @__PURE__ */ new Set([name, name.replace(/-/g, ""), name.replace(/-/g, " ")])].filter((form) => form.length >= 3 && form !== "unknown");
  const from = mail.from.toLowerCase();
  const domain = /@([^>\s]+)/.exec(from)?.[1] ?? "";
  const display = from.replace(/<.*$/, "");
  const flat = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const inDomain = forms2.some((form) => domain.replace(/[^a-z0-9]/g, "").includes(form.replace(/[^a-z0-9]/g, "")));
  if (inDomain || forms2.some((form) => flat(display).includes(flat(form)))) return { tier: 1, domain };
  if (forms2.some((form) => flat(mail.subject).includes(flat(form)))) return { tier: 2, domain };
  if (forms2.some((form) => flat(mail.text.slice(0, options.widen ? BODY_START_WIDE : BODY_START)).includes(flat(form)))) return { tier: 3, domain };
  return { tier: 0, domain };
}
async function waitForEmail(stateDir, query) {
  if (!query.from && !query.subject && !query.site) throw new Error("Name the sender (from), words from the subject, or the site the email is for.");
  const endpoints = query.endpoints ?? GOOGLE;
  const since = query.since ?? Date.now() - 15 * 6e4;
  const q = [query.from ? `from:(${query.from})` : "", query.subject ? `subject:(${query.subject})` : "", `after:${Math.floor(since / 1e3) - 1}`].filter(Boolean).join(" ");
  const deadline = Date.now() + (query.timeoutMs ?? 9e4);
  for (; ; ) {
    query.signal?.throwIfAborted();
    const token = await accessToken(stateDir, endpoints);
    const headers = { authorization: `Bearer ${token}` };
    const list = await fetch(`${endpoints.gmail}/messages?${new URLSearchParams({ q, maxResults: query.site ? "20" : "5", ...query.spam ? { includeSpamTrash: "true" } : {} })}`, { headers, signal: AbortSignal.timeout(2e4) });
    if (!list.ok) throw new Error(`Gmail would not list messages (HTTP ${list.status}).`);
    const ids = (await list.json()).messages ?? [];
    let found = [];
    for (const { id } of ids) {
      if (query.consume && await isClaimed(stateDir, id)) continue;
      const res = await fetch(`${endpoints.gmail}/messages/${id}?format=full`, { headers, signal: AbortSignal.timeout(2e4) });
      if (!res.ok) continue;
      const message = await res.json();
      const header = (name) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
      const html = collect(message.payload, "text/html").join("\n");
      const plain = collect(message.payload, "text/plain").join("\n");
      found.push({ id, from: header("from"), subject: header("subject"), text: plain.trim() || htmlToText(html), links: hrefs(html || plain), receivedAt: Number(message.internalDate ?? 0) });
    }
    found = found.filter((mail) => mail.receivedAt >= since && (!query.accept || query.accept(mail)));
    if (query.site) {
      const widen = found.filter((mail) => !isMarketing(mail)).length === 1;
      const scored = found.map((mail) => ({ mail, ...senderMatch(mail, query.site, { widen }) })).filter((item) => item.tier > 0);
      const best = Math.min(...scored.map((item) => item.tier), 9);
      found = scored.filter((item) => item.tier === best).map((item) => item.mail);
      const senders = new Set(found.map((mail) => /@([^>\s]+)/.exec(mail.from.toLowerCase())?.[1] ?? mail.from));
      if (senders.size > 1) throw new EmailAmbiguous(`Emails from ${[...senders].slice(0, 3).join(" and ")} both fit ${vendorOf(query.site)}; not choosing between them.`);
    }
    for (const mail of found.sort((a, b) => b.receivedAt - a.receivedAt)) {
      if (!query.consume || await claimMessage(stateDir, mail.id)) return mail;
    }
    if (Date.now() >= deadline) throw new Error(`No email matched ${query.site ? `an email for ${vendorOf(query.site)}` : q} within ${Math.round((query.timeoutMs ?? 9e4) / 1e3)} seconds.`);
    await new Promise((resolve) => setTimeout(resolve, query.pollMs ?? 3e3));
  }
}
var EMAIL_TOKEN_SECRET, EMAIL_CLIENT_SECRET, GMAIL_SCOPE, GOOGLE, cached, b64u, decode, EmailAmbiguous, MARKETING, isMarketing, BODY_START, BODY_START_WIDE;
var init_email_api = __esm({
  "src/agent/computer/email-api.ts"() {
    "use strict";
    init_email_consumed();
    init_parking();
    init_credential_vault();
    EMAIL_TOKEN_SECRET = "email/gmail";
    EMAIL_CLIENT_SECRET = "email/google-client";
    GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
    GOOGLE = {
      auth: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      gmail: "https://gmail.googleapis.com/gmail/v1/users/me"
    };
    cached = /* @__PURE__ */ new Map();
    b64u = (bytes) => bytes.toString("base64url");
    decode = (data) => data ? Buffer.from(data, "base64url").toString("utf8") : "";
    EmailAmbiguous = class extends Error {
    };
    MARKETING = /newsletter|webinar|new features|what'?s new|promo|% off|sale\b|digest|unsubscribe from (?:these|all)|view (?:this )?in (?:your )?browser/i;
    isMarketing = (mail) => MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200));
    BODY_START = 400;
    BODY_START_WIDE = 1500;
  }
});

// src/agent/computer/email-code.ts
function verificationCode(text) {
  const flat = text.replace(/\s+/g, " ");
  const named = /\b(?:verification|security|confirmation|login|sign[- ]?in|one[- ]time|access)?\s*code\b[^A-Za-z0-9]{0,20}([A-Z0-9]{4,8})\b/i.exec(flat) ?? /\b([A-Z0-9]{4,8})\b[^.]{0,30}\bis your (?:\w+ )?code\b/i.exec(flat);
  if (named && /\d/.test(named[1])) return named[1];
  const sixes = [...new Set(flat.match(/(?<![\w.-])\d{6}(?![\w-])/g) ?? [])];
  return sixes.length === 1 ? sixes[0] : void 0;
}
function looksLikeCodeEmail(mail) {
  if (MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200))) return false;
  return verificationCode(mail.text) !== void 0 && CODE_WORDS.test(`${mail.subject} ${mail.text.slice(0, 300)}`);
}
function looksLikeLinkEmail(mail) {
  if (MARKETING.test(mail.subject) || MARKETING.test(mail.text.slice(0, 200))) return false;
  return mail.links.length > 0 && LINK_WORDS.test(`${mail.subject} ${mail.text.slice(0, 300)}`);
}
async function emailedCode(stateDir, options) {
  const passes = options.passes ?? 3, passMs = options.passMs ?? 3e4;
  for (let pass = 0; pass < passes; pass++) {
    try {
      const mail = await waitForEmail(stateDir, { site: options.site, since: options.since, timeoutMs: passMs, pollMs: options.pollMs, spam: pass > 0, consume: true, accept: looksLikeCodeEmail, signal: options.signal, endpoints: options.endpoints });
      return { code: verificationCode(mail.text) };
    } catch (error) {
      if (error instanceof EmailAmbiguous) return { hold: error.message };
      if (options.signal?.aborted) throw error;
      if (!/^No email matched/.test(error.message)) return { hold: error.message };
    }
  }
  return { hold: `no email with a code for ${vendorOf(options.site)} arrived in ${Math.round(passes * passMs / 1e3)} seconds (inbox, then spam, ${passes} passes)` };
}
async function holdForEmail(stateDir, site, why) {
  const vendor = vendorOf(site);
  await saveTask(stateDir, { vendor, kind: "other", status: "needs-human", reason: "email", note: `verification email: ${why}`.slice(0, 300) });
  throw new Parked(`On hold: ${vendor} verification email did not come (${why}). It is recorded in the queue as needs-human (email). Do not ask the user; go on to the next vendor.`);
}
async function codeFromMailbox(stateDir, site, since, signal) {
  if (!await emailConnected(stateDir)) return void 0;
  const found = await emailedCode(stateDir, { site, since, signal });
  if ("code" in found) return found.code;
  return holdForEmail(stateDir, site, found.hold);
}
var CODE_WORDS, LINK_WORDS;
var init_email_code = __esm({
  "src/agent/computer/email-code.ts"() {
    "use strict";
    init_email_api();
    init_parking();
    init_work_queue();
    CODE_WORDS = /\b(?:code|otp|passcode|pin|verify|verification|confirm(?:ation)?|one[- ]time|sign[- ]?in|log[- ]?in|security alert)\b/i;
    LINK_WORDS = /\b(?:verify|verification|confirm(?:ation)?|activate|activation|sign[- ]?in|log[- ]?in|magic|reset|set (?:your )?password|welcome|complete (?:your )?(?:sign|regist))/i;
  }
});

// src/agent/computer/email-consent.ts
async function stuckOn(page) {
  try {
    const url2 = new URL(page.url());
    const names = await page.locator("button:visible, [role=button]:visible, a:visible, [role=link]:visible").evaluateAll((nodes) => nodes.slice(0, 40).map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim()).filter((t) => t && t.length < 60));
    return `The browser is on ${url2.host}${url2.pathname}; it shows: ${[...new Set(names)].slice(0, 10).join(" | ") || "nothing to press"}.`;
  } catch {
    return "";
  }
}
async function connectEmail(stateDir, page, options = {}) {
  const consent = await startConsent(stateDir, { loginHint: options.email, endpoints: options.endpoints, timeoutMs: options.timeoutMs });
  let finished = false;
  consent.done.then(() => {
    finished = true;
  }, () => {
    finished = true;
  });
  await page.goto(consent.url, { waitUntil: "domcontentloaded", timeout: 3e4 }).catch(() => void 0);
  const click = async (locator) => {
    const shown = locator.filter({ visible: true });
    if (!await shown.count().catch(() => 0)) return false;
    return shown.first().click({ timeout: 3e3 }).then(() => true, () => false);
  };
  let chosen = "";
  const steps = (async () => {
    for (let i = 0; i < 90 && !finished; i++) {
      if (page.isClosed()) return;
      const url2 = page.url();
      if (/^http:\/\/127\.0\.0\.1:\d+\/callback/.test(url2)) return;
      if (options.email && chosen !== url2 && await click(page.locator(`[data-identifier="${options.email}"]`))) {
        chosen = url2;
        options.progress?.("Chose the account.\n");
      } else if (await click(page.getByRole("link", { name: /go to .*\(unsafe\)/i }))) options.progress?.("Continued past the unverified-app notice.\n");
      else if (await click(page.getByText(/^advanced$/i))) options.progress?.("");
      else if (await click(page.getByRole("button", { name: /^(continue|allow)$/i }))) options.progress?.("Allowed read access to mail.\n");
      await page.waitForTimeout(1e3).catch(() => void 0);
    }
  })();
  try {
    return await consent.done;
  } catch (error) {
    throw new Error(`${error.message} ${await stuckOn(page)}`);
  } finally {
    await steps.catch(() => void 0);
  }
}
var init_email_consent = __esm({
  "src/agent/computer/email-consent.ts"() {
    "use strict";
    init_email_api();
  }
});

// src/agent/computer/recipe-recorder.ts
function safeText(text, max = 80) {
  const one = text.replace(/\s+/g, " ").trim().replace(EMAIL, "{{sso_email}}");
  if (!one || one.length > max) return void 0;
  if (/\d{6,}|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(one)) return void 0;
  if (one.split(/\s+/).some((word) => keyShaped(word.replace(/^[("'`]+|[)"'`,.;]+$/g, "")))) return void 0;
  return one;
}
function recordableStep(step, label) {
  if (step.do === "scroll") return "skip";
  if (step.do === "wait") {
    if (!step.text) return "skip";
    const text = safeText(step.text, 60);
    return text ? { do: "wait", text, ...step.gone ? { gone: true } : {}, ...step.seconds ? { seconds: step.seconds } : {} } : "skip";
  }
  if (step.do === "press") return step.key ? { do: "press", key: step.key } : "skip";
  const raw = step.target?.trim();
  const name = raw && !REF2.test(raw) ? raw : label;
  const target = name ? safeText(name, 120) : void 0;
  if (!target) return "spoiled";
  const out = { do: step.do, target };
  if (step.at) out.at = step.at;
  if (step.accept_dialog) out.accept_dialog = true;
  if (step.do === "fill") return out;
  if (step.do === "upload") return step.text && /_file$/.test(step.text) ? { ...out, text: step.text } : "spoiled";
  if (step.do === "choose") {
    const text = step.text ? safeText(step.text, 60) : void 0;
    return text ? { ...out, text } : "spoiled";
  }
  return out;
}
function beginJournal(key, url2) {
  const host = hostOf(url2);
  if (!host) {
    journals.delete(key);
    return;
  }
  journals.set(key, { host, steps: [], visited: /* @__PURE__ */ new Set([host]), signedIn: false });
}
function noteStep(key, url2, step, label) {
  const journal = journals.get(key);
  if (!journal || journal.spoiled) return;
  const host = hostOf(url2);
  if (host) journal.visited.add(host);
  const saved = recordableStep(step, label);
  if (saved === "skip") return;
  if (saved === "spoiled") {
    journal.spoiled = `a ${step.do} step could not be named safely`;
    return;
  }
  if (recipeProblem({ steps: [saved], loginRoute: "email" })) {
    journal.spoiled = "a step looked like it held a secret";
    return;
  }
  if (journal.steps.length < 40) journal.steps.push(saved);
  else journal.spoiled = "too many steps";
}
async function recordVerified(stateDir, key, event, now = /* @__PURE__ */ new Date()) {
  const journal = journals.get(key);
  if (!journal || journal.spoiled) return void 0;
  const loginRoute = routeOf(journal);
  if (event.kind === "login") {
    journal.signedIn = true;
    if (!journal.steps.length) return void 0;
  }
  let keyPage;
  if (event.kind === "capture") {
    try {
      const u = new URL(event.url);
      keyPage = `${u.origin}${u.pathname}`;
    } catch {
      keyPage = void 0;
    }
  }
  const hint = event.kind === "capture" ? `${journal.signedIn ? "Sign in first with the login action (saved login). " : ""}${event.hint ?? "capture_secret reads the key the page shows."}` : void 0;
  const input = { host: normalizeHost(journal.host), loginRoute, steps: journal.steps.map((s) => ({ ...s })), ...keyPage ? { keyPage } : {}, ...hint ? { captureHint: hint } : {} };
  if (recipeProblem(input, { allowEmpty: true })) {
    delete input.keyPage;
    delete input.captureHint;
    if (recipeProblem(input, { allowEmpty: true })) return void 0;
  }
  if (event.kind === "login") {
    const existing = await getRecipe(stateDir, journal.host, loginRoute);
    if (existing && (existing.keyPage || existing.captureHint)) return void 0;
  }
  const saved = await saveRecipe(stateDir, input, now, { allowEmpty: true });
  if (event.kind === "capture") {
    journal.steps = [];
  }
  return saved;
}
var journals, REF2, EMAIL, hostOf, routeOf;
var init_recipe_recorder = __esm({
  "src/agent/computer/recipe-recorder.ts"() {
    "use strict";
    init_shared_state();
    init_secret_finder();
    init_signup_recipes();
    journals = sharedState("recipe-journals", () => /* @__PURE__ */ new Map());
    REF2 = /^(?:f\d+)?e\d+$/;
    EMAIL = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[A-Za-z]{2,}/g;
    hostOf = (url2) => {
      try {
        return new URL(url2).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        return "";
      }
    };
    routeOf = (journal) => journal.visited.has("accounts.google.com") ? "google" : journal.visited.has("github.com") ? "github" : "email";
  }
});

// src/agent/computer/oauth-consent.ts
import { spawn as spawn3 } from "node:child_process";
function readConsent(controls, pageText, options = {}) {
  if (classifyStuck(pageText) || detectBlocker(pageText) === "a captcha") return { consent: false };
  const names = (options.appNames ?? [PLATFORM_APP]).filter(Boolean);
  const lower = pageText.toLowerCase();
  const mentions = names.some((n) => lower.includes(n.toLowerCase())) || !!options.redirectHost && lower.includes(options.redirectHost.toLowerCase()) || controls.some((c) => !c.leaf && names.some((n) => c.name.toLowerCase().includes(n.toLowerCase())) && AFFIRMATIVE.test(c.name));
  if (!mentions) return { consent: false };
  const presses = controls.filter((c) => !c.leaf);
  if (!presses.some((c) => NEGATIVE.test(c.name))) return { consent: false };
  const index = controls.findIndex((c) => !c.leaf && c.name.length <= 100 && !NEVER.test(c.name) && AFFIRMATIVE.test(c.name));
  return index >= 0 ? { consent: true, index } : { consent: false };
}
function scopeTicks(boxes, pageText, options = {}) {
  if (!boxes.length || classifyStuck(pageText) || detectBlocker(pageText) === "a captcha") return [];
  const lower = pageText.toLowerCase();
  const names = (options.appNames ?? [PLATFORM_APP]).filter(Boolean);
  if (!(names.some((n) => lower.includes(n.toLowerCase())) || !!options.redirectHost && lower.includes(options.redirectHost.toLowerCase()))) return [];
  const scopes = boxes.filter((b) => !NOT_A_SCOPE.test(b.name));
  const all = scopes.find((b) => SELECT_ALL.test(b.name.trim()));
  if (all) return all.checked && scopes.every((b) => b.checked) ? [] : all.checked ? scopes.filter((b) => !b.checked).map((b) => b.index) : [all.index];
  return scopes.filter((b) => !b.checked).map((b) => b.index);
}
function nextPress(host, controls, pageText, options = {}) {
  const email = options.email?.trim().toLowerCase();
  if (email && !options.skipAccount) {
    const i = controls.findIndex((c) => c.name.toLowerCase().includes(email) && !NOT_CHOOSER.test(c.name));
    if (i >= 0) return { index: i, note: "Chose the account." };
  }
  if (classifyStuck(pageText)) return void 0;
  const table = [...providerFor(host)?.actions ?? [], ...GENERIC_ACTIONS];
  for (const action of table) {
    if (action.when && !action.when.test(pageText)) continue;
    const i = controls.findIndex((c) => (action.leaf || !c.leaf) && c.name.length <= 80 && !NEVER.test(c.name) && action.name.test(c.name));
    if (i >= 0) return { index: i, note: action.note, ...AFFIRMATIVE.test(controls[i].name) ? { consent: true } : {} };
  }
  const read = readConsent(controls, pageText, { ...options.appNames ? { appNames: options.appNames } : {}, ...options.redirectHost ? { redirectHost: options.redirectHost } : {} });
  if (read.consent && read.index !== void 0) return { index: read.index, note: "Granted access on the consent screen.", consent: true };
  for (const [rank, re] of SIGN_IN_PROVIDERS.entries()) {
    const i = controls.findIndex((c) => !c.leaf && re.test(c.name.replace(/\s*last used\s*$/i, "").trim()));
    if (i >= 0) return { index: i, note: rank === 0 ? "Signed in with Google." : "Signed in with GitHub." };
  }
  return void 0;
}
function decideSelectors(selectors) {
  const choose = [];
  for (const [i, s] of selectors.entries()) {
    if (s.selected) continue;
    if (s.options.length === 1) {
      choose.push({ selector: i, option: s.options[0] });
      continue;
    }
    return { stop: `The consent page needs a choice${s.label ? ` ("${s.label}")` : ""} and offers ${s.options.length ? `${s.options.length} options: ${s.options.slice(0, 12).join(" | ")}` : "none"}. Nothing was pressed; tell me which one to use.` };
  }
  return { choose };
}
function stopReason(pageText, hasPasswordBox, hasCodeBox) {
  const blocker = detectBlocker(pageText);
  if (blocker === "a captcha") return "a captcha";
  if (hasPasswordBox) return "a login password (sign in first with the login action, which uses the saved login or Google)";
  if (hasCodeBox || blocker === "an SMS or authenticator code") return "a verification code (MFA)";
  return void 0;
}
function callbackState(url2, redirectUri, pageText) {
  let here;
  try {
    here = new URL(url2);
  } catch {
    return "elsewhere";
  }
  let target;
  try {
    target = redirectUri ? new URL(redirectUri) : void 0;
  } catch {
    target = void 0;
  }
  const onCallback = target ? here.origin === target.origin && here.pathname === target.pathname : /\/oauth\/callback\b|\/callback\b/.test(here.pathname);
  if (!onCallback) return "elsewhere";
  if (/\b(error|denied|failed|invalid|expired|not connected|something went wrong)\b/i.test(pageText) && !/\bconnected\b/i.test(pageText.replace(/not connected/gi, ""))) return "problem";
  if (/\b(connected|success|successfully|authori[sz]ed|you can (?:now )?close|all set)\b/i.test(pageText)) return "connected";
  return "waiting";
}
function jsonOf(text) {
  const start = text.indexOf("{");
  if (start < 0) return void 0;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return void 0;
  }
}
function isErrorDocument(value) {
  if (!value || typeof value !== "object") return false;
  const v = value;
  return v.success === false || v.status === "error" || typeof v.type === "string" && ERROR_ADDRESS.test(v.type) || typeof v.error === "string" || typeof v.status === "number" && v.status >= 400;
}
function authorizationUrl(text) {
  const json = jsonOf(text);
  if (json !== void 0) {
    if (isErrorDocument(json)) return void 0;
    const walk2 = (value) => {
      if (value && typeof value === "object") {
        const record = value;
        for (const key of URL_KEYS) {
          const v = record[key];
          if (typeof v === "string" && /^https?:\/\//.test(v) && !ERROR_ADDRESS.test(v)) return v;
        }
        for (const v of Object.values(record)) {
          const found2 = walk2(v);
          if (found2) return found2;
        }
      }
      return void 0;
    };
    const found = walk2(json);
    if (found) return found;
  }
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    const url2 = m[0].replace(/[.,;)]+$/, "");
    if (!ERROR_ADDRESS.test(url2)) return url2;
  }
  return void 0;
}
function startFailure(text) {
  const json = jsonOf(text);
  const pick = (v) => typeof v === "string" && v.trim() ? v.split("\n")[0].trim() : void 0;
  const said = json && typeof json === "object" ? pick(json.message) ?? pick(json.detail) ?? pick(json.error) ?? pick(json.title) : void 0;
  return said ?? text.trim().split("\n").slice(-3).join(" ").slice(0, 200);
}
function startViaCli(connector, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn3("clikdeploy", ["integrations", "connect", connector, "--no-browser"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let text = "";
    let settled = false;
    const stop = () => {
      child.kill();
    };
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        stop();
        reject(new Error("ClikDeploy did not return an authorization URL within a minute."));
      }
    }, 6e4);
    const look = (final) => {
      if (settled) return;
      const url2 = authorizationUrl(text);
      if (url2) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: url2, stop });
        return;
      }
      if (final) {
        settled = true;
        clearTimeout(timer);
        const said = startFailure(text);
        reject(new Error(`ClikDeploy would not start the connection for ${connector}: ${scrubSecrets(said) || "no answer"}`));
      }
    };
    const feed = (chunk) => {
      text = (text + String(chunk)).slice(-2e4);
      look(false);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(error.code === "ENOENT" ? "The clikdeploy command is not installed on this computer." : error.message));
    });
    child.once("close", () => look(true));
    signal?.addEventListener("abort", stop, { once: true });
  });
}
async function readControls(page) {
  return page.evaluate(({ pressable }) => {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const doc = globalThis.document;
    const all = Array.from(doc.querySelectorAll(`${pressable}, span, div, p, li, label`)).slice(0, 1500);
    for (const n of all) {
      if (!n.getClientRects().length) continue;
      const isPress = n.matches(pressable);
      if (!isPress && n.children.length) continue;
      const text = (n.getAttribute("aria-label") || n.value || n.textContent || "").replace(/\s+/g, " ").trim();
      const ident = n.getAttribute("data-identifier") || n.getAttribute("data-email") || "";
      const name = (ident && !text.includes(ident) ? `${text} ${ident}` : text).trim();
      if (!name || name.length > 120) continue;
      const key = `${isPress}|${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, leaf: !isPress });
    }
    return out;
  }, { pressable: PRESSABLE });
}
async function readSelectors(page) {
  const found = [];
  const natives = await page.evaluate(() => {
    const doc = globalThis.document;
    return Array.from(doc.querySelectorAll("select")).filter((n) => n.getClientRects().length).map((n) => {
      const label = (n.getAttribute("aria-label") || n.labels?.[0]?.textContent || "").replace(/\s+/g, " ").trim();
      const options = Array.from(n.options).map((o) => ({ text: String(o.textContent ?? "").replace(/\s+/g, " ").trim(), value: String(o.value ?? ""), selected: !!o.selected, disabled: !!o.disabled }));
      return { label, options };
    });
  }).catch(() => []);
  for (const n of natives) {
    const real = n.options.filter((o) => o.value !== "" && !o.disabled && !PLACEHOLDER.test(o.text));
    const chosen = n.options.find((o) => o.selected && o.value !== "" && !PLACEHOLDER.test(o.text));
    found.push({ label: n.label, options: real.map((o) => o.text), ...chosen ? { selected: chosen.text } : {} });
  }
  const boxes = page.locator("[role=combobox]:visible, button[aria-haspopup=listbox]:visible");
  const count = Math.min(await boxes.count().catch(() => 0), 4);
  for (let i = 0; i < count; i++) {
    const box = boxes.nth(i);
    const shown = (await box.innerText({ timeout: 1e3 }).catch(() => "") || "").replace(/\s+/g, " ").trim();
    const label = (await box.getAttribute("aria-label").catch(() => "") || "").trim();
    if (shown && !PLACEHOLDER.test(shown)) {
      found.push({ label, options: [shown], selected: shown });
      continue;
    }
    await box.click({ timeout: 2e3 }).catch(() => void 0);
    const options = (await page.locator("[role=option]:visible").allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t && !PLACEHOLDER.test(t));
    await page.keyboard.press("Escape").catch(() => void 0);
    found.push({ label: label || shown, options });
  }
  return found;
}
async function settleSelectors(page) {
  const selectors = await readSelectors(page);
  const plan = decideSelectors(selectors);
  if ("stop" in plan) return plan.stop;
  for (const { selector, option } of plan.choose) {
    const native = page.locator("select:visible");
    const n = await native.count().catch(() => 0);
    if (selector < n) {
      await native.nth(selector).selectOption({ label: option }).catch(() => void 0);
      continue;
    }
    const boxes = page.locator("[role=combobox]:visible, button[aria-haspopup=listbox]:visible");
    await boxes.nth(selector - n).click({ timeout: 2e3 }).catch(() => void 0);
    await page.getByRole("option", { name: option }).first().click({ timeout: 2e3 }).catch(() => void 0);
  }
  return void 0;
}
async function readScopeBoxes(page) {
  return page.evaluate((selector) => {
    const doc = globalThis.document;
    const out = [];
    Array.from(doc.querySelectorAll(selector)).forEach((n, index) => {
      const holder = n.closest?.("label") ?? n.parentElement;
      if (!n.getClientRects().length && !holder?.getClientRects().length) return;
      const text = String(n.getAttribute("aria-label") || n.labels?.[0]?.textContent || holder?.textContent || n.parentElement?.parentElement?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
      out.push({ index, name: text, checked: n.checked === true || n.getAttribute("aria-checked") === "true" });
    });
    return out;
  }, BOXES);
}
async function tickScopes(page, text, options) {
  const boxes = await readScopeBoxes(page).catch(() => []);
  const plan = scopeTicks(boxes, text, options);
  if (!plan.length) return { ticked: 0 };
  for (const index of plan) {
    const box = page.locator(BOXES).nth(index);
    const done = await box.click({ timeout: 2e3, force: true }).then(() => true, () => false);
    if (!done) await box.evaluate((n) => n.click()).catch(() => void 0);
  }
  await page.waitForTimeout(300).catch(() => void 0);
  const after = await readScopeBoxes(page).catch(() => []);
  const left = after.filter((b) => !b.checked && !NOT_A_SCOPE.test(b.name));
  for (const b of left.filter((b2) => !SELECT_ALL.test(b2.name.trim()))) await page.locator(BOXES).nth(b.index).click({ timeout: 2e3, force: true }).catch(() => void 0);
  const final = left.length ? await readScopeBoxes(page).catch(() => []) : after;
  if (!scopesTicked(final)) return { stop: `The consent page has scope checkboxes that would not tick (${final.filter((b) => !b.checked).map((b) => b.name).slice(0, 6).join(" | ")}). Nothing was pressed.` };
  return { ticked: plan.length };
}
async function press(page, control) {
  const exact = control.name;
  const candidates = control.leaf ? [page.getByText(exact, { exact: true })] : [page.getByRole("button", { name: exact, exact: true }), page.getByRole("link", { name: exact, exact: true }), page.locator(PRESSABLE).filter({ hasText: exact }), page.getByText(exact, { exact: true })];
  for (const base of candidates) {
    const shown = base.filter({ visible: true });
    if (!await shown.count().catch(() => 0)) continue;
    if (await shown.first().click({ timeout: 3e3 }).then(() => true, () => false)) return true;
  }
  return false;
}
function classifyStuck(pageText) {
  if (UNRECOGNIZED_CLIENT.test(pageText)) return { kind: "unrecognized-client", label: "the vendor does not recognize the OAuth client (its app registration is missing or wrong; register the app by hand)" };
  if (NO_CREDITS.test(pageText)) return { kind: "payment", label: "the vendor wants payment, credits or a plan before it will continue", reason: "payment" };
  const blocker = detectBlocker(pageText);
  if (blocker === "a captcha") return { kind: "captcha", label: "a captcha" };
  if (blocker === "an SMS or authenticator code") return { kind: "mfa", label: "a verification code (MFA or SMS)" };
  if (blocker === "a payment page") return { kind: "payment", label: "a payment page", reason: "payment" };
  return void 0;
}
function pageExcerpt(text, max = 300) {
  return scrubSecrets(text).replace(/\s+/g, " ").replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]").replace(/[A-Za-z0-9_\-.~+/=]{32,}/g, "[token]").trim().slice(0, max);
}
function jsonErrorBody(text) {
  const t = text.trim();
  if (!t.startsWith("{")) return void 0;
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== "object" || !("message" in v || "error" in v || "error_description" in v || "errors" in v)) return void 0;
    return pageExcerpt(t);
  } catch {
    return void 0;
  }
}
function stuckOn2(page, controls, pageText = "") {
  try {
    const url2 = new URL(page.url());
    const names = [...new Set(controls.filter((c) => !c.leaf && !c.name.includes("@")).map((c) => c.name))].slice(0, 10);
    const json = jsonErrorBody(pageText);
    const excerpt = json ?? pageExcerpt(pageText);
    const kind = classifyStuck(pageText);
    return `The browser is on ${url2.host}${url2.pathname}; it shows: ${scrubSecrets(names.join(" | ")) || "nothing to press"}.${excerpt ? ` Page ${json ? "JSON error" : "text"}: "${excerpt}".` : ""}${kind ? ` This looks like ${kind.label}.` : ""}`;
  } catch {
    return "";
  }
}
function stopDetail(page, controls, pageText, kind) {
  let url2 = "";
  try {
    const u = new URL(page.url());
    url2 = `${u.origin}${u.pathname}`;
  } catch {
  }
  const known = classifyStuck(pageText)?.kind;
  return {
    kind: kind ?? known ?? "unknown",
    url: url2,
    pageText: jsonErrorBody(pageText) ?? pageExcerpt(pageText),
    controls: [...new Set(controls.filter((c) => !c.leaf && !c.name.includes("@")).map((c) => scrubSecrets(c.name)))].slice(0, 12)
  };
}
async function oauthConnect(connector, page, options = {}) {
  try {
    return await driveConsent(connector, page, options);
  } catch (error) {
    if (error instanceof ConsentStop && error.reason === "payment" && options.stateDir) {
      const saved = await saveTask(options.stateDir, { vendor: connector, kind: "oauth-app", status: "needs-human", reason: "payment", note: `oauth_connect stopped: ${error.message}`, connectors: [connector] }).then(() => true, () => false);
      if (saved) throw new ConsentStop(`${error.message} Recorded in the human queue as needs-human [payment].`, "payment", error.detail);
    }
    throw error;
  }
}
async function driveConsent(connector, page, options) {
  if (!CONNECTOR_ID.test(connector)) throw new Error("oauth_connect needs target: a connector id such as slack or github.");
  const started = await (options.start ?? startViaCli)(connector, options.signal);
  const status2 = options.status ?? ((id, signal) => connectionState(id, signal));
  const steps = [];
  try {
    let redirectUri;
    try {
      redirectUri = new URL(started.url).searchParams.get("redirect_uri") ?? void 0;
    } catch {
      redirectUri = void 0;
    }
    await page.goto(started.url, { waitUntil: "domcontentloaded", timeout: 3e4 }).catch(() => void 0);
    const deadline = Date.now() + (options.timeoutMs ?? 12e4);
    let idle = 0, stopSeen = 0, chosenOn = "", lastPress = { key: "", at: 0 }, controls = [], lastText = "";
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw new Error("Stopped.");
      if (page.isClosed()) throw new ConsentStop("The browser tab was closed before consent finished.");
      const url2 = page.url();
      const text = await page.evaluate(() => (globalThis.document.body?.innerText ?? "").slice(0, 6e3)).catch(() => "");
      lastText = text;
      const at = callbackState(url2, redirectUri, text);
      if (at === "problem") throw new ConsentStop(`The callback page reported a problem instead of a connection (${new URL(url2).host}${new URL(url2).pathname}). Check the consent was allowed and try again.`);
      if (at === "connected" || at === "waiting") {
        let last = "";
        for (let tries = 0; tries < 8; tries++) {
          const state = await status2(connector, options.signal);
          if (state.connected) {
            steps.push("Confirmed: ClikDeploy shows an active connection.");
            return { connector, steps };
          }
          last = state.reason ?? "";
          await page.waitForTimeout(2500).catch(() => void 0);
        }
        throw new ConsentStop(`The callback page was reached but ClikDeploy shows no active connection${last ? ` (${scrubSecrets(last)})` : ""}.`);
      }
      const hasPassword = await page.locator("input[type=password]:visible").count().catch(() => 0) > 0;
      const hasCode = await page.locator("input[autocomplete=one-time-code]:visible").count().catch(() => 0) > 0;
      const why = stopReason(text, hasPassword, hasCode);
      controls = await readControls(page).catch(() => []);
      if (why) {
        if (++stopSeen >= 2) throw new ConsentStop(`Stopped at ${why}. Nothing was typed. ${stuckOn2(page, controls, text)}`, classifyStuck(text)?.reason, stopDetail(page, controls, text, hasPassword ? "password" : hasCode ? "mfa" : void 0));
      } else {
        stopSeen = 0;
        const host = (() => {
          try {
            return new URL(url2).hostname;
          } catch {
            return "";
          }
        })();
        const next = nextPress(options.providerHost ?? host, controls, text, { ...options.email ? { email: options.email } : {}, skipAccount: chosenOn === url2, ...redirectUri ? { redirectHost: (() => {
          try {
            return new URL(redirectUri).host;
          } catch {
            return "";
          }
        })() } : {} });
        const control = next && controls[next.index];
        if (next && control && !(lastPress.key === `${url2}|${control.name}` && Date.now() - lastPress.at < 2500)) {
          if (next.note === "Chose the account.") chosenOn = url2;
          if (next.note !== "Chose the account." && next.note !== "Opened Advanced." && next.note !== "Continued past the unverified-app notice.") {
            const redirectHost = (() => {
              try {
                return redirectUri ? new URL(redirectUri).host : void 0;
              } catch {
                return void 0;
              }
            })();
            const ticks = await tickScopes(page, text, redirectHost ? { redirectHost } : {});
            if ("stop" in ticks) throw new ConsentStop(`${ticks.stop} ${stuckOn2(page, controls, text)}`);
            if (ticks.ticked) {
              steps.push("Ticked the scope checkboxes.");
              options.progress?.("Ticked the scope checkboxes.\n");
            }
          }
          if (next.consent) {
            const blocked = await settleSelectors(page);
            if (blocked) throw new ConsentStop(`${blocked} ${stuckOn2(page, controls, text)}`, void 0, stopDetail(page, controls, text, "choice"));
          }
          if (await press(page, control)) {
            lastPress = { key: `${url2}|${control.name}`, at: Date.now() };
            steps.push(next.note);
            options.progress?.(`${next.note}
`);
            idle = 0;
          }
        } else {
          const kind = classifyStuck(text);
          if (++idle >= (kind ? 3 : 15)) throw new ConsentStop(`Stopped at ${kind ? kind.label : "a screen it does not recognize"}. ${stuckOn2(page, controls, text)}`, kind?.reason, stopDetail(page, controls, text));
        }
      }
      await page.waitForTimeout(700).catch(() => void 0);
    }
    {
      const kind = classifyStuck(lastText);
      throw new ConsentStop(`Consent did not finish in time. ${stuckOn2(page, controls, lastText)}`, kind?.reason, stopDetail(page, controls, lastText));
    }
  } finally {
    started.stop();
  }
}
var NEVER, CONSENT_PROVIDERS, GENERIC_ACTIONS, providerFor, NOT_CHOOSER, PLATFORM_APP, AFFIRMATIVE, NEGATIVE, SELECT_ALL, NOT_A_SCOPE, scopesTicked, SIGN_IN_PROVIDERS, CONNECTOR_ID, ERROR_ADDRESS, URL_KEYS, PRESSABLE, PLACEHOLDER, BOXES, UNRECOGNIZED_CLIENT, NO_CREDITS, ConsentStop;
var init_oauth_consent = __esm({
  "src/agent/computer/oauth-consent.ts"() {
    "use strict";
    init_secret_scrubber();
    init_signup_recipes();
    init_secret_destinations();
    init_work_queue();
    NEVER = /\b(deny|cancel|decline|reject|no thanks|not now|sign out|log ?out|remove|delete|back|create (?:an )?account|sign ?up|forgot)\b/i;
    CONSENT_PROVIDERS = [
      { id: "google", host: /(^|\.)accounts\.google\.com$|(^|\.)google\.com$/i, actions: [
        { note: "Continued past the unverified-app notice.", name: /^go to .*\(unsafe\)$/i },
        { note: "Opened Advanced.", name: /^advanced$/i, leaf: true },
        { note: "Allowed access.", name: /^(continue|allow|allow all)$/i },
        { note: "Acknowledged the notice.", name: /^i understand$/i }
      ] },
      { id: "microsoft", host: /(^|\.)(login\.microsoftonline\.com|login\.live\.com|microsoft\.com)$/i, actions: [
        { note: "Accepted the permissions.", name: /^accept$/i },
        { note: "Declined to stay signed in.", name: /^no$/i, when: /stay signed in/i }
      ] },
      { id: "github", host: /(^|\.)github\.com$/i, actions: [
        { note: "Authorized the app.", name: /^authori[sz]e\b[\w .-]{0,60}$/i }
      ] },
      { id: "slack", host: /(^|\.)slack\.com$/i, actions: [
        { note: "Allowed access.", name: /^(allow|authori[sz]e)$/i }
      ] },
      { id: "atlassian", host: /(^|\.)(atlassian\.com|atlassian\.net)$/i, actions: [
        { note: "Accepted access.", name: /^(accept|allow access)$/i }
      ] },
      { id: "notion", host: /(^|\.)notion\.(so|com)$/i, actions: [
        { note: "Allowed access.", name: /^(allow access|select pages|grant access)$/i }
      ] }
    ];
    GENERIC_ACTIONS = [
      { note: "Allowed access.", name: /^(allow( access)?|authori[sz]e( (app|access))?|accept|accept and continue|grant access|approve)$/i },
      { note: "Continued on the permission screen.", name: /^continue$/i, when: /\b(access|permissions?|authori[sz]e|wants to|allow)\b/i }
    ];
    providerFor = (host) => CONSENT_PROVIDERS.find((p) => p.host.test(host));
    NOT_CHOOSER = /\b(sign out|log ?out|switch|remove|use another|add (?:an )?account|different account)\b/i;
    PLATFORM_APP = "ClikDeploy";
    AFFIRMATIVE = /^(?:authori[sz]e(?: [\w .'&-]{1,60})?|allow(?: access| all)?|approve(?: [\w .'&-]{1,40})?|accept(?: and continue)?|grant(?: access| permission)?|continue as [\w .'@+-]{1,80})$/i;
    NEGATIVE = /^(?:cancel|deny|decline|reject|no,? thanks|not now|do not allow)$/i;
    SELECT_ALL = /^select all\b/i;
    NOT_A_SCOPE = /\b(newsletter|marketing|promotion|offers?|subscribe|remember|keep me|stay signed|don'?t ask|do not ask|terms|privacy|robot|human)\b/i;
    scopesTicked = (boxes) => boxes.filter((b) => !NOT_A_SCOPE.test(b.name)).every((b) => b.checked);
    SIGN_IN_PROVIDERS = [/^(?:continue|sign ?(?:in|up)|log ?in)\s+(?:in\s+)?(?:with|using|via)\s+google\b/i, /^(?:continue|sign ?(?:in|up)|log ?in)\s+(?:in\s+)?(?:with|using|via)\s+github\b/i];
    CONNECTOR_ID = /^[A-Za-z0-9][\w.-]{0,60}$/;
    ERROR_ADDRESS = /^https?:\/\/errors\.clikdeploy\.com(?:\/|$)/i;
    URL_KEYS = ["authorizationUrl", "authorization_url", "authorizeUrl", "url"];
    PRESSABLE = "button, [role=button], a, [role=link], input[type=submit], input[type=button], summary, [data-identifier], [data-email], [data-test-id], [onclick]";
    PLACEHOLDER = /^(?:select|choose|pick|-+|—|–)\b|^$/i;
    BOXES = "input[type=checkbox], [role=checkbox]";
    UNRECOGNIZED_CLIENT = /unrecogni[sz]ed[\s_-]*client|unknown[\s_-]*client|invalid[_\s-]*client|client[_\s-]*id[^.\n]{0,40}(?:not found|invalid|unknown|unrecogni|does not exist)|no such (?:oauth )?(?:client|app)|(?:oauth )?(?:client|app) (?:not found|does not exist|is not registered)/i;
    NO_CREDITS = /\bno (?:api )?credits?\b|(?:add|buy|purchase|top up) (?:more )?credits?|out of credits|insufficient (?:credits?|funds|balance)|payment required|credit balance|billing|add (?:a )?payment method|upgrade (?:your )?(?:plan|account)\b|card number|\bsubscribe\b.{0,40}\bto continue/i;
    ConsentStop = class extends Error {
      constructor(message, reason, detail) {
        super(message);
        this.reason = reason;
        this.detail = detail;
        this.name = "ConsentStop";
      }
      reason;
      detail;
    };
  }
});

// src/agent/computer/tailnet-handoff.ts
import { randomBytes as randomBytes3, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
function tailnetAddress(interfaces = networkInterfaces()) {
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      if (a === 100 && b >= 64 && b <= 127) return entry.address;
    }
  }
  return void 0;
}
function sameToken(a, b) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
async function runTailnetHandoff(input) {
  const token = randomBytes3(24).toString("base64url");
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  let over = false;
  const server = createServer((request, response) => {
    void (async () => {
      const url2 = new URL(request.url ?? "/", "http://x");
      const [, first, rest] = /^\/([^/]+)(\/.*)?$/.exec(url2.pathname) ?? [];
      if (!first || !sameToken(first, token)) {
        response.writeHead(404).end();
        return;
      }
      if (over) {
        response.writeHead(410).end();
        return;
      }
      response.setHeader("cache-control", "no-store");
      if (request.method === "GET" && (!rest || rest === "/")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
        return;
      }
      const page = await computerPage(input.stateDir, input.tab);
      if (request.method === "GET" && rest === "/frame.jpg") {
        let image = await page.screenshot({ type: "jpeg", quality: 50, scale: "css", timeout: 1e4 });
        if (image.length > 9e5) image = await page.screenshot({ type: "jpeg", quality: 28, scale: "css", timeout: 1e4 });
        response.writeHead(200, { "content-type": "image/jpeg" }).end(image);
        return;
      }
      if (request.method === "POST" && rest === "/act") {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 5e3) {
            response.writeHead(413).end();
            return;
          }
        }
        const action = JSON.parse(body);
        if (action.type === "done") {
          over = true;
          response.writeHead(204).end();
          finish();
          return;
        }
        if (action.type === "click" && Number.isFinite(action.x) && Number.isFinite(action.y) && action.x >= 0 && action.y >= 0) await page.mouse.click(action.x, action.y);
        else if (action.type === "type" && typeof action.text === "string" && action.text.length <= 1e3) await page.keyboard.insertText(action.text);
        else if (action.type === "key" && ["Enter", "Tab", "Backspace", "Escape"].includes(action.key ?? "")) await page.keyboard.press(action.key);
        else if (action.type === "scroll" && ["up", "down"].includes(action.direction ?? "")) await page.mouse.wheel(0, action.direction === "up" ? -600 : 600);
        else {
          response.writeHead(400).end();
          return;
        }
        response.writeHead(204).end();
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  let timer;
  const stopped = new Promise((_, reject) => {
    input.signal?.addEventListener("abort", () => reject(new Error("Handoff stopped.")), { once: true });
  });
  stopped.catch(() => void 0);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, input.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const port2 = server.address().port;
    input.onLink(`http://${input.host}:${port2}/${token}/`);
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("The phone handoff expired after 10 minutes.")), TEN_MINUTES);
    });
    await Promise.race([finished, expired, stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}
var TEN_MINUTES, PAGE;
var init_tailnet_handoff = __esm({
  "src/agent/computer/tailnet-handoff.ts"() {
    "use strict";
    init_browser();
    TEN_MINUTES = 10 * 6e4;
    PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Finish in ClikCode</title>
<style>body{font:16px system-ui,sans-serif;margin:0;background:#10151c;color:#f2f5f8}main{max-width:900px;margin:auto;padding:12px}img{width:100%;border:1px solid #505c68;border-radius:8px;touch-action:manipulation}
button,input{font:inherit;min-height:44px;box-sizing:border-box}button{background:#263443;color:#fff;border:1px solid #65788b;border-radius:8px;padding:0 14px}input{flex:1;min-width:0;background:#1a222c;color:#fff;border:1px solid #65788b;border-radius:8px;padding:0 10px}
#controls{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}</style>
<main><h1>Finish in ClikCode</h1><p id="status">Loading\u2026</p><img id="screen" alt="ClikCode browser">
<div id="controls"><input id="entry" autocomplete="off" autocapitalize="off"><button id="type">Type</button><button id="enter">Enter</button><button id="tab">Tab</button><button id="up">Up</button><button id="down">Down</button><button id="done">Done</button></div></main>
<script>
const $=id=>document.getElementById(id);const base=location.pathname.replace(/\\/$/,'');
const act=a=>fetch(base+'/act',{method:'POST',body:JSON.stringify(a)}).catch(()=>$('status').textContent='The connection was lost. Ask ClikCode for a new link.');
let busy=false;async function frame(){if(busy)return;busy=true;try{const r=await fetch(base+'/frame.jpg?'+Date.now());if(r.status===410){$('status').textContent='Done. ClikCode will continue.';return}
if(r.ok){const u=URL.createObjectURL(await r.blob());const old=$('screen').src;$('screen').src=u;if(old.startsWith('blob:'))URL.revokeObjectURL(old);$('status').textContent='Tap the browser, type, or press Done when finished.'}}catch{}busy=false;setTimeout(frame,900)}
$('screen').onclick=e=>{const i=$('screen'),b=i.getBoundingClientRect();act({type:'click',x:Math.round((e.clientX-b.left)*i.naturalWidth/b.width),y:Math.round((e.clientY-b.top)*i.naturalHeight/b.height)})};
$('type').onclick=()=>{act({type:'type',text:$('entry').value});$('entry').value=''};
$('enter').onclick=()=>act({type:'key',key:'Enter'});$('tab').onclick=()=>act({type:'key',key:'Tab'});
$('up').onclick=()=>act({type:'scroll',direction:'up'});$('down').onclick=()=>act({type:'scroll',direction:'down'});
$('done').onclick=()=>{act({type:'done'});$('status').textContent='Finishing\u2026'};
frame();
</script></html>`;
  }
});

// src/version.ts
var CLIKCODE_VERSION_FALLBACK, CLIKCODE_VERSION, CLIKCODE_USER_AGENT, CLIKCODE_COMMIT;
var init_version = __esm({
  "src/version.ts"() {
    "use strict";
    CLIKCODE_VERSION_FALLBACK = "0.0.0-dev";
    CLIKCODE_VERSION = typeof __CLIKCODE_VERSION__ === "string" && __CLIKCODE_VERSION__ ? __CLIKCODE_VERSION__ : CLIKCODE_VERSION_FALLBACK;
    CLIKCODE_USER_AGENT = `ClikCode/${CLIKCODE_VERSION}`;
    CLIKCODE_COMMIT = typeof __CLIKCODE_COMMIT__ === "string" && __CLIKCODE_COMMIT__ ? __CLIKCODE_COMMIT__ : void 0;
  }
});

// src/agent/computer/preflight.ts
var preflight_exports = {};
__export(preflight_exports, {
  checkDepsLink: () => checkDepsLink,
  classifyGmail: () => classifyGmail,
  classifyGoogleSignIn: () => classifyGoogleSignIn,
  installedReleaseDir: () => installedReleaseDir,
  postToClikDeploy: () => postToClikDeploy,
  runPreflight: () => runPreflight,
  runPreflightHere: () => runPreflightHere
});
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir as homedir2, tmpdir } from "node:os";
import path10 from "node:path";
function classifyGoogleSignIn(url2, controls) {
  let at;
  try {
    at = new URL(url2);
  } catch {
    return { signedIn: false, reason: "the browser did not reach Google (no address)" };
  }
  if (at.hostname === "myaccount.google.com" || at.hostname.endsWith(".myaccount.google.com")) return { signedIn: true };
  if (at.hostname !== "accounts.google.com") return { signedIn: false, reason: `the browser ended on ${at.hostname || "a blank page"}, not on a Google account page` };
  if (/accountchooser/i.test(at.pathname)) return { signedIn: false, reason: "Google shows its account chooser: the session has expired or no account is signed in" };
  if (controls.emailBox || /signin|identifier|servicelogin|challenge/i.test(at.pathname)) return { signedIn: false, reason: "Google shows its sign-in form: no account is signed in in ClikCode's browser" };
  return { signedIn: true };
}
function classifyGmail(url2, rendered) {
  let host = "";
  try {
    host = new URL(url2).hostname;
  } catch {
  }
  if (host === "accounts.google.com") return { readable: false, reason: "Gmail sent the browser to Google sign-in" };
  if (host !== "mail.google.com") return { readable: false, reason: `Gmail did not open (the browser is on ${host || "a blank page"})` };
  return rendered ? { readable: true } : { readable: false, reason: "Gmail opened but its inbox did not render in time" };
}
function checkDepsLink(releaseDir, temp = tmpdir()) {
  if (!releaseDir || !existsSync(releaseDir)) return { ok: false, reason: "no installed release found (run: node scripts/install-local.mjs)" };
  const link = path10.join(releaseDir, "node_modules");
  let target;
  try {
    lstatSync(link);
    target = realpathSync(link);
  } catch {
    return { ok: false, reason: `${link} is missing or points at nothing` };
  }
  const tempReal = (() => {
    try {
      return realpathSync(temp);
    } catch {
      return temp;
    }
  })();
  if (target === tempReal || target.startsWith(`${tempReal}${path10.sep}`)) return { ok: false, target, reason: `${link} resolves into the temp folder (${target}); reinstall from a checkout with its own node_modules` };
  const need = createRequire(path10.join(releaseDir, "package.json"));
  for (const name of ["playwright-core", "yaml"]) {
    try {
      need.resolve(`${name}/package.json`);
    } catch {
      return { ok: false, target, reason: `${name} does not resolve from ${link}` };
    }
  }
  return { ok: true, target };
}
function installedReleaseDir() {
  const dir = process.env.CLIKCODE_RELEASE_DIR || path10.join(homedir2(), ".local", "share", "clikcode", "release");
  return existsSync(dir) ? dir : void 0;
}
async function runPreflight(deps) {
  const reasons = [];
  const buildId = deps.buildId ?? CLIKCODE_COMMIT ?? `${CLIKCODE_VERSION}-nocommit`;
  let browserOk = false;
  let googleSignedIn = false;
  let gmailReadable = false;
  let page;
  try {
    page = await deps.openPage();
    browserOk = true;
  } catch (error) {
    reasons.push(`browserOk: ${oneLine(error)}`);
  }
  if (page) {
    try {
      try {
        await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded", timeout: 3e4 });
        await settle(page);
        const verdict = classifyGoogleSignIn(page.url(), { emailBox: await page.locator('input[type="email"], #identifierId').count().then((n) => n > 0, () => false) });
        googleSignedIn = verdict.signedIn;
        if (!verdict.signedIn) reasons.push(`googleSignedIn: ${verdict.reason}`);
      } catch (error) {
        reasons.push(`googleSignedIn: ${oneLine(error)}`);
      }
      if (googleSignedIn) {
        try {
          const mailbox = defaultProfile(await listProfiles(deps.stateDir).catch(() => []))?.fields.sso_email || "0";
          await page.goto(`https://mail.google.com/mail/u/${encodeURIComponent(mailbox)}/#inbox`, { waitUntil: "domcontentloaded", timeout: 3e4 });
          const rendered = await page.locator('[role="main"], tr.zA').first().waitFor({ timeout: 15e3 }).then(() => true, () => false);
          const verdict = classifyGmail(page.url(), rendered);
          gmailReadable = verdict.readable;
          if (!verdict.readable) reasons.push(`gmailReadable: ${verdict.reason}`);
        } catch (error) {
          reasons.push(`gmailReadable: ${oneLine(error)}`);
        }
      } else reasons.push("gmailReadable: not checked, Google is not signed in");
    } finally {
      await page.close().catch(() => void 0);
    }
  } else reasons.push("googleSignedIn: not checked, the browser did not start", "gmailReadable: not checked, the browser did not start");
  const deps_ = checkDepsLink("releaseDir" in deps ? deps.releaseDir : installedReleaseDir(), deps.temp);
  if (!deps_.ok) reasons.push(`depsLinkOk: ${deps_.reason}`);
  const result = { browserOk, googleSignedIn, gmailReadable, buildId, depsLinkOk: deps_.ok, ok: browserOk && googleSignedIn && gmailReadable && deps_.ok, reasons, checkedAt: (/* @__PURE__ */ new Date()).toISOString() };
  if (deps.post) result.clikdeploy = await deps.post(result).catch((error) => `not posted: ${oneLine(error)}`);
  return result;
}
async function postToClikDeploy(result, signal) {
  const found = await runCli("clikdeploy", ["tools", "search", "connector_preflight"], { signal, timeoutMs: 2e4 });
  if (found.missing) return "not posted: the clikdeploy command is not installed here";
  const listed = firstJsonObject(found.text)?.data;
  if (!Array.isArray(listed)) return "not posted: could not ask ClikDeploy which tools exist";
  if (!listed.some((tool) => tool.name === "connector_preflight")) return "not posted: ClikDeploy has no connector_preflight tool yet";
  const { clikdeploy: _skip, ...body } = result;
  const sent = await runCli("clikdeploy", ["tools", "run", "connector_preflight", "--args-json", JSON.stringify(body), "--confirm"], { signal, timeoutMs: 3e4 });
  const reply = firstJsonObject(sent.text);
  return sent.code === 0 && reply?.status !== "error" ? "posted" : `not posted: ${(reply?.message ?? sent.text.trim() ?? "no answer").split("\n")[0].slice(0, 160)}`;
}
async function runPreflightHere(stateDir, options = {}) {
  const { throwawayComputerPage: throwawayComputerPage2 } = await Promise.resolve().then(() => (init_browser(), browser_exports));
  return runPreflight({
    stateDir,
    openPage: () => throwawayComputerPage2(stateDir),
    ...options.post === false ? {} : { post: (result) => postToClikDeploy(result, options.signal) }
  });
}
var settle, oneLine;
var init_preflight = __esm({
  "src/agent/computer/preflight.ts"() {
    "use strict";
    init_version();
    init_run_cli();
    init_profiles();
    init_secret_destinations();
    settle = async (page) => {
      await page.waitForLoadState?.("load", { timeout: 8e3 }).catch(() => void 0);
    };
    oneLine = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
  }
});

// src/agent/computer/network-capture.ts
var network_capture_exports = {};
__export(network_capture_exports, {
  describeCalls: () => describeCalls,
  jsonShape: () => jsonShape,
  recordNetwork: () => recordNetwork,
  safeUrl: () => safeUrl
});
function safeUrl(raw) {
  try {
    const u = new URL(raw);
    const names = [.../* @__PURE__ */ new Set([...u.searchParams.keys()])];
    return `${u.origin}${u.pathname}${names.length ? `?${names.map((name) => `${name}=\u2026`).join("&")}` : ""}`;
  } catch {
    return raw.slice(0, 200);
  }
}
function jsonShape(value, depth = 3) {
  if (Array.isArray(value)) return value.length ? `[${depth > 0 ? jsonShape(value[0], depth - 1) : "\u2026"}]` : "[]";
  if (value && typeof value === "object") {
    if (depth <= 0) return "{\u2026}";
    return `{${Object.entries(value).slice(0, 25).map(([key, inner]) => `${key}: ${jsonShape(inner, depth - 1)}`).join(", ")}}`;
  }
  return value === null ? "null" : typeof value;
}
async function recordNetwork(page, run, options = {}) {
  const calls = [];
  const pending2 = [];
  let dropped = 0;
  const onRequest = (request) => {
    if (!KINDS.has(request.resourceType())) return;
    const url2 = request.url();
    if (options.find && !url2.toLowerCase().includes(options.find.toLowerCase())) return;
    if (calls.length >= MAX_CALLS) {
      dropped++;
      return;
    }
    const call = { method: request.method(), url: safeUrl(url2), type: request.resourceType(), requestHeaders: Object.keys(request.headers()).sort() };
    calls.push(call);
    if (options.bodies) {
      const body = request.postData();
      if (body) call.body = clip(body);
    }
    pending2.push((async () => {
      const response = await request.response().catch(() => null);
      if (!response) return;
      call.status = response.status();
      call.contentType = response.headers()["content-type"]?.split(";")[0];
      if (call.contentType?.includes("json")) {
        const parsed = await response.json().catch(() => void 0);
        if (parsed !== void 0) {
          call.jsonShape = jsonShape(parsed);
          if (options.bodies) call.answer = clip(JSON.stringify(parsed));
        }
      }
    })());
  };
  page.on("request", onRequest);
  try {
    const result = await run();
    await page.waitForTimeout(options.quietMs ?? 800);
    await Promise.allSettled(pending2);
    return { result, calls, dropped };
  } finally {
    page.off("request", onRequest);
  }
}
function describeCalls(calls, dropped = 0) {
  if (!calls.length) return "No API calls (xhr/fetch) were made.";
  return [`${calls.length} API call${calls.length === 1 ? "" : "s"}${dropped ? ` (${dropped} more not shown)` : ""}:`, ...calls.map((call) => `${call.method} ${call.url} \u2192 ${call.status ?? "?"}${call.contentType ? ` ${call.contentType}` : ""}${call.jsonShape ? `
    answer: ${call.jsonShape}` : ""}${call.body ? `
    sent: ${call.body}` : ""}${call.answer ? `
    body: ${call.answer}` : ""}
    header names: ${call.requestHeaders.join(", ")}`)].join("\n");
}
var KINDS, MAX_CALLS, MAX_BODY, clip;
var init_network_capture = __esm({
  "src/agent/computer/network-capture.ts"() {
    "use strict";
    init_secret_finder();
    init_secret_scrubber();
    KINDS = /* @__PURE__ */ new Set(["xhr", "fetch"]);
    MAX_CALLS = 60;
    MAX_BODY = 1500;
    clip = (text) => hideKeyLikeText(scrubSecrets(text.slice(0, MAX_BODY))).text;
  }
});

// src/agent/tools/computer-web.ts
var computer_web_exports = {};
__export(computer_web_exports, {
  approvedFile: () => approvedFile,
  arrangeSnapshot: () => arrangeSnapshot,
  askForFills: () => askForFills,
  changedLines: () => changedLines,
  collapseOptions: () => collapseOptions,
  computerWebTool: () => computerWebTool,
  displayUrl: () => displayUrl,
  findInSnapshot: () => findInSnapshot,
  formProblems: () => formProblems,
  inOrder: () => inOrder,
  observeComputerPage: () => observeComputerPage,
  pageProblem: () => pageProblem,
  runSteps: () => runSteps,
  signInMethodHint: () => signInMethodHint,
  signInProviders: () => signInProviders,
  splitCodeFields: () => splitCodeFields,
  verificationCode: () => verificationCode,
  webAddress: () => webAddress,
  withSignInHints: () => withSignInHints
});
import fs10 from "node:fs/promises";
import path11 from "node:path";
function webAddress(value) {
  if (!value) throw new Error("Open needs a website URL.");
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Open needs an HTTP or HTTPS website URL without credentials.");
  return parsed.href;
}
async function locate(page, target) {
  const wanted = target?.trim();
  if (!wanted) throw new Error("Say what to act on: a [ref=\u2026] from the page view, or its visible text.");
  if (REF3.test(wanted)) {
    const byRef = page.locator(`aria-ref=${wanted}`);
    if (await byRef.count()) return byRef;
    throw new Error(`Nothing on the page has the reference ${wanted}: the page has changed since it was read.`);
  }
  for (const candidate of [page.getByLabel(wanted, { exact: true }), page.getByPlaceholder(wanted, { exact: true }), page.getByText(wanted, { exact: true }), page.getByTitle(wanted, { exact: true })]) {
    const visible2 = candidate.locator("visible=true");
    if (await visible2.count()) return visible2.first();
  }
  for (const candidate of [page.getByLabel(wanted), page.getByPlaceholder(wanted)]) {
    const visible2 = candidate.locator("visible=true");
    if (await visible2.count() === 1) return visible2.first();
  }
  throw new Error(`Nothing on the page shows "${wanted}".`);
}
async function controlName(page, target) {
  const wanted = target?.trim();
  if (!wanted || !REF3.test(wanted)) return void 0;
  const element = page.locator(`aria-ref=${wanted}`);
  return element.first().evaluate((node) => {
    const el = node;
    const clean2 = (text) => (text ?? "").replace(/\s+/g, " ").trim();
    const input = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    return clean2(el.getAttribute("aria-label")) || clean2(el.labels?.[0]?.textContent) || clean2(el.getAttribute("placeholder")) || (input ? "" : clean2(el.innerText)) || clean2(el.getAttribute("title")) || (el.tagName === "INPUT" && /^(submit|button)$/.test(el.getAttribute("type") ?? "") ? clean2(el.value) : "");
  }, void 0, { timeout: 2e3 }).then((name) => name || void 0, () => void 0);
}
async function press2(target, at) {
  if (at) {
    const box = await target.boundingBox({ timeout: 6e3 });
    if (box) {
      await target.click({ position: { x: at === "start" ? Math.min(6, box.width / 2) : Math.max(box.width - 6, box.width / 2), y: box.height / 2 }, timeout: 6e3 });
      return;
    }
  }
  const toggle = await target.evaluate((node) => {
    const input = node;
    return input.tagName === "INPUT" && (input.type === "checkbox" || input.type === "radio");
  }, void 0, { timeout: 2e3 }).catch(() => false);
  if (toggle) {
    await target.evaluate((node) => node.click(), void 0, { timeout: 3e3 });
    return;
  }
  try {
    await target.click({ timeout: 6e3 });
  } catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    await target.evaluate((node) => node.click(), void 0, { timeout: 3e3 });
  }
}
function visibleText() {
  const doc = globalThis.document;
  return `${doc.body.innerText}
${Array.from(doc.querySelectorAll("input, textarea")).map((element) => element.value ?? "").join("\n")}`;
}
function collapseOptions(snapshot2, keep = 6) {
  const lines = snapshot2.split("\n");
  const out = [];
  for (let at = 0; at < lines.length; ) {
    if (!/^\s*- option "/.test(lines[at])) {
      out.push(lines[at]);
      at++;
      continue;
    }
    let end = at;
    while (end < lines.length && /^\s*- option "/.test(lines[end]) && indentOf(lines[end]) === indentOf(lines[at])) end++;
    const run = lines.slice(at, end);
    if (run.length <= keep + 1) {
      out.push(...run);
      at = end;
      continue;
    }
    const chosen = run.filter((line) => /\[selected\]/.test(line));
    const shown = /* @__PURE__ */ new Set([...run.slice(0, keep), ...chosen]);
    out.push(...run.filter((line) => shown.has(line)), `${" ".repeat(indentOf(run[0]))}- (\u2026 ${run.length - shown.size} more options; choose one by its text)`);
    at = end;
  }
  return out.join("\n");
}
function arrangeSnapshot(snapshot2, full = false) {
  snapshot2 = collapseOptions(snapshot2);
  const lines = snapshot2.split("\n");
  const end = (from) => {
    let at = from + 1;
    while (at < lines.length && indentOf(lines[at]) > indentOf(lines[from])) at++;
    return at;
  };
  const hasMain = lines.some((line) => /^\s*- main\b/.test(line));
  const kept = [];
  const overlays = [];
  let folded = false;
  for (let at = 0; at < lines.length; ) {
    const line = lines[at];
    if (OVERLAY.test(line)) {
      const to = end(at);
      const base = indentOf(line);
      overlays.push(...lines.slice(at, to).map((item) => item.slice(base)));
      at = to;
      continue;
    }
    if (!full && hasMain && (EDGE.test(line) || SIDE_MENU.test(line) && end(at) - at > LONG_MENU_LINES)) {
      folded = true;
      at = end(at);
      continue;
    }
    kept.push(line);
    at++;
  }
  const cap = full ? 4e4 : 14e3;
  let body = kept.join("\n");
  if (!full && overlays.length && kept.length > BEHIND_DIALOG_LINES) {
    body = [...kept.slice(0, BEHIND_DIALOG_LINES), `- (\u2026 ${kept.length - BEHIND_DIALOG_LINES} more lines of the page behind the dialog; observe with full: true to see them)`].join("\n");
  }
  if (body.length > cap) {
    const rows = body.split("\n");
    let head = 0;
    let headSize = 0;
    while (head < rows.length && headSize < cap * 0.65) headSize += rows[head++].length + 1;
    let tail = rows.length;
    let tailSize = 0;
    while (tail > head && tailSize < cap * 0.35) tailSize += rows[--tail].length + 1;
    body = [...rows.slice(0, head), `- (\u2026 ${tail - head} lines trimmed from the middle of a long page; scroll, or observe with full: true \u2026)`, ...rows.slice(tail)].join("\n");
  }
  return [overlays.length ? `Open now (dialogs and menus):
${overlays.join("\n")}
` : "", body, folded ? "- (header, footer and long side menus folded away; observe with full: true to see them)" : ""].filter(Boolean).join("\n");
}
function findInSnapshot(snapshot2, text) {
  const lines = snapshot2.split("\n");
  const wanted = text.toLowerCase();
  const keep = /* @__PURE__ */ new Set();
  lines.forEach((line, at) => {
    if (!line.toLowerCase().includes(wanted)) return;
    keep.add(at);
    let depth = indentOf(line);
    for (let up = at - 1; up >= 0 && depth > 0; up--) if (indentOf(lines[up]) < depth) {
      keep.add(up);
      depth = indentOf(lines[up]);
    }
  });
  return [...keep].sort((a, b) => a - b).map((at) => lines[at]).join("\n");
}
function displayUrl(url2) {
  try {
    const parsed = new URL(url2);
    for (const [key, value] of [...parsed.searchParams.entries()]) if (value.length > 40 || /^(?:code|token|access_token|id_token|state|key|secret)$/i.test(key)) parsed.searchParams.set(key, "\u2026");
    if (parsed.hash.length > 40) parsed.hash = "#\u2026";
    return parsed.href.replace(/%E2%80%A6/g, "\u2026");
  } catch {
    return url2.slice(0, 200);
  }
}
function changedLines(previous, shown) {
  const before = new Set(previous.split("\n").map((line) => line.trim()));
  const lines = shown.split("\n");
  const keep = /* @__PURE__ */ new Set();
  let count = 0;
  lines.forEach((line, at) => {
    if (before.has(line.trim())) return;
    count++;
    keep.add(at);
    let depth = indentOf(line);
    for (let up = at - 1; up >= 0 && depth > 0; up--) if (indentOf(lines[up]) < depth) {
      keep.add(up);
      depth = indentOf(lines[up]);
    }
  });
  if (count > lines.length * 0.4 && count > 12) return void 0;
  return { text: [...keep].sort((a, b) => a - b).map((at) => lines[at]).join("\n"), count };
}
async function observeComputerPage(page, acceptsImages, full = false, find, compact = false) {
  const raw = scrubSecrets(await maskSensitive(page, await page.ariaSnapshot({ mode: "ai", timeout: 1e4 })));
  const { text: shown, hidden } = hideKeyLikeText(raw.replace(/^(\s*- \/url: )(\S{160})\S+$/gm, "$1$2\u2026"));
  if (find?.trim()) {
    const found2 = findInSnapshot(shown, find.trim());
    return { output: `Page: ${displayUrl(page.url())}

${found2 ? `Lines mentioning "${find.trim()}" (with the elements around them):
${found2.slice(0, 12e3)}` : `Nothing on the page mentions "${find.trim()}". Try observe with full: true.`}` };
  }
  const before = lastSeen.get(page);
  lastSeen.set(page, { url: page.url(), shown });
  if (compact && !full && before && before.url === page.url()) {
    const changed = changedLines(before.shown, shown);
    if (changed) {
      const head = arrangeSnapshot(shown, false).split("\n\n")[0];
      const open2 = head.startsWith("Open now") ? `${head}

` : "";
      const body = changed.count ? `Changed on the page (${changed.count} new or changed line${changed.count === 1 ? "" : "s"}; the rest is as before, observe for the whole page):
${changed.text.slice(0, 8e3)}` : "Nothing on the page changed (observe for the whole page).";
      return { output: `Page: ${displayUrl(page.url())}

${open2}${body}${hidden ? `

[${hidden} key-like value${hidden === 1 ? "" : "s"} hidden. Use capture_secret to save it without reading it.]` : ""}` };
    }
  }
  const snapshot2 = arrangeSnapshot(shown, full);
  const output = `Page: ${displayUrl(page.url())}

${snapshot2}${hidden ? `

[${hidden} key-like value${hidden === 1 ? "" : "s"} hidden. Use capture_secret to save it without reading it.]` : ""}`;
  if (!acceptsImages) return { output };
  if (hidden || (await sensitiveValues(page)).length || (await keyFieldValues(page)).length || showsSecret(snapshot2) || showsSecret(await page.evaluate(visibleText).catch(() => ""))) return { output: `${output}

[Screenshot withheld: the page holds a typed credential or a saved secret.]` };
  let bytes = await page.screenshot({ type: "jpeg", quality: 65, animations: "disabled", timeout: 1e4 });
  if (bytes.length > MAX_TOOL_IMAGE_BYTES) bytes = await page.screenshot({ type: "jpeg", quality: 35, animations: "disabled", timeout: 1e4 });
  const found = sniffImage(bytes);
  if (!found || bytes.length > MAX_TOOL_IMAGE_BYTES) return { output: `${output}

[Screenshot too large to show.]` };
  return { output, images: [{ mimeType: found.mimeType, data: bytes.toString("base64") }] };
}
async function settle2(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 5e3 }).catch(() => void 0);
  await page.evaluate(() => new Promise((resolve) => {
    const g = globalThis;
    let quiet = g.setTimeout(done, 250);
    const watcher = new g.MutationObserver(() => {
      g.clearTimeout(quiet);
      quiet = g.setTimeout(done, 250);
    });
    watcher.observe(g.document, { subtree: true, childList: true, attributes: true, characterData: true });
    g.setTimeout(done, 1500);
    function done() {
      watcher.disconnect();
      resolve();
    }
  })).catch(() => void 0);
}
function inOrder(key, job) {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  const tail = run.catch(() => void 0);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}
async function approvedFile(ctx, name) {
  if (!ctx || !name || !/_file$/.test(name)) throw new Error("Upload needs text naming a profile file detail ending _file, such as logo_file. Save one with profile custom.");
  for (const profile of await listProfiles(ctx.stateDir)) {
    const value = profile.custom?.[name]?.value;
    if (value) {
      try {
        if ((await fs10.stat(value)).isFile()) return value;
      } catch {
      }
      throw new Error(`The file saved as ${name} is not on this computer: ${path11.basename(value)}.`);
    }
  }
  throw new Error(`The profile has no ${name}. The user can add it with: clikcode computer profile --custom ${name}=/path/to/file`);
}
async function waitOn(page, step) {
  const seconds = Math.min(Math.max(Math.floor(step.seconds ?? 30), 1), 120);
  const text = step.text?.trim();
  if (!text) {
    await page.waitForTimeout(seconds * 1e3);
    return `Waited ${seconds}s.`;
  }
  const deadline = Date.now() + seconds * 1e3;
  while (Date.now() < deadline) {
    const shown = (await page.ariaSnapshot({ mode: "ai", timeout: 8e3 }).catch(() => "")).toLowerCase().includes(text.toLowerCase());
    if (shown !== (step.gone === true)) return `${step.gone ? "Gone" : "Appeared"}: "${text}".`;
    await page.waitForTimeout(1e3);
  }
  return { note: `Still ${step.gone ? "showing" : "not showing"} "${text}" after ${seconds}s.`, halt: true };
}
async function doStep(page, step, ctx) {
  switch (step.do) {
    case "upload": {
      const file3 = await approvedFile(ctx, step.text);
      const target = await locate(page, step.target);
      const isFileInput = await target.evaluate((node) => {
        const input = node;
        return input.tagName === "INPUT" && input.type === "file";
      }).catch(() => false);
      if (isFileInput) await target.setInputFiles(file3, { timeout: 1e4 });
      else {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8e3 }), clickOrHint(target)]);
        await chooser.setFiles(file3);
      }
      return `Uploaded ${path11.basename(file3)} (${step.text}) to ${step.target}.`;
    }
    case "click": {
      const target = await locate(page, step.target);
      const { dialogs } = await withDialogs(page, step.accept_dialog === true, () => clickOrHint(target, step.at));
      return `Clicked ${step.target}.${dialogNote(dialogs, step.accept_dialog === true)}`;
    }
    case "fill": {
      if (typeof step.text !== "string" || step.text.length > 2e4) throw new Error("Fill needs text of at most 20,000 characters.");
      const target = await locate(page, step.target);
      const tag = await target.evaluate((element) => element.tagName).catch(() => "");
      if (tag === "SELECT") {
        await target.selectOption({ label: step.text }, { timeout: 1e4 }).catch(() => target.selectOption(step.text, { timeout: 1e4 }));
        return `Chose "${step.text}" in ${step.target}.`;
      }
      if (step.text.length <= 200 && tag !== "TEXTAREA") {
        await target.fill("", { timeout: 1e4 });
        await target.pressSequentially(step.text, { timeout: 1e4 });
        await target.blur().catch(() => void 0);
      } else await target.fill(step.text, { timeout: 1e4 });
      return `Filled ${step.target}.`;
    }
    case "choose": {
      if (!step.text) throw new Error("Choose needs the option text.");
      const target = await locate(page, step.target);
      if (await target.evaluate((element) => element.tagName).catch(() => "") === "SELECT") {
        await target.selectOption({ label: step.text }, { timeout: 1e4 });
        return `Chose "${step.text}".`;
      }
      await clickOrHint(target);
      await page.keyboard.insertText(step.text).catch(() => void 0);
      await page.waitForTimeout(250);
      const option = page.getByRole("option", { name: step.text, exact: true }).or(page.getByRole("option", { name: new RegExp(step.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })).first();
      if (await option.count().catch(() => 0)) await option.click({ timeout: 5e3 });
      else await page.keyboard.press("Enter");
      return `Chose "${step.text}".`;
    }
    case "press":
      if (!step.key || !/^[A-Za-z0-9+_-]{1,30}$/.test(step.key)) throw new Error("Press needs a simple key.");
      await page.keyboard.press(step.key);
      return `Pressed ${step.key}.`;
    case "scroll":
      await page.mouse.wheel(0, step.direction === "up" ? -600 : 600);
      return "Scrolled.";
    case "wait":
      return waitOn(page, step);
    default:
      throw new Error(`Unknown step "${String(step.do)}".`);
  }
}
async function describeField(target) {
  return target.evaluate((element) => {
    const el = element;
    const label = (el.labels?.[0]?.textContent || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim();
    const type = el.type ?? "text";
    return {
      label,
      password: type === "password",
      placeholder: el.getAttribute("placeholder") ?? "",
      current: type === "password" ? "" : el.value ?? "",
      maxlength: Number(el.getAttribute("maxlength")) || 0,
      hint: { autocomplete: el.getAttribute("autocomplete") ?? "", type, text: `${label} ${el.getAttribute("name") ?? ""} ${el.getAttribute("id") ?? ""}` }
    };
  }).catch(() => ({ label: "", password: false, hint: { autocomplete: "", type: "text", text: "" }, placeholder: "", current: "", maxlength: 0 }));
}
function splitCodeFields(fields) {
  const single = fields.filter((field) => !field.password && field.maxlength === 1);
  if (single.length < 4 || single.length > 8) return [];
  return single.some((field) => CODE_BOX.test(`${field.hint.autocomplete} ${field.label} ${field.placeholder} ${field.hint.text}`)) ? [...single] : [];
}
async function askForFills(page, steps, ctx, label) {
  const blank = steps.filter((step) => step.do === "fill" && step.text === void 0);
  if (!blank.length) return [...steps];
  const origin = new URL(page.url()).origin;
  const fields = await Promise.all(blank.map(async (step) => ({ step, ...await describeField(await locate(page, step.target)) })));
  const profiles = await listProfiles(ctx.stateDir);
  let profile = profiles.length === 1 ? profiles[0] : void 0;
  if (profiles.length > 1) {
    const remembered = profileChoice.get(`${ctx.stateDir}|${origin}`);
    profile = profiles.find((candidate) => candidate.id === remembered) ?? bestProfileFor(profiles, fields.map((field) => field.hint), label);
    if (profile) profileChoice.set(`${ctx.stateDir}|${origin}`, profile.id);
  }
  const values = /* @__PURE__ */ new Map();
  const ask = [];
  let login;
  let confirmSignIn = false;
  if (fields.filter((field) => field.password).length <= 1) {
    const accounts = (await savedLoginsForSite(ctx.stateDir, page.url()).catch(() => [])).filter((account) => !account.rejected);
    const accountField = fields.some((field) => loginValueFor({ username: "x", password: "x" }, field));
    const signIn = accountField && (fields.filter((field) => field.password).length === 1 || /signin|identifier|\/login\b/i.test(page.url()));
    if (accounts.length && accountField) {
      let account = accounts.length === 1 ? accounts[0] : accounts.find((candidate) => candidate.id === profileChoice.get(`${ctx.stateDir}|login|${origin}`));
      const own = profile?.fields.sso_email ?? profile?.fields.email;
      if (!account && own) account = accounts.find((candidate) => candidate.label.split(" \xB7 ").some((value) => value.toLowerCase() === own.toLowerCase()));
      if (!account && ctx.requestPrivateLogin) {
        const labels = accounts.map((candidate) => candidate.label);
        const answer = await ctx.requestPrivateLogin(origin, [{ index: -1, key: "account", label: "Sign in with which account?", kind: "choice", required: true, options: [...labels, "Enter a different one"] }], ctx.signal);
        account = accounts[labels.indexOf(answer?.account ?? "")];
        if (account) profileChoice.set(`${ctx.stateDir}|login|${origin}`, account.id);
      }
      if (account) login = await savedLoginFields(ctx.stateDir, page.url(), account.id).catch(() => void 0);
    }
    if (signIn) confirmSignIn = true;
  }
  const passwordFields = fields.filter((field) => field.password);
  const boxesOnPage = passwordFields.length ? await page.locator('input[type="password"]:visible').count().catch(() => 0) : 0;
  const loginPage = /\/login\b|signin|identifier/i.test(page.url());
  const signingUp = !loginPage && (passwordFields.length >= 2 || boxesOnPage >= 2 || passwordFields.some((field) => /new-password/i.test(field.hint.autocomplete)) || passwordFields.length > 0 && /sign[-_ ]?up|register|create[-_ ]?account|join|password\/(?:edit|new|reset)|(?:reset|set|new|change)[-_ ]?password/i.test(page.url()));
  const email = profile?.fields.sso_email ?? profile?.fields.email ?? fields.find((field) => !field.password && field.current.includes("@"))?.current ?? steps.find((step) => step.do === "fill" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(step.text ?? ""))?.text;
  let generated2;
  let policy;
  let mine2 = false;
  if (signingUp) {
    generated2 = pendingSignupPassword(page);
    if (generated2) mine2 = generatedFor(page)?.password === generated2;
    if (!generated2 && page.url().startsWith("https:") && await generatedPasswordsAllowed(ctx.stateDir)) {
      policy = await readPasswordPolicy(page);
      generated2 = await savedPasswordFor(ctx.stateDir, page.url(), email) ?? generatePassword(policy);
      mine2 = true;
    }
    generated2 ??= profile ? await readProfileSecret(ctx.stateDir, profile, PASSWORD_SECRET) : void 0;
  }
  const split = splitCodeFields(fields);
  if (split.length) {
    const code = await codeFromMailbox(ctx.stateDir, page.url(), Date.now() - 12e4, ctx.signal);
    if (code && code.length === split.length) {
      registerSecret(code);
      split.forEach((field, index) => values.set(field.step, code[index]));
    }
  }
  for (const field of fields) {
    if (values.has(field.step)) continue;
    if (field.password && generated2) {
      values.set(field.step, generated2);
      continue;
    }
    const fromLogin = login ? loginValueFor(login, field) : void 0;
    if (fromLogin && !(confirmSignIn && !signingUp)) {
      values.set(field.step, fromLogin);
      continue;
    }
    if (field.password && !(confirmSignIn && !signingUp)) {
      const own = await sitePasswordFor(ctx.stateDir, page, email);
      if (own) {
        registerSecret(own);
        values.set(field.step, own);
        continue;
      }
    }
    const secretKey = secretFieldFor(profile, field.hint);
    const secret = secretKey && profile && !(confirmSignIn && !signingUp && field.password) ? await readProfileSecret(ctx.stateDir, profile, secretKey) : void 0;
    if (secret) {
      registerSecret(secret);
      values.set(field.step, secret);
      continue;
    }
    const asked = field.password ? void 0 : customFieldFor(profile, field.hint);
    if (asked) {
      values.set(field.step, asked.field.value);
      continue;
    }
    if (!field.password && fields.length === 1 && /one-time-code|\b(?:otp|verification|security code|passcode|confirmation code)\b|\bcode\b/i.test(`${field.hint.autocomplete} ${field.label} ${field.placeholder}`)) {
      const code = await codeFromMailbox(ctx.stateDir, page.url(), Date.now() - 12e4, ctx.signal);
      if (code) {
        registerSecret(code);
        values.set(field.step, code);
        continue;
      }
    }
    const key = field.password ? void 0 : profileKeyFor(field.hint);
    const known = key ? profile?.fields[key] : void 0;
    if (confirmSignIn && !signingUp && (field.password || fromLogin || key === "email")) {
      const current = field.password ? fromLogin : fromLogin ?? known;
      ask.push({ step: field.step, key: void 0, field: { index: ask.length, key: `fill${ask.length}`, label: field.label || String(field.step.target), kind: field.password ? "password" : "text", required: true, ...current ? { current } : {} } });
      continue;
    }
    if (known) {
      values.set(field.step, key === "phone" ? phoneFor(known, field.placeholder, field.current) : key === "birthday" ? birthdayFor(known, `${field.label} ${field.placeholder}`) : known);
      continue;
    }
    ask.push({ step: field.step, key, field: { index: ask.length, key: `fill${ask.length}`, label: field.label || String(field.step.target), kind: field.password ? "password" : "text", required: true } });
  }
  if (generated2) {
    registerSecret(generated2);
    await holdSignup(ctx.stateDir, page, generated2, email);
    if (mine2) rememberGenerated(page, generated2, policy ?? await readPasswordPolicy(page));
  }
  if (ask.length) {
    const needPassword = ask.filter((item) => item.field.kind === "password").map((item) => item.field);
    const noPassword = () => park(ctx.stateDir, page.url(), needPassword, "no saved login for this site; sign in once with the login action or add one with `clikcode computer secrets --import`");
    if (!ctx.requestPrivateLogin) {
      if (needPassword.length) return noPassword();
      throw new Error("Fill needs text: this chat cannot ask the user privately.");
    }
    const answers = await ctx.requestPrivateLogin(origin, ask.map((item) => item.field), ctx.signal);
    if (!answers) {
      if (needPassword.length) return noPassword();
      throw new Error("The user did not answer the private prompt, so these fields were left empty.");
    }
    const learned = {};
    for (const item of ask) {
      const answer = answers[item.field.key] ?? "";
      values.set(item.step, answer);
      if (item.field.kind === "password" && answer) {
        registerSecret(answer);
        expectSignup(page, answer);
      } else if (item.key && answer) learned[item.key] = answer;
    }
    if (Object.keys(learned).length && (profile || profiles.length === 0)) await saveProfile(ctx.stateDir, { ...profile ? { id: profile.id } : {}, fields: learned });
    if (confirmSignIn && !signingUp) {
      const entered = {};
      for (const item of ask) {
        const answer = values.get(item.step);
        if (!answer) continue;
        if (item.field.kind === "password") entered.password = answer;
        else if (!entered.username) entered.username = answer;
      }
      if (entered.username && entered.password) await saveLoginFields(ctx.stateDir, page.url(), entered).catch(() => void 0);
    }
  }
  return steps.map((step) => values.has(step) ? { ...step, text: values.get(step) } : step);
}
async function pageProblem(page) {
  if (!page) return "";
  try {
    const text = await page.evaluate(() => globalThis.document.body.innerText);
    const line = text.split("\n").map((item) => item.trim()).find((item) => item.length > 8 && item.length < 200 && /\b(error|failed|failure|unable|invalid|purchase|insufficient|required|not allowed|denied)\b/i.test(item));
    return line ?? "";
  } catch {
    return "";
  }
}
async function formProblems(page) {
  try {
    return await page.evaluate(() => {
      const doc = globalThis.document;
      const problems = [];
      for (const field of Array.from(doc.querySelectorAll("input, select, textarea"))) {
        const invalid = field.getAttribute("aria-invalid") === "true" || field.checkValidity && !field.checkValidity() && !!field.value;
        if (!invalid) continue;
        const label = (field.labels?.[0]?.textContent || field.getAttribute("aria-label") || field.getAttribute("placeholder") || field.getAttribute("name") || "a field").trim().slice(0, 40);
        problems.push(`${label} looks invalid${field.validationMessage ? `: ${field.validationMessage}` : ""}`);
      }
      for (const button of Array.from(doc.querySelectorAll("button"))) {
        const text = (button.textContent ?? "").trim();
        if (button.disabled && /^(continue|next|submit|create|sign up|save|verify|start|register)\b/i.test(text)) problems.push(`the "${text.slice(0, 30)}" button is disabled`);
      }
      return problems.slice(0, 6);
    });
  } catch {
    return [];
  }
}
async function runSteps(page, steps, ctx, tab, profileLabel, guard) {
  const notes = [];
  let current = page;
  steps = await askForFills(page, steps, ctx, profileLabel);
  for (const [index, planned] of steps.entries()) {
    const held = generatedFor(current);
    const step = planned.do === "fill" && held && planned.text && held.past.has(planned.text) ? { ...planned, text: held.password } : planned;
    const popups = [];
    const onPopup = (popup) => {
      popups.push(popup);
    };
    current.on("popup", onPopup);
    let halted = false;
    try {
      const before = guard ? void 0 : { url: current.url(), label: await controlName(current, step.target) };
      const done = await doStep(current, step, ctx);
      if (before && typeof done === "string") noteStep(journalKey(ctx.stateDir, tab), before.url, step, before.label);
      if (typeof done === "string") notes.push(done);
      else {
        notes.push(done.note);
        halted = true;
      }
      await settle2(current);
      const saved = await settleSignup(ctx.stateDir, current);
      if (saved) notes.push(saved);
      const made = generatedFor(current);
      if (made && pendingSignupPassword(current) === made.password) {
        const stepPage = current;
        const retried = await retryRejectedPassword({
          stateDir: ctx.stateDir,
          page: stepPage,
          username: pendingSignupUsername(stepPage),
          ...step.do === "click" || step.do === "press" && step.key === "Enter" ? { resubmit: () => doStep(stepPage, step, ctx) } : {},
          settle: settle2
        });
        if (retried) notes.push(retried);
      }
    } catch (error) {
      if (current.isClosed()) {
        const live2 = current.context().pages().filter((item) => !item.isClosed()).at(-1);
        if (live2) {
          current = live2;
          adoptPage(ctx.stateDir, current, tab);
          halted = true;
          notes.push(`Step ${index + 1} (${step.do}): the tab closed itself, so this is the page that is open now.`);
        }
      }
      if (!halted) {
        const view2 = await observeComputerPage(current, false, false, void 0, true).catch(() => void 0);
        return { output: `${[...notes, `Step ${index + 1} (${step.do}${step.target ? ` ${step.target}` : ""}) failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`].join("\n")}${view2 ? `

${view2.output}` : ""}`, isError: true };
      }
    } finally {
      current.off("popup", onPopup);
    }
    const next = popups.filter((popup) => !popup.isClosed()).at(-1);
    if (next) {
      current = next;
      adoptPage(ctx.stateDir, current, tab);
      await settle2(current);
      notes.push(`A new tab opened and is now the page: ${displayUrl(current.url())}`);
    }
    if (guard && !halted && await guard(current).catch(() => void 0)) halted = true;
    if (halted) {
      const rest = steps.length - index - 1;
      if (rest > 0) notes.push(`${rest} later step${rest === 1 ? " was" : "s were"} not run.`);
      break;
    }
  }
  const view = await observeComputerPage(current, false, false, void 0, true);
  const problems = steps.some((step) => step.do === "fill" || step.do === "choose") ? await formProblems(current) : [];
  return { output: `${notes.join("\n")}

${view.output}${problems.length ? `

On the form: ${problems.join("; ")}.` : ""}` };
}
async function withSignInHints(result, page, stateDir) {
  let url2;
  try {
    url2 = new URL(page.url());
  } catch {
    return result;
  }
  if (url2.hostname !== "accounts.google.com") {
    const text = await page.evaluate(() => globalThis.document.body.innerText.slice(0, 2e4)).catch(() => "");
    const hint = signInMethodHint({ ...signInProviders(text), email: /\b(?:sign ?in|log ?in)\b/i.test(text) && /\be-?mail\b/i.test(text) && /\bpassword\b/i.test(text) });
    return hint ? { ...result, output: `${result.output}

${hint}` } : result;
  }
  const hints = [];
  if (/accountchooser/.test(url2.pathname)) {
    const email = (await listProfiles(stateDir)).map((profile) => profile.fields.sso_email).find(Boolean);
    hints.push(email ? `Sign-in account: pick ${email} (the profile's sso_email): click target "${email}".` : "Several accounts are listed and the profile has no sso_email: pick the one the task is for, and save it with profile fields {sso_email} so the next sign-in needs no choice.");
  } else if (/consent/.test(url2.pathname)) {
    const text = await page.evaluate(() => globalThis.document.body.innerText).catch(() => "");
    const broad = /(?:see, edit, share|read, compose|permanently delete|all (?:the )?(?:calendars|emails|files|contacts)|your (?:calendar|mail|drive|contacts))/i.exec(text)?.[0];
    if (broad) hints.push(`This consent screen asks for more than a sign-in ("${broad}"). Decline it with Cancel unless the task is to give that access.`);
  }
  return hints.length ? { ...result, output: `${result.output}

${hints.join("\n")}` } : result;
}
function signInProviders(text) {
  const offers = (name) => new RegExp(`(?:continue|sign ?(?:in|up)|log ?in|register)\\s+(?:in\\s+)?(?:with|using|via)\\s+${name}\\b`, "i").test(text);
  return { google: offers("google"), github: offers("github") };
}
function signInMethodHint(offered) {
  if (offered.google) return 'This page offers Google: use it ("Continue with Google" / "Sign in with Google") instead of a password or a new account; the account chooser follows.';
  if (offered.github) return 'This page offers GitHub and not Google: use "Continue with GitHub" (including when it is the one marked "Last used"). GitHub has no Google sign-in of its own: if GitHub asks to sign in, use login with the saved GitHub account, and read any verification code with read_email_code.';
  if (offered.email) return "This page offers neither Google nor GitHub: sign in with the profile email (login action).";
  return void 0;
}
async function withNetworkRetry(run) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !/ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_IO_SUSPENDED/.test(error.message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
}
async function openLatestEmail(page, args, stateDir) {
  if (!args.from && !args.subject) throw new Error(`${args.action} needs from or subject.`);
  const mailbox = args.account ?? (await listProfiles(stateDir)).map((profile) => profile.fields.sso_email).find(Boolean) ?? 0;
  const query = [args.from ? `from:(${args.from})` : "", args.subject ? `subject:(${args.subject})` : "", "newer_than:1d"].filter(Boolean).join(" ");
  await withNetworkRetry(() => page.goto(`https://mail.google.com/mail/u/${mailbox}/#search/${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded", timeout: 3e4 }));
  const row = page.locator("tr.zA").first();
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await row.waitFor({ timeout: 1e4 }).then(() => true, () => false)) break;
    if (attempt === 3) throw new Error(`No email matched ${query}. If Gmail asked to sign in, sign in first with login; use account to pick another Gmail /u/N.`);
    await withNetworkRetry(() => page.reload({ waitUntil: "domcontentloaded" }));
  }
  const relevant = page.getByRole("button", { name: /showing most relevant/i });
  if (await relevant.count()) {
    await relevant.first().click({ timeout: 3e3 }).catch(() => void 0);
    await page.getByRole("menuitemradio", { name: /most recent/i }).click({ timeout: 3e3 }).catch(() => void 0);
    await page.waitForTimeout(800);
  }
  await row.click();
  await page.locator('[aria-label="Expand all"]').first().click({ timeout: 2e3 }).catch(() => void 0);
  const body = page.locator(".a3s:visible").last();
  await body.waitFor({ timeout: 15e3 });
  await page.locator(".ajR").last().click({ timeout: 1500 }).catch(() => void 0);
  return body;
}
async function listRecipesFor(stateDir, url2) {
  try {
    const recipes = (await listRecipes(stateDir)).filter((r) => {
      const host = new URL(url2).hostname.toLowerCase().replace(/^www\./, "");
      return host === r.host || host.endsWith(`.${r.host}`);
    });
    return recipes.length ? `A recipe is saved for this site (${recipes.map((r) => `via ${r.loginRoute}`).join(", ")}, verified ${recipes[0].verifiedAt.slice(0, 10)}): computer_web action recipe, recipe_op run replays it and stops at a captcha, code, payment or review page; recipe_op get shows its steps.` : "";
  } catch {
    return "";
  }
}
async function act(page, args, ctx) {
  if (INTERACTIONS.has(args.action)) {
    const one = { do: args.action, ...args.at ? { at: args.at } : {}, ...args.target ? { target: args.target } : {}, ...args.text !== void 0 ? { text: args.text } : {}, ...args.key ? { key: args.key } : {}, ...args.direction ? { direction: args.direction } : {}, ...args.accept_dialog ? { accept_dialog: true } : {}, ...args.gone ? { gone: true } : {}, ...args.seconds ? { seconds: args.seconds } : {} };
    return runSteps(page, [one], ctx, args.tab, args.label);
  }
  switch (args.action) {
    case "open": {
      await withNetworkRetry(() => page.goto(webAddress(args.url), { waitUntil: "domcontentloaded", timeout: 3e4 }));
      await settle2(page);
      await settleSignup(ctx.stateDir, page);
      beginJournal(journalKey(ctx.stateDir, args.tab), page.url());
      const seen = await observeComputerPage(page, ctx.acceptsImages === true);
      const notes = await readSiteNotes(ctx.stateDir, new URL(page.url()).hostname).catch(() => "");
      const recipes = await listRecipesFor(ctx.stateDir, page.url());
      const withNotes = notes ? { ...seen, output: `Notes from earlier on this site:
${notes}

${seen.output}` } : seen;
      return recipes ? { ...withNotes, output: `${recipes}

${withNotes.output}` } : withNotes;
    }
    case "notes": {
      const host = args.host?.trim() || new URL(page.url()).hostname;
      if (!args.note) return { output: await readSiteNotes(ctx.stateDir, host) || `No notes for ${host} yet.` };
      return { output: `Saved. Notes for ${host}:
${await addSiteNote(ctx.stateDir, host, args.note)}` };
    }
    case "recipe": {
      const op = args.recipe_op ?? "list";
      const host = args.host?.trim() || (() => {
        try {
          return new URL(page.url()).hostname;
        } catch {
          return "";
        }
      })();
      if (op === "list") {
        const all = await listRecipes(ctx.stateDir);
        return { output: all.length ? all.map((r) => `${r.host} via ${r.loginRoute} (${r.steps.length} steps, verified ${r.verifiedAt.slice(0, 10)})`).join("\n") : "No recipes saved yet." };
      }
      if (op === "save") {
        const list2 = typeof args.steps === "string" ? (() => {
          try {
            return JSON.parse(args.steps);
          } catch {
            return void 0;
          }
        })() : args.steps;
        const saved = await saveRecipe(ctx.stateDir, { host, loginRoute: args.login_route ?? "", steps: list2, ...args.key_page ? { keyPage: args.key_page } : {}, ...args.capture_hint ? { captureHint: args.capture_hint } : {} });
        return { output: `Saved the recipe.
${describeRecipe(saved)}` };
      }
      const recipe = await getRecipe(ctx.stateDir, host, args.login_route);
      if (!recipe) return { output: `No recipe for ${host}${args.login_route ? ` via ${args.login_route}` : ""} yet.`, ...op === "run" ? { isError: true } : {} };
      if (op === "get") return { output: describeRecipe(recipe) };
      let ended = page;
      const mine2 = (await listProfiles(ctx.stateDir)).map((profile) => profile.fields.sso_email).find(Boolean);
      const filled = { ...recipe, steps: recipe.steps.map((step) => ({ ...step, ...step.target ? { target: fillPlaceholders(step.target, { sso_email: mine2 }) } : {}, ...step.text ? { text: fillPlaceholders(step.text, { sso_email: mine2 }) } : {} })) };
      const replay = await replayRecipe(filled, (steps, guard) => runSteps(page, steps, ctx, args.tab, args.label, async (current) => {
        ended = current;
        return guard();
      }), async () => scrubSecrets(await ended.ariaSnapshot({ mode: "ai", timeout: 8e3 })));
      if (replay.completed) await saveRecipe(ctx.stateDir, { host: recipe.host, loginRoute: recipe.loginRoute, steps: recipe.steps, ...recipe.keyPage ? { keyPage: recipe.keyPage } : {}, ...recipe.captureHint ? { captureHint: recipe.captureHint } : {} }).catch(() => void 0);
      return { output: replay.output, ...replay.isError ? { isError: true } : {} };
    }
    case "observe":
      return observeComputerPage(page, ctx.acceptsImages === true, args.full === true, args.find);
    case "steps":
      const list = typeof args.steps === "string" ? (() => {
        try {
          return JSON.parse(args.steps);
        } catch {
          return void 0;
        }
      })() : args.steps;
      if (!Array.isArray(list) || !list.length) throw new Error('steps needs a list, e.g. [{"do":"click","target":"e5"}].');
      return runSteps(page, list, ctx, args.tab, args.label);
    case "network": {
      const list2 = typeof args.steps === "string" ? (() => {
        try {
          return JSON.parse(args.steps);
        } catch {
          return void 0;
        }
      })() : args.steps;
      const { recordNetwork: recordNetwork2, describeCalls: describeCalls2 } = await Promise.resolve().then(() => (init_network_capture(), network_capture_exports));
      const { result, calls, dropped } = await recordNetwork2(page, async () => Array.isArray(list2) && list2.length ? runSteps(page, list2, ctx, args.tab, args.label) : (await page.waitForTimeout((args.seconds ?? 5) * 1e3), void 0), { ...args.find ? { find: args.find } : {}, ...args.bodies ? { bodies: true } : {} });
      return { output: `${result?.output ? `${result.output}

` : ""}${describeCalls2(calls, dropped)}`, ...result?.isError ? { isError: true } : {} };
    }
    case "open_email_link": {
      if (await emailConnected(ctx.stateDir)) {
        const mail = await waitForEmail(ctx.stateDir, { from: args.from, subject: args.subject, ...args.from || args.subject ? {} : { site: page.url() }, spam: true, consume: true, accept: args.from || args.subject ? ((m) => m.links.length > 0) : looksLikeLinkEmail, timeoutMs: (args.seconds ?? 90) * 1e3, signal: ctx.signal });
        const real2 = mail.links.filter((href) => !/unsubscribe|accounts\.google\.com|mail\.google\.com|privacy|terms/i.test(href));
        const wanted2 = args.link?.toLowerCase();
        const pick2 = wanted2 ? real2.find((href) => href.toLowerCase().includes(wanted2)) : real2[0];
        if (!pick2) throw new Error(`The email has no ${wanted2 ? `link mentioning "${args.link}"` : "usable link"}. Links found: ${real2.slice(0, 5).map(displayUrl).join(", ") || "none"}.`);
        await page.goto(pick2, { waitUntil: "domcontentloaded", timeout: 3e4 });
        await settle2(page);
        return observeComputerPage(page, ctx.acceptsImages === true);
      }
      const body = await openLatestEmail(page, args, ctx.stateDir);
      const links = await body.locator("a[href]").evaluateAll((nodes) => nodes.map((node) => ({ href: node.href, text: node.textContent ?? "" })));
      const real = links.map((link) => {
        try {
          const u = new URL(link.href);
          return { ...link, href: u.hostname.endsWith("google.com") && u.pathname === "/url" ? u.searchParams.get("q") ?? link.href : link.href };
        } catch {
          return link;
        }
      }).filter((link) => /^https:/.test(link.href) && !/unsubscribe|accounts\.google\.com|mail\.google\.com|privacy|terms/i.test(link.href));
      const wanted = args.link?.toLowerCase();
      const pick = wanted ? real.find((link) => `${link.href} ${link.text}`.toLowerCase().includes(wanted)) : real[0];
      if (!pick) throw new Error(`The email has no ${wanted ? `link mentioning "${args.link}"` : "usable link"}. Links found: ${real.slice(0, 5).map((link) => displayUrl(link.href)).join(", ") || "none"}.`);
      await page.goto(pick.href, { waitUntil: "domcontentloaded", timeout: 3e4 });
      await settle2(page);
      return observeComputerPage(page, ctx.acceptsImages === true);
    }
    case "email_connect": {
      const email = (await listProfiles(ctx.stateDir)).map((profile) => profile.fields.sso_email).find(Boolean);
      const done = await connectEmail(ctx.stateDir, page, { email, progress: (line) => line && ctx.emitOutput?.(line) });
      return { output: `Mailbox connected${done.email ? `: ${done.email}` : ""}. read_email_code and open_email_link now read mail directly and wait for it to arrive.` };
    }
    case "oauth_connect": {
      const email = (await listProfiles(ctx.stateDir)).map((profile) => profile.fields.sso_email).find(Boolean);
      const done = await oauthConnect(args.target?.trim() ?? "", page, { email, stateDir: ctx.stateDir, signal: ctx.signal, progress: (line) => line && ctx.emitOutput?.(line) });
      return { output: `Connected ${done.connector}: ClikDeploy shows an active connection. ${done.steps.filter(Boolean).join(" ")}` };
    }
    case "read_email_code": {
      if (await emailConnected(ctx.stateDir)) {
        const mail2 = await waitForEmail(ctx.stateDir, { from: args.from, subject: args.subject, ...args.from || args.subject ? {} : { site: page.url() }, spam: true, consume: true, accept: args.from || args.subject ? ((m) => verificationCode(m.text) !== void 0) : looksLikeCodeEmail, timeoutMs: (args.seconds ?? 90) * 1e3, signal: ctx.signal });
        const code = verificationCode(mail2.text);
        if (!code) throw new Error(`The email from ${args.from ?? args.subject} has no code in it. It says: "${mail2.text.replace(/\s+/g, " ").slice(0, 160)}".`);
        return { output: `Code: ${code}. Type it into the page that asked for it.` };
      }
      const mail = await page.context().newPage();
      try {
        const text = await (await openLatestEmail(mail, args, ctx.stateDir)).innerText();
        const code = verificationCode(text);
        if (!code) throw new Error(`The email from ${args.from ?? args.subject} has no code in it. It says: "${text.replace(/\s+/g, " ").slice(0, 160)}".`);
        return { output: `Code: ${code}. Type it into the page that asked for it; it is already waiting in the tab you left.` };
      } finally {
        await mail.close().catch(() => void 0);
      }
    }
    case "login": {
      const outcome = await loginComputerPage({
        stateDir: ctx.stateDir,
        page,
        signal: ctx.signal,
        newAccount: args.new_account === true,
        mailCode: (since) => codeFromMailbox(ctx.stateDir, page.url(), since, ctx.signal),
        ask: async (site, fields, signal) => {
          const fromProfile = await profileLoginAnswers(ctx.stateDir, fields);
          if (fromProfile) return fromProfile;
          if (!ctx.requestPrivateLogin) throw new LoginError("This chat cannot show private login fields.");
          return ctx.requestPrivateLogin(site, fields, signal);
        },
        onVerification: () => ctx.emitOutput?.("Approve the sign-in or finish verification in the open browser.\n")
      });
      const failed = outcome === "unverified" || outcome === "saved_login_rejected";
      if (outcome === "signed_in" || outcome === "session_reused") await recordVerified(ctx.stateDir, journalKey(ctx.stateDir, args.tab), { kind: "login" }).catch(() => void 0);
      const landed = failed ? void 0 : await (async () => {
        try {
          return await observeComputerPage(page.isClosed() ? await computerPage(ctx.stateDir, args.tab) : page, false);
        } catch {
          return void 0;
        }
      })();
      return { output: `${loginOutcomeMessage(outcome)}${landed ? `

${landed.output}` : ""}`, ...failed ? { isError: true } : {} };
    }
    case "capture_secret": {
      const plan = normalizeSendTo(args.send_to);
      const planProblem = plan?.length ? await destinationProblem(ctx.stateDir, plan) : void 0;
      if (planProblem) throw new Error(`${planProblem} Nothing was clicked.`);
      const triggerLabel = args.target ? await controlName(page, args.target) ?? (REF3.test(args.target.trim()) ? void 0 : args.target.trim()) : void 0;
      const name = args.secret_name?.trim() || `${new URL(page.url()).hostname.replace(/^www\./, "")}/key`;
      const { length, shape, via, check, sent } = await inOrder("clipboard", async () => {
        await page.bringToFront().catch(() => void 0);
        return captureSecret({
          ...args.paste ? { paste: true } : {},
          stateDir: ctx.stateDir,
          page,
          name,
          signal: ctx.signal,
          meta: { vendor: args.vendor ?? new URL(page.url()).hostname.replace(/^www\./, ""), owner: args.owner ?? (await listProfiles(ctx.stateDir))[0]?.fields.sso_email, ...args.env ? { env: args.env } : {} },
          ...plan?.length ? { sendTo: plan } : {},
          ...args.target ? { trigger: async () => {
            await clickOrHint(await locate(page, args.target));
          } } : {},
          ...args.target ? { readTarget: async () => {
            const element = await locate(page, args.target);
            return await element.inputValue({ timeout: 1e3 }).catch(() => "") || await element.innerText({ timeout: 1e3 }).catch(() => "");
          } } : {},
          ask: async (secretName2, hint, signal) => {
            if (!ctx.requestPrivateSecret) throw new LoginError("Not saved: this chat cannot show a private prompt, and the key could not be found on its own.");
            return ctx.requestPrivateSecret(secretName2, hint, signal);
          }
        });
      });
      const refused = check.verdict === "rejected";
      if (!refused) {
        const key = journalKey(ctx.stateDir, args.tab);
        if (triggerLabel) noteStep(key, page.url(), { do: "click", target: triggerLabel });
        await recordVerified(ctx.stateDir, key, { kind: "capture", url: page.url(), hint: `${triggerLabel ? `Click "${triggerLabel}" to make the key show, then capture_secret. ` : ""}Verified: ${check.verdict === "works" ? "the key works" : "a key was found and stored"}.` }).catch(() => void 0);
      }
      const lines = [
        `SAVED "${name}" in ClikCode Secrets Manager (${length} characters, ${shape}, taken from ${via}). You were not shown the key; if that does not match what you expected (an id where a secret should be), delete it and capture again.`,
        refused ? `NOT VERIFIED: ${check.detail}. It was kept because the site shows a new key only once, and it was NOT sent anywhere. Wait a minute, then send it with send_secret and check the result.` : check.verdict === "works" ? `Checked: ${check.detail}.` : `Not checked: ${check.detail}.`,
        ...sent.map((delivery) => `${delivery.ok ? "SENT" : "NOT SENT"} - ${delivery.label}: ${delivery.message}`),
        ...refused ? [] : sent.some((delivery) => !delivery.ok) ? ["The key is still saved. Fix the cause, then send it again with send_secret."] : sent.length ? [] : ["Nothing was sent anywhere: use send_to to send it on, or send_secret later."]
      ];
      return { output: lines.join("\n"), ...sent.some((delivery) => !delivery.ok) ? { isError: true } : {} };
    }
    case "handoff": {
      const handoffKey = args.tab ? `${ctx.stateDir}#${args.tab}` : ctx.stateDir;
      let running2 = handoffs.get(handoffKey);
      if (!running2) {
        const stop = new AbortController();
        let resolveLink;
        let failLink;
        const link = new Promise((resolve, reject) => {
          resolveLink = resolve;
          failLink = reject;
        });
        link.catch(() => void 0);
        const host = tailnetAddress();
        if (!host) throw new Error("A handoff needs this computer and your phone on the same Tailscale network, and this computer is not on one (no Tailscale address). Install Tailscale and sign in on both, or finish this step at the computer.");
        const done = runTailnetHandoff({ stateDir: ctx.stateDir, host, signal: stop.signal, onLink: resolveLink, ...args.tab ? { tab: args.tab } : {} }).then(() => ({ ok: true }), (error) => {
          failLink(error instanceof Error ? error : new Error(String(error)));
          return { ok: false, message: error instanceof Error ? error.message : String(error) };
        }).finally(() => {
          handoffs.delete(handoffKey);
        });
        running2 = { link, done, stop };
        handoffs.set(handoffKey, running2);
        const url2 = await Promise.race([running2.link, new Promise((_, reject) => setTimeout(() => reject(new Error("The phone link did not come up.")), 45e3))]);
        return { output: `Phone link over Tailscale (the phone must be on the same tailnet; valid 10 minutes, one use): ${url2}
Tell the user to open it and finish the browser step (CAPTCHA, MFA). Then call handoff again to wait until they are done.` };
      }
      const outcome = await Promise.race([running2.done, new Promise((resolve) => setTimeout(() => resolve("waiting"), 9e4))]);
      if (outcome === "waiting") return { output: "The user has not finished yet. Call handoff again to keep waiting." };
      return outcome.ok ? { output: "The user finished the browser step. Continue from the current page." } : { output: outcome.message, isError: true };
    }
    default:
      throw new Error(`Unknown action "${String(args.action)}". Actions: ${ACTION_LIST}.`);
  }
}
async function clickOrHint(target, at) {
  try {
    await press2(target, at);
  } catch (error) {
    if (!(error instanceof Error) || !/timeout/i.test(error.message)) throw error;
    throw new Error(`${error.message.split("\n")[0]} If a popup window or browser dialog is in front of the page, use computer_desktop to see and answer it.`);
  }
}
var REF3, isStandardKey, journalKey, indentOf, BEHIND_DIALOG_LINES, OVERLAY, EDGE, SIDE_MENU, LONG_MENU_LINES, lastSeen, ACTION_LIST, WEB_PARAMETERS, WEB_DESCRIPTION, computerWebTool, queues, handoffs, INTERACTIONS, PROFILE_FORMATS, PROFILE_PROMPT, profileChoice, CODE_BOX;
var init_computer_web = __esm({
  "src/agent/tools/computer-web.ts"() {
    "use strict";
    init_tool_contract();
    init_browser();
    init_settings();
    init_images();
    init_sensitive_fields();
    init_store_secret();
    init_shared_state();
    init_credential_vault();
    init_login_fill();
    init_signup_recipes();
    init_site_notes();
    init_profiles();
    init_signup_login();
    init_password_policy();
    init_password_retry();
    init_login_page();
    init_login_error();
    init_secret_scrubber();
    init_profile_login();
    init_parking();
    init_secret_finder();
    init_page_dialogs();
    init_store_secret();
    init_secret_destinations();
    init_secret_capture();
    init_email_api();
    init_email_code();
    init_email_consent();
    init_recipe_recorder();
    init_oauth_consent();
    init_tailnet_handoff();
    REF3 = /^(?:f\d+)?e\d+$/;
    isStandardKey = (key) => PROFILE_KEYS.includes(key);
    journalKey = (stateDir, tab) => tab ? `${stateDir}#${tab}` : stateDir;
    indentOf = (line) => line.length - line.trimStart().length;
    BEHIND_DIALOG_LINES = 40;
    OVERLAY = /^\s*- (?:dialog|alertdialog|menu|listbox)\b/;
    EDGE = /^\s*- (?:banner|contentinfo)\b/;
    SIDE_MENU = /^\s*- (?:navigation|complementary)\b/;
    LONG_MENU_LINES = 25;
    lastSeen = sharedState("page-last-seen", () => /* @__PURE__ */ new WeakMap());
    ACTION_LIST = "open \xB7 close \xB7 observe \xB7 click \xB7 fill \xB7 choose \xB7 press \xB7 scroll \xB7 wait \xB7 upload \xB7 steps \xB7 login \xB7 handoff \xB7 capture_secret \xB7 send_secret \xB7 profile \xB7 open_email_link \xB7 read_email_code \xB7 email_connect \xB7 oauth_connect \xB7 notes \xB7 recipe \xB7 queue \xB7 network \xB7 preflight \xB7 forget_login \xB7 help";
    WEB_PARAMETERS = { type: "object", additionalProperties: true, required: ["action"], properties: {
      action: { type: "string", description: ACTION_LIST },
      tab: { type: "string", description: "Name of your own tab. Agents working in parallel each pass a different name on every call, so they never share, read or navigate each other's page. Leave out when you are the only one using the browser." },
      at: { type: "string", enum: ["start", "end"], description: "click: click the left (start) or right (end) edge of the element instead of its middle, for a checkbox whose label has a link in the middle." },
      url: { type: "string", description: "open: the website address." },
      host: { type: "string", description: "notes: the site (default: the open page's)." },
      note: { type: "string", description: "notes: a step, address or gotcha worth knowing the next time this task is done on the site. Leave out to read the saved notes. Never a key or password." },
      recipe_op: { type: "string", enum: ["save", "get", "run", "list"], description: "recipe: save (after a signup or key capture worked: host, login_route, steps, key_page, capture_hint), get, run (replay the saved steps; stops at the first failure or at a captcha, SMS/MFA code, payment or review page, and shows the page so you can take over), list." },
      login_route: { type: "string", enum: ["google", "github", "email"], description: "recipe: how the account was signed in (save), or which recipe to get or run." },
      key_page: { type: "string", description: "recipe save: the address of the page where the key is created or shown." },
      capture_hint: { type: "string", description: "recipe save: how the key was captured (which button reveals or copies it). Never the key itself." },
      target: { type: "string", description: "oauth_connect: the ClikDeploy connector id (slack, github). click, fill, capture_secret: a [ref=\u2026] from the page view (e5, or f1e2 inside a frame), or the visible text of a sign-in page control. forget_login: the site (a host such as wordnik.com, or a URL)." },
      text: { type: "string", description: "fill: the text. Leave it out for what only the user knows (name, address, phone, a password): the user is asked privately, once for all such fields in the call, and you are not shown the answer. wait: the words to wait for." },
      gone: { type: "boolean", description: "wait: wait for the text to disappear instead of appear." },
      seconds: { type: "number", description: "wait: how long to wait at most (default 30, up to 120). read_email_code, open_email_link: how long to wait for the email to arrive when a mailbox is connected (default 90)." },
      find: { type: "string", description: "observe: show only the lines that mention these words." },
      key: { type: "string", description: "press: a key such as Enter or Escape." },
      direction: { type: "string", enum: ["up", "down"], description: "scroll." },
      steps: {
        type: ["array", "string"],
        description: 'steps: what to do, in order, e.g. [{do:"fill", target:"e4", text:"My key"}, {do:"click", target:"e9"}].',
        items: { type: "object", additionalProperties: false, required: ["do"], properties: {
          do: { type: "string", enum: ["click", "fill", "choose", "press", "scroll", "wait", "upload"] },
          target: { type: "string" },
          text: { type: "string" },
          key: { type: "string" },
          direction: { type: "string", enum: ["up", "down"] },
          accept_dialog: { type: "boolean" },
          at: { type: "string", enum: ["start", "end"], description: "click: click the left (start) or right (end) edge of the element instead of its middle, for a checkbox whose label has a link in the middle." },
          gone: { type: "boolean" },
          seconds: { type: "number" }
        } }
      },
      full: { type: "boolean", description: "observe: include the header and footer and a longer view." },
      accept_dialog: { type: "boolean", description: 'click: answer yes to a browser confirm dialog the click raises ("delete this token?"). Default: declined and reported.' },
      new_account: { type: "boolean", description: "login: ask for a different account instead of the saved one." },
      paste: { type: "boolean", description: "capture_secret: only when the user has said they will paste it: skip looking and ask them privately. Never use it because capture failed; reveal, copy or rotate the key instead." },
      secret: { type: "string", description: "send_secret: name a key was saved under (send it again, or somewhere else, without seeing it). With to and with, or send_to." },
      to: { type: "string", description: "send_secret: destination name, e.g. clikdeploy-secret." },
      with: { type: ["object", "string"], description: 'send_secret: values for the destination slots, e.g. {key:"SALAD_API_KEY"}.' },
      ask: { type: "boolean", description: "profile: ask the user now for name, email, phone and address and save them as a profile (also happens when none exists)." },
      from: { type: "string", description: "open_email_link, read_email_code: sender (name or address) of the email in the signed-in Gmail." },
      subject: { type: "string", description: "open_email_link, read_email_code: words from the subject." },
      link: { type: "string", description: "open_email_link: words or domain of the link to open (default: the first real link in the message)." },
      account: { type: "integer", description: "open_email_link, read_email_code: Gmail account number /u/N (default 0)." },
      fields: { type: "object", additionalProperties: { type: "string" }, description: `profile: fields to save or correct in the user's autofill profile (${PROFILE_KEYS.join(", ")}). Leave out to list the profiles. Use it when a site wants a different format (phone as +1\u2026, state as an abbreviation).` },
      label: { type: "string", description: "forget_login: only the saved login with this username or email (default: every saved login for the site). profile: which profile (default: the one called Personal, else the one with the most standard fields, else a new one called Personal)." },
      ask_fields: { type: "array", items: { type: "object", additionalProperties: false, properties: { key: { type: "string" }, label: { type: "string" }, match: { type: "array", items: { type: "string" } }, optional: { type: "boolean" }, format: { type: "string", description: "Types itself as the user enters it: date (##/##/####), phone ((###) ###-####), zip, time, or a pattern where # is a digit, A a letter, * either and anything else a literal the box inserts and jumps over." }, options: { type: "array", items: { type: "string" }, description: "A fixed set of answers shown as a selector (arrow keys in the terminal, radios in VS Code) instead of a text box." }, secret: { type: "boolean", description: 'The answer is a secret (a password to use for sign-ups, key "password"; a recovery code): typed hidden, kept in Secrets Manager with the profile, and never shown to you. A later fill of a password box with no text uses it.' } }, required: ["key", "label"] }, description: 'profile: ask the user, privately and in one prompt, for details a task needs beyond the standard ones, and keep them in a profile (with label, a new one) so every later fill with no text uses them. key is lower_snake_case (app_name, privacy_policy_url); label is what the user is asked; match lists the words a form may label it with (["app name","application name"]); optional fields may be left empty. Details only; a password or code goes in with secret: true.' },
      custom: { type: "object", additionalProperties: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, value: { type: "string" }, match: { type: "array", items: { type: "string" } } }, required: ["value"] }, description: "profile: save custom details you already know (a redirect address, the app name you chose) into a profile, same shape as ask_fields answers: {key: {label, value, match}}." },
      vendor: { type: "string", description: "capture_secret: the vendor the key is for, recorded with it." },
      owner: { type: "string", description: "capture_secret: the account the key or app belongs to (default: the profile's sign-in email)." },
      env: { type: "string", description: "capture_secret: production, sandbox or test." },
      task: { type: "object", additionalProperties: false, properties: { vendor: { type: "string" }, kind: { type: "string", enum: ["oauth-app", "api-key", "test-account", "webhook", "other"] }, status: { type: "string", enum: ["queued", "working", "done", "needs-human", "blocked", "no-self-serve"] }, reason: { type: "string", enum: ["captcha", "sms", "email", "payment", "identity", "review", "two-factor", "no-logo", "unsupported-protocol", "other"] }, note: { type: "string" }, owner: { type: "string" }, connectors: { type: "array", items: { type: "string" } } }, required: ["vendor"], description: "queue: record or update one vendor task (one per vendor and kind). Set status needs-human with a reason when a person must act (captcha, sms, payment), done when finished, blocked when it cannot be done. Always record the outcome here instead of only saying it." },
      bodies: { type: "boolean", description: "network: also show request and answer bodies (truncated, key-like values hidden). Default: shapes only." },
      tasks: { type: "boolean", description: "queue: list the tasks (filter with task_status, task_reason) with a summary." },
      task_status: { type: "string" },
      task_reason: { type: "string" },
      secret_name: { type: "string", description: `capture_secret: name to save the key under (default: the site's name plus "/key").` },
      send_to: { ...SEND_TO_SCHEMA, description: "capture_secret: " + SEND_TO_HELP }
    } };
    WEB_DESCRIPTION = [
      "Drive ClikCode's own Chrome (its own saved profile; it starts by itself). open and observe return the page, with a [ref=\u2026] on each element: pass a ref as target (or visible text) to click or fill. After an action you get only what changed (and any open dialog); observe shows the whole page again. A new tab or popup the page opens is followed automatically.",
      'Actions: open (a URL) \xB7 observe (the page again; full: true adds header and footer; find: "words" shows only the lines that mention them, for a long page) \xB7 click \xB7 fill \xB7 choose (an option of a dropdown: target + text) \xB7 press \xB7 scroll \xB7 wait (for text to appear or go, up to 2 minutes; for jobs that finish on their own) \xB7 steps (several of those in order, one call, stops at the first failure) \xB7 login \xB7 handoff \xB7 capture_secret \xB7 profile \xB7 open_email_link (find the newest email from a sender in the signed-in Gmail and open a link in it, one call: verification and sign-in emails) \xB7 upload (a file input or its button + text: the name of a profile file detail ending _file such as logo_file; only files the user saved in the profile can be sent) \xB7 notes (read or add what was learned on a site: the URL that worked, the order of screens, what was missing; shown again whenever a page on that host is opened, so write one when a task finally works) \xB7 recipe (save the steps of a signup or key capture that worked, by control text, never secrets; run replays them and stops for the user at a captcha, code, payment or review page; list) \xB7 email_connect (one consent in this browser connects the signed-in Gmail; after that read_email_code and open_email_link read mail through the Gmail API, wait for it to arrive, and return only the code or the link) \xB7 oauth_connect (target = a ClikDeploy connector id: starts its OAuth connect, presses through the vendor consent screens in this signed-in browser (account named by the profile sso_email, Advanced / Go to ... (unsafe), Continue / Allow / Authorize), stops with a plain reason at a login password, MFA code, captcha or an unknown screen (sign in first with login), and confirms ClikDeploy shows an active connection) \xB7 read_email_code (the one-time code in the newest email from a sender, read in a tab of its own, so a sign-up that wants an emailed code does not need the user) \xB7 forget_login (remove the saved login for a site from the vault: target = the site, label = one account; returns only a count; use it for a login the site keeps refusing) \xB7 close.',
      "Each chat has its own tab. The user's autofill profile (name, email, phone, address, and any custom details you asked for with profile ask_fields) fills forms for you: fill a field with no text and it is filled from the profile, or the user is asked once and the answer is kept. If a site wants another format, fill that field with the exact text, and save the corrected value with action profile and fields. When a site offers Continue/Sign in with Google and the browser is already signed in to Google, prefer it: no new password or email check. If it offers GitHub and not Google, use Continue with GitHub (sign in to GitHub with the saved login; there is no Google sign-in inside GitHub). Only when neither is offered, fill the form with no text: the profile email fills it, and on a sign-up every password box gets a strong password made up for that site (fitted to what the page asks, retried if the site refuses it, saved with the login, never shown to you); a later sign-in fills the saved login. Every page can be read, including sign-in and signup forms; the values of password, code and card fields are masked. For anything only the user knows (a password, a code, an address, a phone number), fill the field with no text: a saved login for the site or the profile fills it, else the user is asked privately, and you are not shown the answer. That is all a sign-in or signup needs: fill the fields, click Next, repeat. (login does the same in one action for a plain email-then-password sign-in.) Never ask for a password or code in chat. When a sign-in page offers different ways in (root or IAM, another account), ask the user with ask_user, click their choice, then login. handoff returns a phone link for a CAPTCHA or MFA at once; give it to the user, then call handoff again to wait until they finish.",
      "Work through the whole task you were given without checking in at each step. Ask real choices (project, account, role set) once, up front, in one question; after that ask only when genuinely blocked (a sign-in they must type, a payment).",
      "API keys: go to the key page, set the options, then capture_secret with target = the final Create button and a send_to plan. It presses the site's Copy button or reads the file it hands over, checks the key against its service, saves it to ClikCode Secrets Manager and sends it where send_to says. You never see the key. With no target it takes a key the page already shows; never click Regenerate just to see one."
    ].join("\n");
    computerWebTool = defineTool({
      name: "computer_web",
      class: "exec",
      description: WEB_DESCRIPTION,
      // Open on purpose: a chat keeps the argument list it started with, and the reloaded code (hot-tools.ts) understands more.
      parameters: WEB_PARAMETERS,
      label: (args) => {
        const host = () => {
          try {
            return new URL(args.url ?? "").hostname.replace(/^www\./, "");
          } catch {
            return args.url?.slice(0, 60) ?? "";
          }
        };
        switch (args.action) {
          case "open":
            return `Open ${host()}`;
          case "observe":
            return "Look at the page";
          case "click":
            return `Click ${args.target ?? ""}`.trim();
          case "fill":
            return `Fill ${args.target ?? ""}`.trim();
          case "press":
            return `Press ${args.key ?? ""}`.trim();
          case "wait":
            return `Wait for ${args.text ? `"${args.text}"` : `${args.seconds ?? 30}s`}`;
          case "steps":
            return `${args.steps?.length ?? 0} steps on the page`;
          case "login":
            return "Sign in";
          case "handoff":
            return "Hand off to phone";
          case "capture_secret":
            return `Capture key${args.secret_name ? ` as ${args.secret_name}` : ""}`;
          case "close":
            return "Close browser";
          default:
            return `Web ${args.action}`;
        }
      },
      describe: async (args) => `ClikCode browser: ${args.action}${args.url ? ` ${args.url}` : ""}${args.target ? ` ${args.target}` : ""}${args.action === "fill" ? ` (${args.text?.length ?? 0} characters)` : ""}`,
      // One chat's browser calls run in the order they were made. The model can send two at once (a capture and
      // the click that closes the dialog it reads), and a one-time key does not survive that race.
      run: (args, hostCtx) => inOrder(args.tab ? `${hostCtx.stateDir}#${args.tab}` : hostCtx.stateDir, async () => {
        const ctx = await unattendedEnabled(hostCtx.stateDir) && hostCtx.requestPrivateLogin ? { ...hostCtx, requestPrivateLogin: (site, fields, signal) => site === "https://profile.clikcode" ? hostCtx.requestPrivateLogin(site, fields, signal) : park(hostCtx.stateDir, site, fields) } : hostCtx;
        try {
          if (!await computerEnabled(ctx.stateDir)) throw new Error(COMPUTER_OFF);
          if (args.action === "help") return { output: `${WEB_DESCRIPTION}

Arguments: ${Object.entries(WEB_PARAMETERS.properties).map(([name, spec]) => `${name}${spec.description ? ` (${spec.description})` : ""}`).join("; ")}` };
          if (!ACTION_LIST.split(" \xB7 ").includes(String(args.action))) throw new Error(`Unknown action "${String(args.action)}". Actions: ${ACTION_LIST}.`);
          if (args.action === "send_secret") return storeSecretTool.run({ secret: args.secret ?? "", ...args.to ? { to: args.to } : {}, ...args.with ? { with: args.with } : {}, ...args.send_to ? { send_to: args.send_to } : {} }, ctx);
          if (args.action === "preflight") {
            const { runPreflightHere: runPreflightHere2 } = await Promise.resolve().then(() => (init_preflight(), preflight_exports));
            const result = await runPreflightHere2(ctx.stateDir, ...ctx.signal ? [{ signal: ctx.signal }] : []);
            return { output: JSON.stringify(result, null, 2), ...result.ok ? {} : { isError: true } };
          }
          if (args.action === "queue") {
            const { describeTask: describeTask2, listTasks: listTasks2, saveTask: saveTask2, summarizeTasks: summarizeTasks2 } = await Promise.resolve().then(() => (init_work_queue(), work_queue_exports));
            if (args.task) return { output: `Recorded. ${describeTask2(await saveTask2(ctx.stateDir, args.task))}` };
            const all = await listTasks2(ctx.stateDir, { ...args.task_status ? { status: args.task_status } : {}, ...args.task_reason ? { reason: args.task_reason } : {} });
            return { output: `${summarizeTasks2(all)}
${all.map(describeTask2).join("\n")}` };
          }
          if (args.action === "profile") {
            const known = args.custom && Object.keys(args.custom).length ? args.custom : void 0;
            if (args.fields && Object.keys(args.fields).length || known) return { output: `Saved. ${describeProfile(await saveProfile(ctx.stateDir, { ...args.label ? { label: args.label } : {}, fields: args.fields ?? {}, ...known ? { custom: known } : {} }))}` };
            const all = await listProfiles(ctx.stateDir);
            if (args.ask_fields?.length) {
              if (!ctx.requestPrivateLogin) throw new Error("This chat cannot ask the user privately. Save details you know with custom, or the user can run: clikcode computer profile --custom key=value");
              for (const spec of args.ask_fields) {
                if (spec.secret) assertCustomKey(spec.key, true);
                else if (!isStandardKey(spec.key)) assertCustomKey(spec.key);
                if (!spec.label?.trim()) throw new Error(`ask_fields "${spec.key}" needs a label: it is what the user is asked.`);
              }
              const target = args.label ? all.find((profile) => profile.label.toLowerCase() === args.label.toLowerCase()) : defaultProfile(all);
              const prompt = args.ask_fields.map((spec, index) => ({ index, key: spec.key, label: spec.label.trim(), kind: spec.secret ? "password" : spec.options?.length ? "choice" : "text", required: !spec.optional, ...spec.options?.length ? { options: spec.options } : {}, ...spec.format ? { format: spec.format } : {}, ...isStandardKey(spec.key) ? target?.fields[spec.key] ? { current: target.fields[spec.key] } : {} : target?.custom?.[spec.key]?.value ? { current: target.custom[spec.key].value } : {} }));
              const answers = await ctx.requestPrivateLogin("https://profile.clikcode", prompt, ctx.signal);
              if (!answers) throw new Error("The user did not provide the details.");
              const answered = args.ask_fields.filter((spec) => !spec.secret && (answers[spec.key] ?? "").trim());
              const secretAnswers = args.ask_fields.filter((spec) => spec.secret && (answers[spec.key] ?? "").length);
              const fields = Object.fromEntries(answered.filter((spec) => isStandardKey(spec.key)).map((spec) => [spec.key, answers[spec.key]]));
              const custom = Object.fromEntries(answered.filter((spec) => !isStandardKey(spec.key)).map((spec) => [spec.key, { label: spec.label, value: answers[spec.key], ...spec.match ? { match: spec.match } : {} }]));
              const saved = await saveProfile(ctx.stateDir, { ...target ? { id: target.id } : { label: args.label?.trim() || "Custom" }, fields, custom });
              for (const spec of secretAnswers) {
                registerSecret(answers[spec.key]);
                await saveProfileSecret(ctx.stateDir, saved.id, spec.key, answers[spec.key], { label: spec.label, ...spec.match ? { match: spec.match } : {} });
              }
              return { output: `Saved. ${describeProfile(secretAnswers.length ? (await listProfiles(ctx.stateDir)).find((item) => item.id === saved.id) ?? saved : saved)}` };
            }
            if (args.ask || !all.length) {
              if (!ctx.requestPrivateLogin) throw new Error("This chat cannot ask the user privately. Save a profile with fields, or the user can run: clikcode computer profile --set key=value");
              const current = (args.label ? all.find((profile) => profile.label.toLowerCase() === args.label.toLowerCase()) : defaultProfile(all))?.fields ?? {};
              const asked = PROFILE_PROMPT.map(([key, label, required], index) => ({ index, key, label, kind: "text", required, ...PROFILE_FORMATS[key] ? { format: PROFILE_FORMATS[key] } : {}, ...current[key] ? { current: current[key] } : {} }));
              const answers = await ctx.requestPrivateLogin("https://profile.clikcode", asked, ctx.signal);
              if (!answers) throw new Error("The user did not provide the profile.");
              return { output: `Saved. ${describeProfile(await saveProfile(ctx.stateDir, { ...args.label ? { label: args.label } : defaultProfile(all) ? { id: defaultProfile(all).id } : {}, fields: answers }))}` };
            }
            return { output: all.map(describeProfile).join("\n") };
          }
          if (args.action === "close") {
            await closeComputerPage(ctx.stateDir, args.tab);
            return { output: "This chat's tab is closed." };
          }
          if (args.action === "forget_login") {
            const site = args.target?.trim() || args.host?.trim() || args.url?.trim();
            if (!site) throw new Error("forget_login needs the site in target (a host such as wordnik.com, or a URL).");
            const count = await forgetSavedLogins(ctx.stateDir, site, args.label);
            return { output: count ? `Removed ${count} saved login${count === 1 ? "" : "s"} for ${site.replace(/^https?:\/\//, "").split("/")[0]}.` : `No saved login for ${site.replace(/^https?:\/\//, "").split("/")[0]}${args.label ? " with that label" : ""}.` };
          }
          if (args.action === "open") webAddress(args.url);
          const page = args.action === "open" || args.action === "open_email_link" || args.action === "email_connect" || args.action === "oauth_connect" ? await openComputerPage(ctx.stateDir, args.tab) : await computerPage(ctx.stateDir, args.tab);
          let onAbort = () => void 0;
          const stopped = new Promise((_resolve, reject) => {
            onAbort = () => reject(new Error("Stopped."));
          });
          stopped.catch(() => void 0);
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          try {
            if (ctx.signal?.aborted) throw new Error("Stopped.");
            const done = await Promise.race([stopped, act(page, args, ctx)]);
            return done.isError ? done : withSignInHints(done, await computerPage(ctx.stateDir, args.tab).catch(() => page), ctx.stateDir);
          } finally {
            ctx.signal?.removeEventListener("abort", onAbort);
          }
        } catch (error) {
          if (error instanceof Parked) return { output: error.message, isError: true };
          if (args.action === "login") return { output: error instanceof LoginError ? error.message : "Private login did not finish. Check the browser and try again.", isError: true };
          if (args.action === "capture_secret") {
            const why = error instanceof Error ? error.message : String(error);
            const clicked = error.afterClick ? ` The click on "${args.target ?? "the button"}" may already have created a key at the site; if so, delete it there.` : "";
            const siteSaid = error.afterClick ? await pageProblem(await computerPage(ctx.stateDir, args.tab).catch(() => void 0)) : "";
            return { output: scrubSecrets(`${why.startsWith("Not saved") ? why : `Not saved: ${why}`}${siteSaid ? ` The page says: "${siteSaid}".` : ""}${clicked}`), isError: true };
          }
          return { output: error instanceof Error ? error.message : String(error), isError: true };
        }
      })
    });
    queues = sharedState("computer-web-queue", () => /* @__PURE__ */ new Map());
    handoffs = sharedState("handoffs", () => /* @__PURE__ */ new Map());
    INTERACTIONS = /* @__PURE__ */ new Set(["click", "fill", "choose", "press", "scroll", "wait", "upload"]);
    PROFILE_FORMATS = { phone: "phone", birthday: "date" };
    PROFILE_PROMPT = [["given_name", "First name", true], ["family_name", "Last name", true], ["email", "Email", true], ["phone", "Phone (with area code)", true], ["address_line1", "Street address", true], ["address_line2", "Apartment / suite (optional)", false], ["city", "City", true], ["state", "State", true], ["postal_code", "Zip / postal code", true], ["country", "Country", true], ["organization", "Company (optional)", false], ["birthday", "Date of birth (month/day/year)", false]];
    profileChoice = sharedState("profile-choice", () => /* @__PURE__ */ new Map());
    CODE_BOX = /one-time-code|\b(?:otp|verification|security|passcode|confirmation|pin|digit|code|character)\b/i;
  }
});

// src/session/store/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function stateDirectory() {
  return process.env.CLIKCODE_HOME?.trim() || join(homedir(), ".clikcode");
}

// src/agent/computer/keygrab-live.ts
init_secret_scrubber();
import { mkdtemp } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";
var TAB = "connectors";
var clean = (text) => scrubSecrets(text).replace(/\s+/g, " ").trim().slice(0, 300);
async function lookAt(page) {
  const seen = await page.evaluate(() => {
    const doc = globalThis.document;
    const norm = (t) => (t ?? "").replace(/\s+/g, " ").trim();
    const pressable = "button, [role=button], a, [role=link], [role=menuitem], input[type=submit], input[type=button], summary";
    const controls = [];
    const seenNames = /* @__PURE__ */ new Set();
    for (const n of Array.from(doc.querySelectorAll(`${pressable}, span, div, p, li, label`)).slice(0, 1500)) {
      if (!n.getClientRects().length) continue;
      const isPress = n.matches(pressable);
      if (!isPress && n.children.length) continue;
      const name = norm(n.getAttribute("aria-label") || n.value || n.textContent);
      if (!name || name.length > 120) continue;
      const key = `${isPress}|${name}`;
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      controls.push({ name, leaf: !isPress, ...n.tagName === "A" && n.href ? { href: n.href } : {} });
    }
    const fields = [];
    let hasPassword = false;
    for (const n of Array.from(doc.querySelectorAll("input, textarea"))) {
      if (!n.getClientRects().length || /^(hidden|checkbox|radio|submit|button|file|image)$/.test(n.type ?? "")) continue;
      if (n.type === "password") hasPassword = true;
      const name = norm(n.getAttribute("aria-label")) || norm(n.labels?.[0]?.textContent) || norm(n.getAttribute("placeholder"));
      if (name && !fields.includes(name)) fields.push(name);
    }
    return { text: (doc.body?.innerText ?? "").slice(0, 6e3), controls, fields, hasPassword };
  }).catch(() => ({ text: "", controls: [], fields: [], hasPassword: false }));
  return { url: page.url(), ...seen };
}
async function liveKeygrabPort(options) {
  const { computerWebTool: computerWebTool2 } = await Promise.resolve().then(() => (init_computer_web(), computer_web_exports));
  const { computerPage: computerPage2 } = await Promise.resolve().then(() => (init_browser(), browser_exports));
  const { listProfiles: listProfiles2 } = await Promise.resolve().then(() => (init_profiles(), profiles_exports));
  const ctx = { stateDir: options.stateDir, ...options.signal ? { signal: options.signal } : {} };
  const run = (args) => computerWebTool2.run({ tab: TAB, ...args }, ctx);
  const page = () => computerPage2(options.stateDir, TAB);
  const shots = options.screenshotDir ?? (() => mkdtemp(join2(tmpdir2(), "clikcode-connector-shots-")));
  const failed = (r) => r.isError ? clean(r.output) : void 0;
  return {
    open: async (url2) => failed(await run({ action: "open", url: url2 })),
    look: async () => lookAt(await page()),
    click: async (name) => failed(await run({ action: "click", target: name })),
    fill: async (name, text) => failed(await run({ action: "fill", target: name, ...text !== void 0 ? { text } : {} })),
    login: async () => {
      const r = await run({ action: "login" });
      return { ok: !r.isError, message: clean(r.output.split("\n")[0] ?? "") };
    },
    emailCode: async () => {
      for (const subject of ["verification", "code", "confirm"]) {
        const r = await run({ action: "read_email_code", subject, seconds: 45 });
        const code = r.isError ? void 0 : /Code:\s*([A-Za-z0-9-]{4,10})\b/.exec(r.output)?.[1];
        if (code) return code;
      }
      return void 0;
    },
    emailLink: async () => {
      for (const subject of ["verify", "confirm", "welcome"]) if (!(await run({ action: "open_email_link", subject, seconds: 45 })).isError) return true;
      return false;
    },
    capture: async (target) => {
      const r = await run({ action: "capture_secret", ...target ? { target } : {}, secret_name: `${options.id}/key`, vendor: options.id, send_to: [{ to: "clikdeploy-connection", with: { integration: options.id } }] });
      return { ok: !r.isError, message: clean(r.output) };
    },
    screenshot: async () => {
      try {
        const p = await page();
        if (p.isClosed()) return void 0;
        const path12 = join2(await shots(), `${options.id}.png`);
        await p.screenshot({ path: path12, timeout: 1e4 });
        return path12;
      } catch {
        return void 0;
      }
    },
    profileEmail: async () => (await listProfiles2(options.stateDir)).map((profile) => profile.fields.sso_email).find(Boolean)
  };
}

// ../../../../tmp/kgdbg/dbg.ts
init_browser();
var [, , url, ...cmds] = process.argv;
var port = await liveKeygrabPort({ stateDir: stateDirectory(), id: "dbg" });
var show = async () => {
  const v = await port.look();
  console.log("URL", v.url, "pw", v.hasPassword, "fields", v.fields);
  console.log("TEXT", v.text.replace(/\s+/g, " ").slice(0, 600));
  console.log("CTRL", v.controls.filter((c) => !c.leaf).map((c) => c.name).slice(0, 40));
};
try {
  console.log("open", await port.open(url));
  await show();
  for (const c of cmds) {
    console.log("click", c, await port.click(c));
    await new Promise((r) => setTimeout(r, 2500));
    await show();
  }
} finally {
  await closeComputerPage(stateDirectory(), "connectors").catch(() => {
  });
  await releaseComputerBrowser(stateDirectory()).catch(() => {
  });
  process.exit(0);
}
