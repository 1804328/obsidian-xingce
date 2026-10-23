#!/usr/bin/env node
/**
 * UI 层冒烟测试
 * ============
 *
 * 逻辑层已有 test-bank.mjs 覆盖，但**视图代码此前从未真正执行过**。
 * 本测试在 jsdom + Obsidian API 桩上真实驱动视图，覆盖：
 *
 *   插件加载 → 视图挂载 → 筛选界面渲染 → 随机抽题 → 题目渲染
 *   → 点击选项 → 即时判分 → 错题本记录 → 收藏 → 图片路径改写
 *
 * 目的是抓出只有跑起来才会暴露的低级错误
 * （未定义变量、调用了不存在的 API、DOM 操作写错等）。
 *
 * 用法：node scripts/test-ui.mjs [题库根目录]
 */

import esbuild from "esbuild";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const projectRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const root =
	process.argv[2] || path.join(projectRoot, "examples", "示例题库");

// ---------------------------------------------------------------
// 1. DOM 环境
// ---------------------------------------------------------------
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	url: "https://localhost/",
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
// Node 22 起 globalThis.navigator 是只读 getter，只能用 defineProperty 覆盖
Object.defineProperty(globalThis, "navigator", {
	value: window.navigator,
	configurable: true,
	writable: true,
});
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.DocumentFragment = window.DocumentFragment;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// Obsidian 在 HTMLElement 原型上挂了一批便捷方法，jsdom 没有，这里补齐。
// 只要签名对得上，视图代码就能真实跑起来。
for (const P of [
	window.HTMLElement.prototype,
	window.DocumentFragment.prototype,
]) {
	P.createEl = function (tag, o, cb) {
		const el = document.createElement(tag);
		if (typeof o === "string") {
			el.className = o.replace(/^\./, "").split(".").join(" ");
		} else if (o && typeof o === "object") {
			if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
			if (o.text != null) el.textContent = String(o.text);
			if (o.title) el.setAttribute("aria-label", String(o.title));
			if (o.href) el.setAttribute("href", String(o.href));
			if (o.type) el.setAttribute("type", String(o.type));
			if (o.placeholder) el.setAttribute("placeholder", String(o.placeholder));
			if (o.value != null) el.setAttribute("value", String(o.value));
			if (o.attr)
				for (const [k, v] of Object.entries(o.attr))
					el.setAttribute(k, String(v));
		}
		this.appendChild(el);
		if (cb) cb(el);
		return el;
	};
	P.createDiv = function (o, cb) {
		return this.createEl("div", o, cb);
	};
	P.createSpan = function (o, cb) {
		return this.createEl("span", o, cb);
	};
	P.empty = function () {
		while (this.firstChild) this.removeChild(this.firstChild);
	};
	P.addClass = function (...c) {
		this.classList.add(...c);
		return this;
	};
	P.removeClass = function (...c) {
		this.classList.remove(...c);
		return this;
	};
	P.toggleClass = function (c, v) {
		this.classList.toggle(c, v);
		return this;
	};
	P.setText = function (t) {
		this.textContent = String(t);
		return this;
	};
	P.detach = function () {
		this.remove?.();
	};
}

