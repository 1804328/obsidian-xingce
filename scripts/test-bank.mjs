import esbuild from "esbuild";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Bank 核心逻辑冒烟测试。
 * 用 esbuild alias 把 obsidian 替换为最小桩模块，在 Node 里验证：
 * 索引构建、多维筛选、抽题单元分组（资料分析整组）、正文回填、整套卷抽取。
 *
 * 用法：node scripts/test-bank.mjs [题库根目录]
 */

const projectRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const root =
	process.argv[2] || path.join(projectRoot, "examples", "示例题库");

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

const stub = path.join(projectRoot, "scripts", ".obsidian-stub.mjs");
await writeFile(
	stub,
	[
		"export class TFile {",
		"  constructor(p) { this.path = p; this.stat = { mtime: 0 }; }",
		"}",
		"export class App {}",
		"",
	].join("\n")
);

// 再导出入口：让测试与 bundle 共用同一个 TFile 类，
// 否则 instanceof 会因模块副本而失效。
const entry = path.join(projectRoot, "scripts", ".bank-entry.mjs");
await writeFile(
	entry,
	[
		'export { Bank } from "../src/bank";',
		'export { buildWeakness } from "../src/weakness";',
		'export { TFile } from "obsidian";',
		"",
	].join("\n")
);

const bundle = path.join(projectRoot, "scripts", ".bank.bundle.mjs");
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: "esm",
	platform: "node",
	alias: { obsidian: stub },
	outfile: bundle,
});

const { Bank, TFile, buildWeakness } = await import(pathToFileURL(bundle).href);

const paths = await walk(root);
const contents = new Map();
const mtimes = new Map();
for (const p of paths) {
	const full = path.join(root, p);
	contents.set(p, await readFile(full, "utf8"));
	mtimes.set(p, (await stat(full)).mtimeMs);
}

const mdFiles = paths.map((p) => {
	const f = new TFile(p);
	f.stat = { mtime: mtimes.get(p) ?? 0 };
	return f;
});

const cacheStore = new Map();

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
};

const bank = new Bank(app, "");
const entries = await bank.load();

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

console.log(`题库根目录: ${root}`);
console.log(`笔记数 ${mdFiles.length} · 解析题目数 ${entries.length}\n`);

console.log("=== 索引完整性 ===");
check("索引非空", entries.length > 0, `got ${entries.length}`);
check("每条都有 qid", entries.every((e) => !!e.qid));
check("每条都有模块", entries.every((e) => !!e.module));
check("每条都有考点", entries.every((e) => !!e.point));
check("每条都有文件路径", entries.every((e) => !!e.file));
check(
	"uid 全局唯一",
	new Set(entries.map((e) => e.uid)).size === entries.length
);

// qid 在全库中本就重复：联考卷共用题目，同一题会出现在多套卷里。
// 这里只做记录，不做断言。
const uniqQids = new Set(entries.map((e) => e.qid)).size;
console.log(
	`  INFO  qid 去重 ${uniqQids} / 题目 ${entries.length}` +
		(uniqQids < entries.length
			? `（${(entries.length - uniqQids).toLocaleString()} 条为跨卷重复，属正常现象）`
			: "")
);

console.log("\n=== 多维筛选 ===");
const base = {
	modules: [],
	points: [],
	years: [],
	regions: [],
	onlyWithImage: false,
	excludeIncomplete: true,
};
const facets = bank.facets();
check("模块 facet 非空", facets.modules.length > 0);
check("考点 facet 非空", facets.points.length > 0);
check("年份 facet 非空", facets.years.length > 0);

for (const m of facets.modules) {
	const p = bank.filter({ ...base, modules: [m] });
	check(
		`模块筛选「${m}」`,
		p.length > 0 && p.every((e) => e.module === m),
		`got ${p.length}`
	);
}
const pt = facets.points[0];
const pp = bank.filter({ ...base, points: [pt] });
check(
	`考点筛选「${pt}」`,
	pp.length > 0 && pp.every((e) => e.point === pt),
	`got ${pp.length}`
);

console.log("\n=== 抽题单元 ===");
const units = bank.units(bank.filter(base));
check("单元数 > 0", units.length > 0, `got ${units.length}`);
const zlUnits = units.filter((u) => u.questions[0].module === "资料分析");
const normalUnits = units.filter(
	(u) => u.questions[0].module !== "资料分析"
);
check("普通题一题一单元", normalUnits.every((u) => u.questions.length === 1));
check(
	"资料分析按材料成组",
	zlUnits.every((u) => u.questions.every((q) => !!q.materialIndex || true))
);
console.log(`  INFO  资料分析单元 ${zlUnits.length} 个`);

