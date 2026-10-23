#!/usr/bin/env node
/**
 * 真实浏览器渲染截图
 * ================
 *
 * test-ui.mjs 用 jsdom 跑视图代码，能验证逻辑，但**看不到真实渲染效果**——
 * jsdom 不是浏览器，不做布局、不应用 CSS。
 *
 * 本脚本改用真正的 Chromium（Electron）来跑同一套视图代码并截图，
 * 用于确认：
 *
 *   1. 视图在真实浏览器里不报错
 *   2. CSS 真的生效、布局正常、没有重叠或塌陷
 *   3. 产出的图片可直接放进 README
 *
 * 只使用仓库自带的 examples/示例题库（原创题），不读取任何真题数据。
 *
 * 用法：node scripts/shoot.mjs [输出目录]
 */

import esbuild from "esbuild";
import { readFile, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const root = process.argv[2] || path.join(projectRoot, "examples", "示例题库");
const outDir = process.argv[3] || path.join(projectRoot, "screenshots");
const viewType =
	process.argv[4] || process.env.XC_VIEW || "xingce-practice-view";
const outFile = process.argv[5] || process.env.XC_FILE || "practice.png";

const STUB = `
export class TFile {
  constructor(p) {
    this.path = p;
    this.stat = { mtime: 0, ctime: 0, size: 0 };
    this.basename = String(p).replace(/^.*\\//, "").replace(/\\.md$/, "");
    this.extension = "md";
    this.name = String(p).replace(/^.*\\//, "");
  }
}
export class TFolder {
  constructor(p) { this.path = p; this.name = String(p).replace(/^.*\\//, ""); }
}
export class App {}
export class Events {
  on() { return {}; }
  off() {}
  offref() {}
  trigger() {}
}
export class Component extends Events {
  constructor() { super(); this._children = []; }
  onload() {}
  onunload() {}
  addChild(c) { this._children.push(c); return c; }
  removeChild() {}
  register(cb) { return cb; }
  registerEvent(ref) { return ref; }
  registerDomEvent() {}
  registerInterval(id) { return id; }
  load() {}
  unload() {}
}
export class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this.commands = [];
    this.views = new Map();
    this.settingTabs = [];
    this.ribbons = [];
    this._data = globalThis.__XC_SAVED_DATA ?? null;
  }
  addCommand(c) { this.commands.push(c); return c; }
  addRibbonIcon(icon, title, cb) {
    this.ribbons.push({ icon, title, cb });
    return document.createElement("div");
  }
  addSettingTab(t) { this.settingTabs.push(t); return t; }
  registerView(type, factory) { this.views.set(type, factory); }
  async loadData() { return this._data; }
  async saveData(d) { this._data = d; globalThis.__XC_SAVED_DATA = d; }
}
export class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.contentEl = document.createElement("div");
    this.containerEl = document.createElement("div");
    this.app = leaf ? leaf.app : null;
  }
}
export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
  display() {}
  hide() {}
}
export class Modal {
  constructor(app) { this.app = app; this.contentEl = document.createElement("div"); }
  open() { Modal.last = this; }
  close() { if (this.contentEl && this.contentEl.empty) this.contentEl.empty(); }
  onOpen() {}
  onClose() {}
}
export class Setting {
  constructor(el) { this.settingEl = el; }
  setName() { return this; }
  setDesc() { return this; }
  setClass() { return this; }
  addText(cb) { cb(this._ctl()); return this; }
  addToggle(cb) { cb(this._ctl()); return this; }
  addDropdown(cb) { cb(this._ctl()); return this; }
  addSlider(cb) { cb(this._ctl()); return this; }
  addButton(cb) { cb(this._ctl()); return this; }
  _ctl() {
    return {
      inputEl: document.createElement("input"),
      toggleEl: document.createElement("div"),
      selectEl: document.createElement("select"),
      buttonEl: document.createElement("button"),
      sliderEl: document.createElement("div"),
      setPlaceholder() { return this; },
      setValue() { return this; },
      setButtonText() { return this; },
      setCta() { return this; },
      setTooltip() { return this; },
      setDynamicTooltip() { return this; },
      setLimits() { return this; },
      setRange() { return this; },
      addOption() { return this; },
      onChange() { return this; },
      onClick() { return this; },
    };
  }
}
export class Notice {
  constructor(msg) {
    Notice.last = String(msg);
    Notice.count = (Notice.count || 0) + 1;
  }
}
export class WorkspaceLeaf {}

// 极简 Markdown 渲染，够用于验证布局
function mdToHtml(md) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out = [];
  for (const line of String(md).split(/\\n/)) {
    let t = line;
    t = t.replace(/!\\[\\[([^\\]|]+)\\]\\]/g, (_m, p1) => {
      const [p, size] = p1.split("|");
      return '<div class="xc-img"><img alt="" src="' + p + '"' + (size ? ' style="width:' + size.split("x")[0] + 'px"' : "") + " /></div>";
    });
    t = t.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    t = t.replace(/^####\\s+(.*)$/, "<h4>$1</h4>");
    t = t.replace(/^###\\s+(.*)$/, "<h3>$1</h3>");
    t = t.replace(/^##\\s+(.*)$/, "<h2>$1</h2>");
    t = t.replace(/^#\\s+(.*)$/, "<h1>$1</h1>");
    t = t.replace(/^>\\s+(.*)$/, "<blockquote>$1</blockquote>");
    t = t.replace(/^-\\s+(.*)$/, "<li>$1</li>");
    out.push(t);
  }
  return out.join("<br>");
}

export class MarkdownRenderer {
  static async render(app, markdown, el, sourcePath, component) {
    el.innerHTML = mdToHtml(markdown);
  }
}

export function normalizePath(p) {
  return String(p).replace(/\\\\/g, "/");
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
`;

// ---------------------------------------------------------------
// 1. 打包 UI bundle（把 obsidian 换成桩）
// ---------------------------------------------------------------
const tmpDir = path.join(projectRoot, "scripts", ".shoot");
await mkdir(tmpDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const stubPath = path.join(tmpDir, "obsidian-stub.mjs");
const entryPath = path.join(tmpDir, "entry.ts");
const bundlePath = path.join(tmpDir, "ui-bundle.js");

await writeFile(stubPath, STUB, "utf8");
await writeFile(
	entryPath,
	[
		`export { default as XingcePlugin } from ${JSON.stringify(
			path.join(projectRoot, "src", "main.ts").replace(/\\/g, "/")
		)};`,
		`export { PracticeView, VIEW_TYPE_PRACTICE } from ${JSON.stringify(
			path
				.join(projectRoot, "src", "views", "practice-view.ts")
				.replace(/\\/g, "/")
		)};`,
		`export { ExamView, VIEW_TYPE_EXAM } from ${JSON.stringify(
			path.join(projectRoot, "src", "views", "exam-view.ts").replace(/\\/g, "/")
		)};`,
		`export { Bank } from ${JSON.stringify(
			path.join(projectRoot, "src", "bank.ts").replace(/\\/g, "/")
		)};`,
		`export { ImportModal } from ${JSON.stringify(
			path
				.join(projectRoot, "src", "views", "import-modal.ts")
				.replace(/\\/g, "/")
		)};`,
		// 关键：把桩里的 TFile 一并导出，供 harness 复用同一个类。
		// 否则 bundle 内的 stub 副本与 harness 各持一份 TFile，
		// hydrate() 里的 `af instanceof TFile` 恒为 false，抽题结果为空。
		'export { TFile } from "obsidian";',
	].join("\n"),
	"utf8"
);

await esbuild.build({
	entryPoints: [entryPath],
	bundle: true,
	format: "iife",
	globalName: "XingceBundle",
	platform: "browser",
	target: "chrome120",
	alias: { obsidian: stubPath },
	outfile: bundlePath,
	logLevel: "warning",
});

// ---------------------------------------------------------------
// 2. 准备 harness：注入文件内容（避免浏览器里用 fs）
// ---------------------------------------------------------------
async function collect(dir, base = dir, acc = {}) {
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) await collect(p, base, acc);
		else if (e.isFile() && e.name.endsWith(".md")) {
			acc[path.relative(base, p).replace(/\\/g, "/")] = await readFile(
				p,
				"utf8"
			);
		}
	}
	return acc;
}