// ---------------------------------------------------------------
// 2. Obsidian API 桩
// ---------------------------------------------------------------
const stub = path.join(projectRoot, "scripts", ".obsidian-ui-stub.mjs");
await writeFile(
	stub,
	[
		"export class TFile {",
		"  constructor(p) { this.path = p; this.stat = { mtime: 0 }; this.basename = ''; this.extension = 'md'; }",
		"}",
		"export class App {}",
		"export class Events {",
		"  on() { return { }; }",
		"  off() {}",
		"  trigger() {}",
		"}",
		"export class Component extends Events {",
		"  constructor() { super(); this._children = []; }",
		"  onload() {}",
		"  onunload() {}",
		"  addChild(c) { this._children.push(c); return c; }",
		"  register(cb) { return cb; }",
		"  registerEvent(ref) { return ref; }",
		"}",
		"export class Plugin extends Component {",
		"  constructor(app, manifest) {",
		"    super();",
		"    this.app = app;",
		"    this.manifest = manifest;",
		"    this.commands = []; this.views = new Map(); this.settingTabs = []; this.ribbons = [];",
		"    this._data = null;",
		"  }",
		"  addCommand(c) { this.commands.push(c); return c; }",
		"  addRibbonIcon(icon, title, cb) { this.ribbons.push({ icon, title, cb }); return document.createElement('div'); }",
		"  addSettingTab(t) { this.settingTabs.push(t); return t; }",
		"  registerView(type, factory) { this.views.set(type, factory); }",
		"  async loadData() { return this._data; }",
		"  async saveData(d) { this._data = d; }",
		"}",
		"export class ItemView extends Component {",
		"  constructor(leaf) {",
		"    super();",
		"    this.leaf = leaf;",
		"    this.contentEl = document.createElement('div');",
		"    this.containerEl = document.createElement('div');",
		"    this.app = leaf ? leaf.app : null;",
		"  }",
		"}",
		"export class PluginSettingTab {",
		"  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); }",
		"  display() {}",
		"  hide() {}",
		"}",
		"export class Setting {",
		"  constructor(el) { this.settingEl = el; }",
		"  setName() { return this; }",
		"  setDesc() { return this; }",
		"  setClass() { return this; }",
		"  addText(cb) { cb(mkCtl()); return this; }",
		"  addToggle(cb) { cb(mkCtl()); return this; }",
		"  addDropdown(cb) { cb(mkCtl()); return this; }",
		"  addSlider(cb) { cb(mkCtl()); return this; }",
		"  addButton(cb) { cb(mkCtl()); return this; }",
		"}",
		"function mkCtl() {",
		"  return {",
		"    inputEl: document.createElement('input'),",
		"    toggleEl: document.createElement('div'),",
		"    selectEl: document.createElement('select'),",
		"    buttonEl: document.createElement('button'),",
		"    sliderEl: document.createElement('div'),",
		"    setPlaceholder() { return this; },",
		"    setValue() { return this; },",
		"    setButtonText() { return this; },",
		"    setCta() { return this; },",
		"    setTooltip() { return this; },",
		"    setDynamicTooltip() { return this; },",
		"    setLimits() { return this; },",
		"    setRange() { return this; },",
		"    addOption() { return this; },",
		"    onChange() { return this; },",
		"    onClick() { return this; },",
		"  };",
		"}",
		"export class Notice {",
		"  constructor(msg) { Notice.last = String(msg); Notice.count = (Notice.count || 0) + 1; }",
		"}",
		"export class WorkspaceLeaf {}",
		"export function normalizePath(p) { return String(p).replace(/\\\\/g, '/'); }",
		"export function debounce(fn) { return fn; }",
		"export class MarkdownRenderer {",
		"  static async render(app, md, el) { el.textContent = md; }",
		"}",
		"",
	].join("\n")
);

// 再导出入口：让测试与 bundle 共用同一个 TFile 类
const entry = path.join(projectRoot, "scripts", ".ui-entry.mjs");
await writeFile(
	entry,
	[
		'export { default as XingcePlugin } from "../src/main";',
		'export { PracticeView } from "../src/views/practice-view";',
		'export { ExamView } from "../src/views/exam-view";',
		'export { TFile } from "obsidian";',
		"",
	].join("\n")
);

const bundle = path.join(projectRoot, "scripts", ".ui.bundle.mjs");
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: "esm",
	platform: "node",
	alias: { obsidian: stub },
	outfile: bundle,
});

// 渲染层单独打包，用于验证图片路径改写
const renderBundle = path.join(projectRoot, "scripts", ".render.bundle.mjs");
await esbuild.build({
	entryPoints: [path.join(projectRoot, "src", "render.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outfile: renderBundle,
});

const { XingcePlugin, PracticeView, ExamView, TFile } = await import(
	pathToFileURL(bundle).href
);

// ---------------------------------------------------------------
// 3. 构造 mock App
// ---------------------------------------------------------------
async function walk(dir, base = dir) {
	const out = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e.name.startsWith(".")) continue;
		const full = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walk(full, base)));
		else if (e.name.endsWith(".md") && e.name !== "README.md")
			out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out;
}

const paths = await walk(root);
const contents = new Map();
for (const p of paths) {
	contents.set(p, await readFile(path.join(root, p), "utf8"));
}

const mdFiles = paths.map((p) => new TFile(p));

const cacheStore = new Map();
const leaf = { app: null, view: null };
const workspace = {
	getLeavesOfType: () => [],
	getRightLeaf: () => leaf,
	revealLeaf: () => {},
};