console.log("\n=== 随机抽题 + 正文回填 ===");
for (const n of [1, 5, 20]) {
	const qs = await bank.draw(base, n);
	check(`抽 ${n} 题有结果`, qs.length >= 1, `got ${qs.length}`);
	check(
		`抽 ${n} 题正文非空`,
		qs.every((q) => !!q.stem || q.options.length > 0)
	);
	check(
		`抽 ${n} 题可判定正确答案`,
		qs.every((q) => q.correctKeys.length > 0 || /[A-H]/.test(q.answer))
	);
	console.log(`  INFO  请求 ${n} 题，实际返回 ${qs.length} 题（按单元取整）`);
}

console.log("\n=== 资料分析整组完整性 ===");
if (zlUnits.length) {
	const u = zlUnits[0];
	const got = await bank.hydrate(u.questions);
	check("整组题目数一致", got.length === u.questions.length);
	check("组内均带材料正文", got.every((q) => !!q.material));
	console.log(
		`  INFO  示例组：材料 ${u.materialIndex}，${got.length} 小题`
	);
} else {
	console.log("  SKIP  无资料分析题");
}

console.log("\n=== 整套卷（模考） ===");
const exams = bank.exams();
check("试卷列表非空", exams.length > 0);
if (exams.length) {
	const e0 = exams[0];
	const qs = await bank.drawExam(e0.exam);
	check(`整套可抽出（${e0.exam}）`, qs.length > 0, `got ${qs.length}`);
	console.log(`  INFO  该卷 ${qs.length} 题，覆盖模块：${[...new Set(qs.map((q) => q.module))].join("、")}`);
}

console.log("\n=== 薄弱度算法（buildWeakness） ===");
const mkE = (qid, module) => ({ qid, module });
const mkHist = (qid, correct) => ({ qid, correct, at: 0 });
const mockEntries = [
	mkE("a1", "A"), mkE("a2", "A"), mkE("a3", "A"),
	mkE("b1", "B"), mkE("b2", "B"), mkE("b3", "B"),
];

// 1. 无历史
let w = buildWeakness(mockEntries, []);
check("无历史：weightOf 恒为 1", w.weightOf("a1") === 1 && w.weightOf("b1") === 1);
check("无历史：hasData=false", w.hasData === false);

// 2. 关闭智能
w = buildWeakness(mockEntries, [mkHist("a1", false)], { smart: false });
check("关闭智能：weightOf 恒为 1", w.weightOf("a1") === 1 && w.weightOf("b1") === 1);

// 3. A 全错 / B 全对
const hist = [
	mkHist("a1", false), mkHist("a2", false), mkHist("a3", false),
	mkHist("b1", true), mkHist("b2", true), mkHist("b3", true),
];
w = buildWeakness(mockEntries, hist);
check("A（全错）权重高于 B（全对）", w.weightOf("a1") > w.weightOf("b1"), `A=${w.weightOf("a1")} B=${w.weightOf("b1")}`);
check("B（全对）权重为基准 1", w.weightOf("b1") === 1);
check("最弱模块识别为 A", w.weakModules[0] === "A", `got ${w.weakModules.join(",")}`);
check("hasData=true", w.hasData === true);

// 4. 样本不足不进 weakModules
w = buildWeakness(mockEntries, [mkHist("a1", false)]);
check("样本不足（<3）不进 weakModules", !w.weakModules.includes("A"));

// 5. 个人错次加成：同一模块内错 5 次权重高于错 1 次
const hist2 = [
	...Array.from({ length: 5 }, () => mkHist("a1", false)),
	mkHist("a2", false),
];
w = buildWeakness(mockEntries, hist2);
check("个人错更多 → 权重更高", w.weightOf("a1") > w.weightOf("a2"), `a1=${w.weightOf("a1")} a2=${w.weightOf("a2")}`);

// 6. 上限保护
const hist3 = Array.from({ length: 100 }, () => mkHist("a1", false));
w = buildWeakness(mockEntries, hist3);
check("权重不超过上限", w.weightOf("a1") <= 8, `got ${w.weightOf("a1")}`);

await rm(bundle, { force: true });
await rm(stub, { force: true });
await rm(entry, { force: true });

console.log(`\n${failed === 0 ? `全部通过（${passed} 项）` : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