const files = await collect(root);
const bundleJs = await readFile(bundlePath, "utf8");
const css = await readFile(path.join(projectRoot, "styles.css"), "utf8");

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
:root{
  --background-primary:#ffffff;
  --background-primary-alt:#fafafa;
  --background-secondary:#f2f3f5;
  --background-secondary-alt:#e9e9e9;
  --background-modifier-border:#e0e0e0;
  --background-modifier-form-field:#ffffff;
  --background-modifier-hover:rgba(0,0,0,.06);
  --background-modifier-active-hover:rgba(0,0,0,.12);
  --text-normal:#2e3338;
  --text-muted:#6a6a6a;
  --text-faint:#999999;
  --text-accent:#7f6df2;
  --text-accent-hover:#8b7ff5;
  --text-selection:rgba(127,109,242,.2);
  --text-highlight-bg:#fff8c4;
  --text-on-accent:#ffffff;
  --interactive-normal:#f2f3f5;
  --interactive-hover:#e9e9e9;
  --interactive-accent:#7f6df2;
  --interactive-accent-hover:#6c5ae0;
  --background-modifier-error:#e15b64;
  --background-modifier-success:#3fb950;
  --radius-s:4px; --radius-m:6px; --radius-l:10px;
  --font-text-size:15px;
  --font-ui-smaller:13px;
  --font-ui-small:14px;
  --font-ui-medium:15px;
  --line-height-normal:1.5;
}
body{margin:0;padding:0;background:var(--background-primary);color:var(--text-normal);
font-family:-apple-system,"Segoe UI",system-ui,sans-serif;font-size:var(--font-text-size);}
</style>
<style>${css}</style>
</head>
<body>
<div id="xc-host"></div>
<script>
// ---- Obsidian 在 HTMLElement 上挂的便捷方法 ----
for (const P of [HTMLElement.prototype, DocumentFragment.prototype]) {
  P.createEl = function (tag, o, cb) {
    const el = document.createElement(tag);
    if (typeof o === "string") el.className = o.replace(/^\\./, "").split(".").join(" ");
    else if (o && typeof o === "object") {
      if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
      if (o.text != null) el.textContent = String(o.text);
      if (o.title) el.setAttribute("aria-label", String(o.title));
      if (o.href) el.setAttribute("href", String(o.href));
      if (o.type) el.setAttribute("type", String(o.type));
      if (o.placeholder) el.setAttribute("placeholder", String(o.placeholder));
      if (o.value != null) el.setAttribute("value", String(o.value));
      if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
    }
    this.appendChild(el);
    if (cb) cb(el);
    return el;
  };
  P.createDiv = function (o, cb) { return this.createEl("div", o, cb); };
  P.createSpan = function (o, cb) { return this.createEl("span", o, cb); };
  P.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  P.addClass = function (...c) { this.classList.add(...c); return this; };
  P.removeClass = function (...c) { this.classList.remove(...c); return this; };
  P.toggleClass = function (c, v) { this.classList.toggle(c, v); return this; };
  P.setText = function (t) { this.textContent = String(t); return this; };
  P.appendText = function (t) { this.appendChild(document.createTextNode(String(t))); return this; };
  P.detach = function () { this.remove && this.remove(); };
}
</script>
<script>globalThis.__XC_FILES = ${JSON.stringify(files)};</script>
<script>${bundleJs}</script>
<script>
(async () => {
  const B = window.XingceBundle;
  const log = [];
  // ---- 构造 mock App：vault 用注入的文件内容 ----
  const FILES = globalThis.__XC_FILES || {};
  // 复用 bundle 里那一份 TFile：hydrate() 靠 instanceof 判断，
  // 两边必须是同一个类，否则抽不到题。
  const TFile = B.TFile;
  class Adapter {
    async exists(p) { return Object.prototype.hasOwnProperty.call(FILES, p); }
    async read(p) { if (!(p in FILES)) throw new Error("ENOENT " + p); return FILES[p]; }
    async write(p, d) { FILES[p] = d; }
    async mkdir() {}
    async list() { return { folders: [], files: Object.keys(FILES) }; }
    async remove() {}
    getResourcePath(p) { return p; }
  }
  const tfiles = Object.keys(FILES).map((p) => new TFile(p));
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter: new Adapter(),
      getMarkdownFiles() { return tfiles; },
      getAbstractFileByPath(p) { return tfiles.find((f) => f.path === p) || null; },
      getName() { return "obsidian-test-vault"; },
      cachedRead(f) { return FILES[f.path]; },
      read(f) { return FILES[f.path]; },
    },
    workspace: {
      getLeavesOfType() { return []; },
      getRightLeaf() { return null; },
      revealLeaf() {},
      getActiveFile() { return null; },
    },
    fileManager: { generateMarkdownLink() { return ""; } },
    metadataCache: { getFileCache() { return null; } },
  };

  const plugin = new B.XingcePlugin(app, { id: "obsidian-xingce", version: "0.1.0" });
  await plugin.onload();

  const host = document.getElementById("xc-host");

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let view = null;
  let drawDiag = null;

  if (process.env.XC_IMPORT === "1") {
    // 导入弹窗模式：填好示例 CSV → 打开弹窗 → 点预览，展示统计
    const modal = new B.ImportModal(app, plugin);
    modal.text = [
      "模块,试卷,地区,年份,考点,材料,题干,选项A,选项B,选项C,选项D,答案,解析",
      "常识判断,示例卷,示例,2026,地理,,下列说法正确的是？,地球是平的,地球是球体,太阳绕地球转,月球是恒星,B,（解析占位）",
      "资料分析,示例卷,示例,2026,增长率,<p>2025 年营收 120000 亿，增长 8%</p>,2024 年营收约多少？,111111 亿,105000 亿,96000 亿,130000 亿,A,（解析占位）",
    ].join("\\n");
    modal.filename = "我的题库.csv";
    modal.onOpen();
    host.appendChild(modal.contentEl);
    const pv = modal.contentEl.querySelector(".mod-cta");
    if (pv) pv.click();
    await wait(500);
    view = { session: null, contentEl: modal.contentEl };
  } else {
    // 不走 activatePracticeView()：那里依赖 workspace.getRightLeaf()，
    // 桩里没有真实 leaf。registerView 存的是工厂函数，直接调用即可。
    const VIEW_TYPE = ${JSON.stringify(viewType)};
    const factory = plugin.views.get(VIEW_TYPE);
    if (!factory) throw new Error("视图未注册：" + VIEW_TYPE);
    const leaf = { app, view: null, setViewState: async () => {} };
    view = factory(leaf);
    leaf.view = view;
    host.appendChild(view.contentEl);
    await view.onOpen();
    await wait(300);

    drawDiag = null;
    try {
      const r = await plugin.bank.draw(plugin.filterState, 3);
      drawDiag = "len=" + r.length + " first=" + (r[0] ? r[0].uid : "none");
    } catch (e) { drawDiag = "ERR " + e.message; }

    if (VIEW_TYPE === "xingce-practice-view") {
      if (process.env.XC_SETUP === "1") {
        // 仅渲染筛选 / 设置界面（含智能 / 随机模式切换），不进入答题态
        await wait(600);
      } else {
        await view.quickDraw(3);
        // quickDraw 内部不 await 异步 render，这里轮询等 DOM 出现
        for (let i = 0; i < 50; i++) {
          if (host.querySelector(".xc-option")) break;
          await wait(200);
        }
        const q = view.session && view.session.questions[view.session.idx];
        const opt = host.querySelector(".xc-option");
        if (opt) opt.click();
        await wait(400);
        const sub = host.querySelector(".xc-submit-bar .xc-btn-primary");
        if (sub && !sub.disabled) sub.click();
        await wait(400);
        if (!host.querySelector(".xc-verdict") && q && typeof view.commit === "function") {
          const wrongOpt = q.options.find(
            (o) => !(q.correctKeys || []).includes(o.key)
          );
          view.commit(q, wrongOpt ? [wrongOpt.key] : ["X"]);
          await view.render();
        }
        for (let i = 0; i < 30; i++) {
          if (host.querySelector(".xc-verdict")) break;
          await wait(200);
        }
      }
    } else {
      await wait(600);
    }
  }

  window.__XC_DIAG = {
    hasOption: !!host.querySelector(".xc-option"),
    hasVerdict: !!host.querySelector(".xc-verdict"),
    verdictText: (host.querySelector(".xc-verdict") || {}).textContent || "",
    hasExplanation: !!host.querySelector(".xc-explanation"),
    childCount: host.children.length,
    bankSize: plugin.bank.size,
    drawDiag: drawDiag,
    filterState: JSON.parse(JSON.stringify(plugin.filterState)),
    entryCount: plugin.bank.all().length,
    filteredCount: plugin.bank.filter(plugin.filterState).length,
    sample: plugin.bank.all()[0] || null,
    incompleteFlags: plugin.bank.all().map((e) => e.incomplete),
    hasSession: !!view.session,
    sessionLen: view.session ? view.session.questions.length : 0,
    rootClass: view.contentEl.className,
    htmlHead: view.contentEl.innerHTML.slice(0, 400),
  };
  window.__XC_READY = true;
})().catch((e) => { window.__XC_ERROR = String(e && e.stack || e); });
</script>
</body>
</html>`;

const htmlPath = path.join(tmpDir, "harness.html");
await writeFile(htmlPath, html, "utf8");

// ---------------------------------------------------------------
// 3. Electron 打开 harness 并截图
// ---------------------------------------------------------------
const electronDir = process.env.XC_ELECTRON_DIR || "D:/xc-shot/node_modules/electron";
const electronPkg = await readFile(path.join(electronDir, "package.json"), "utf8");
const electronVersion = JSON.parse(electronPkg).version;
let electronExe;
if (process.platform === "win32")
	electronExe = path.join(electronDir, "dist", "electron.exe");
else electronExe = path.join(electronDir, "dist", "electron");

const runner = path.join(tmpDir, "runner", "main.js");
await mkdir(path.dirname(runner), { recursive: true });
await writeFile(
	path.join(tmpDir, "runner", "package.json"),
	JSON.stringify({ name: "xc-runner", version: "1.0.0", main: "main.js" }),
	"utf8"
);
await writeFile(
	runner,
	`const { app, BrowserWindow, screen } = require("electron");