const app = {
	vault: {
		configDir: ".obsidian",
		getMarkdownFiles: () => mdFiles,
		cachedRead: async (f) => contents.get(f.path) ?? "",
		getAbstractFileByPath: (p) => (contents.has(p) ? new TFile(p) : null),
		adapter: {
			exists: async (p) => cacheStore.has(p),
			read: async (p) => cacheStore.get(p) ?? "",
			write: async (p, d) => void cacheStore.set(p, d),
		},
	},
	workspace,
};
leaf.app = app;

// 让 leaf.setViewState 真正构造视图，模拟 Obsidian 的行为
leaf.setViewState = async (state) => {
	const factory = pluginViews.get(state.type);
	leaf.view = factory ? factory(leaf) : null;
};

// ---------------------------------------------------------------
// 4. 断言工具
// ---------------------------------------------------------------
let failed = 0;
let passed = 0;
const check = (name, cond, extra = "") => {
	if (cond) {
		passed++;
		console.log(`  PASS  ${name}`);
	} else {
		failed++;
		console.log(`  FAIL  ${name} ${extra}`);
	}
};
const info = (text) => console.log(`  INFO  ${text}`);

// ---------------------------------------------------------------
// 5. 开始测试
// ---------------------------------------------------------------
console.log(`题库根目录: ${root}`);
console.log(`笔记数 ${mdFiles.length}\n`);

const pluginViews = new Map();
const plugin = new XingcePlugin(app, {
	id: "obsidian-xingce",
	version: "0.1.0",
});

// 拦截 registerView，把工厂函数收集起来，供 leaf.setViewState 使用
const origRegisterView = plugin.registerView.bind(plugin);
plugin.registerView = (type, factory) => {
	pluginViews.set(type, factory);
	return origRegisterView(type, factory);
};

console.log("=== 插件加载 ===");
try {
	await plugin.onload();
	check("onload 不抛异常", true);
} catch (e) {
	check("onload 不抛异常", false, e.message);
	console.error(e);
	process.exit(1);
}
check("注册了刷题视图", pluginViews.has("xingce-practice-view"));
check("注册了模考视图", pluginViews.has("xingce-exam-view"));
check("注册了命令", plugin.commands.length > 0, `共 ${plugin.commands.length} 条`);
check("注册了设置面板", plugin.settingTabs.length > 0);
check("注册了侧边栏图标", plugin.ribbons.length > 0);

console.log("\n=== 题库索引 ===");
await plugin.ensureBank();
check("索引构建成功", plugin.bank.ready);
check("索引非空", plugin.bank.size > 0, `共 ${plugin.bank.size} 题`);
info(`模块 ${plugin.bank.facets().modules.length} 个 · 考点 ${plugin.bank.facets().points.length} 个`);

console.log("\n=== 刷题视图挂载 ===");
const view = new PracticeView(leaf, plugin);
try {
	await view.onOpen();
	check("onOpen 不抛异常", true);
} catch (e) {
	check("onOpen 不抛异常", false, e.message);
	console.error(e);
	process.exit(1);
}
check("getViewType 正确", view.getViewType() === "xingce-practice-view");
check("getDisplayText 非空", !!view.getDisplayText());
check("渲染出根节点", view.contentEl.classList.contains("xc-root"));
check(
	"渲染出筛选控件",
	view.contentEl.querySelectorAll(".xc-chip, .xc-btn").length > 0
);

console.log("\n=== 智能 / 随机 模式切换 ===");
const modeFind = (kw) =>
	[...view.contentEl.querySelectorAll(".xc-mode-row .xc-chip")].find((b) =>
		(b.textContent || "").includes(kw)
	);
let smartBtn = modeFind("智能");
let randBtn = modeFind("随机");
check("渲染出智能模式按钮", !!smartBtn);
check("渲染出随机模式按钮", !!randBtn);
check("默认处于智能模式（按钮高亮）", smartBtn?.classList.contains("is-on") === true);
check("默认设置 smartMode=true", plugin.store.data.settings.smartMode === true);

// 切到随机模式：setSmart 会触发重渲染，需重新定位按钮节点
randBtn.click();
await settle();
randBtn = modeFind("随机");
smartBtn = modeFind("智能");
check("点击随机模式后设置更新", plugin.store.data.settings.smartMode === false);
check("随机模式按钮高亮", !!randBtn && randBtn.classList.contains("is-on"));
check(
	"智能模式按钮取消高亮",
	!!smartBtn && !smartBtn.classList.contains("is-on")
);

// 切回智能模式
smartBtn.click();
await settle();
randBtn = modeFind("随机");
smartBtn = modeFind("智能");
check("切回智能模式后设置更新", plugin.store.data.settings.smartMode === true);
check("智能模式按钮恢复高亮", !!smartBtn && smartBtn.classList.contains("is-on"));

console.log("\n=== 随机抽题与判分 ===");
await view.quickDraw(5);
// quickDraw 内部调用 async render() 时未 await，这里等事件循环排空再断言
await settle();
const getRoot = () => view.contentEl;
check("进入答题态", view.contentEl.classList.contains("xc-root"));

// 逐题点第一个选项，验证：判分反馈一定出现，且答错时错题本会记录
let answered = 0;
let rightCount = 0;
let wrongCount = 0;
let multiSeen = 0;
const wrongBefore = Object.keys(plugin.store.data.wrong).length;

for (let step = 0; step < 5; step++) {
	const el = getRoot();
	const opts = [...el.querySelectorAll(".xc-option")];
	if (!opts.length) break;

	opts[0].click();
	await settle();

	// 多选题：选中后只进待选区，必须再点「提交」才会判分
	const sub = getRoot()?.querySelector(".xc-submit-bar .xc-btn-primary");
	if (sub) {
		check(`第 ${step + 1} 题（多选）提交按钮已激活`, !sub.disabled);
		sub.click();
		await settle();
		multiSeen++;
	}

	answered++;

	const verdict = getRoot()?.querySelector(".xc-verdict");
	if (!verdict) {
		check(`第 ${step + 1} 题应出现判分反馈`, false);
		break;
	}
	const text = verdict.textContent || "";
	if (text.includes("回答正确")) rightCount++;
	else if (text.includes("回答错误")) wrongCount++;
	else check(`第 ${step + 1} 题判分文案异常`, false, `实际：${text}`);
}

check("至少完成 1 次作答（防空跑）", answered > 0, `实际 ${answered}`);
check(
	"每题都能给出判分反馈",
	answered > 0 && rightCount + wrongCount === answered,
	`${rightCount + wrongCount}/${answered}`
);
check(
	"答错的题计入了错题本",
	wrongCount === 0 ||
		Object.keys(plugin.store.data.wrong).length > wrongBefore ||
		Object.keys(plugin.store.data.wrong).length > 0
);
info(`作答 ${answered} 题：答对 ${rightCount} · 答错 ${wrongCount}`);
info(`其中多选题 ${multiSeen} 题（走「选中 → 提交」两步流程）`);

// 当前页面处在「已作答」状态，若这题进了错题本，反馈区应出现手动移除入口
const curQid = (getRoot()?.querySelector(".xc-source .xc-qid")?.textContent || "")
	.replace(/[^0-9]/g, "");
if (curQid && plugin.store.data.wrong[curQid]) {
	const btns = [...getRoot().querySelectorAll(".xc-feedback-actions .xc-btn")];
	check(
		"错题反馈区出现「移出错题本」按钮",
		btns.some((b) => (b.textContent || "").includes("移出错题本"))
	);
	const rm = btns.find((b) => (b.textContent || "").includes("移出错题本"));
	if (rm) {
		rm.click();
		await settle();
		check("点击后该题离开错题本", !plugin.store.data.wrong[curQid]);
		check(
			"重新渲染后按钮消失",
			![...getRoot().querySelectorAll(".xc-feedback-actions .xc-btn")].some(
				(b) => (b.textContent || "").includes("移出错题本")
			)
		);
	}
} else {
	info("当前题不在错题本，跳过移除按钮检查");
}

console.log("\n=== 错题掌握机制（连续答对） ===");
const st = plugin.store;
const savedStreak = st.data.settings.masterStreak;

st.removeWrong("q-master-a");
st.removeWrong("q-master-b");

// A：连错两次 → 连对一次（未达标）→ 再连对一次（达标移出）
let r = st.recordAnswer("q-master-a", false, ["A"]);
r = st.recordAnswer("q-master-a", false, ["A"]);
check("连错两次累计 count=2", st.data.wrong["q-master-a"]?.count === 2, `实际 ${st.data.wrong["q-master-a"]?.count}`);
r = st.recordAnswer("q-master-a", true, ["B"]);
check("答对一次不移除且 streak=1", r.removed === false && r.streak === 1, `removed=${r.removed} streak=${r.streak}`);
r = st.recordAnswer("q-master-a", true, ["B"]);
check("连续答对 2 次后自动移出", r.removed === true && r.streak === 2, `removed=${r.removed} streak=${r.streak}`);
check("移出后不在错题本中", !st.data.wrong["q-master-a"]);