app.disableHardwareAcceleration();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: ${process.env.XC_WIDTH || 1100},
    height: ${process.env.XC_HEIGHT || 900},
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  const errs = [];
  win.webContents.on("console-message", (e, lvl, msg) => {
    if (lvl >= 2) errs.push(String(msg));
  });
  win.webContents.on("did-fail-load", (e, code, desc) => errs.push("LOADFAIL " + code + " " + desc));
  await win.loadFile(${JSON.stringify(htmlPath)});
  for (let i = 0; i < 60; i++) {
    const st = await win.webContents.executeJavaScript(
      "({ready: !!window.__XC_READY, err: window.__XC_ERROR || null})"
    );
    if (st.err) { console.log("PAGE_ERROR " + st.err); break; }
    if (st.ready) break;
    await wait(250);
  }
  await wait(500);
  const diag = await win.webContents.executeJavaScript("window.__XC_DIAG || null");
  console.log("DIAG " + JSON.stringify(diag));
  const fs = require("node:fs");
  const nodePath = require("node:path");
  fs.mkdirSync(${JSON.stringify(outDir)}, { recursive: true });
  const img = await win.webContents.capturePage();
  const out = nodePath.join(${JSON.stringify(outDir)}, ${JSON.stringify(
		outFile
	)});
  fs.writeFileSync(out, img.toPNG());
  console.log("SHOT " + out);
  console.log("CONSOLE_ERRORS " + JSON.stringify(errs.slice(0, 6)));
  app.quit();
});
`,
	"utf8"
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const { stdout } = await execFileAsync(
	electronExe,
	[path.join(tmpDir, "runner")],
	{ env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }
);
process.stdout.write(stdout);
if (!process.env.XC_KEEP) await rm(tmpDir, { recursive: true, force: true });
else console.log("KEEP " + tmpDir);