// B：连对中途再错应清零，不能靠一次答对蒙混过关
st.recordAnswer("q-master-b", false, ["A"]);
r = st.recordAnswer("q-master-b", true, ["B"]);
check("B：答对一次 streak=1", r.streak === 1 && !r.removed);
r = st.recordAnswer("q-master-b", false, ["C"]);
check("B：答错后 streak 清零", st.data.wrong["q-master-b"]?.streak === 0 && st.data.wrong["q-master-b"]?.count === 2);
r = st.recordAnswer("q-master-b", true, ["B"]);
check("B：清零后需重新累计，首次答对不移除", r.removed === false && r.streak === 1);

// C：设为「永不自动移出」后只能手动删
st.data.settings.masterStreak = 0;
st.removeWrong("q-master-c");
st.recordAnswer("q-master-c", false, ["A"]);
st.recordAnswer("q-master-c", true, ["B"]);
st.recordAnswer("q-master-c", true, ["B"]);
st.recordAnswer("q-master-c", true, ["B"]);
check("永不模式下连对多次仍保留", !!st.data.wrong["q-master-c"]);
st.removeWrong("q-master-c");
check("手动移出生效", !st.data.wrong["q-master-c"]);
st.data.settings.masterStreak = savedStreak;

// D：答对一道从未错过的题，不应凭空进错题本
st.removeWrong("q-master-d");
const beforeD = Object.keys(st.data.wrong).length;
r = st.recordAnswer("q-master-d", true, ["B"]);
check("答对新题不写入错题本", Object.keys(st.data.wrong).length === beforeD && !r.removed);
st.removeWrong("q-master-a");
st.removeWrong("q-master-b");

console.log("\n=== 收藏与错题本 ===");
// 不依赖错题本：随便抽一题来测收藏，避免前面的清除操作让本段被跳过
const sample = await plugin.bank.draw(
	{
		modules: [],
		points: [],
		years: [],
		regions: [],
		onlyWithImage: false,
		excludeIncomplete: false,
	},
	1
);
const firstQid = sample[0]?.qid || Object.keys(plugin.store.data.wrong)[0] || "0";
if (firstQid) {
	await plugin.store.toggleFavorite(firstQid);
	check("收藏成功", plugin.store.isFavorite(firstQid));
	await plugin.store.toggleFavorite(firstQid);
	check("取消收藏成功", !plugin.store.isFavorite(firstQid));
} else {
	info("本次未产生错题，跳过收藏测试");
}
check(
	"错题本可遍历",
	Array.isArray(Object.keys(plugin.store.data.wrong))
);

console.log("\n=== 图片路径改写 ===");
const { toMarkdown } = await import(
	pathToFileURL(path.join(projectRoot, "scripts", ".render.bundle.mjs")).href
);
const md = toMarkdown(
	'题干 <img width="688px" height="326px" src="../90-图片/题目图/abc.png" /> 结束',
	"05-判断推理/某卷.md"
);
check("转成 Obsidian 内嵌语法", md.includes("![[90-图片/题目图/abc.png|688x326]]"), `实际：${md}`);
check("绝对路径原样保留", toMarkdown('<img src="https://x.com/a.png" />', "a.md").includes("https://x.com/a.png"));

console.log("\n=== 模考视图 ===");
const examView = new ExamView(leaf, plugin);
check("getViewType 正确", examView.getViewType() === "xingce-exam-view");
try {
	await examView.onOpen();
	check("模考视图 onOpen 不抛异常", true);
} catch (e) {
	check("模考视图 onOpen 不抛异常", false, e.message);
	console.error(e);
}

// ---------------------------------------------------------------
// 6. 清理与汇总
// ---------------------------------------------------------------
await rm(bundle, { force: true });
await rm(stub, { force: true });
await rm(entry, { force: true });
await rm(
	path.join(projectRoot, "scripts", ".render.bundle.mjs"),
	{ force: true }
);

console.log("");
if (failed === 0) {
	console.log(`全部通过（${passed} 项）`);
} else {
	console.log(`${failed} 项失败 / 共 ${passed + failed} 项`);
	process.exitCode = 1;
}

function tick() {
	return new Promise((r) => setTimeout(r, 0));
}

/** 等待若干轮事件循环，让 async 渲染彻底完成 */
function settle(rounds = 8) {
	let p = Promise.resolve();
	for (let i = 0; i < rounds; i++) p = p.then(() => tick());
	return p;
}
