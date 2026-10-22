import esbuild from "esbuild";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 全量解析校验。
 * 用法：node scripts/verify-parse.mjs [题库根目录]
 */

const projectRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const root = process.argv[2] || process.env.XINGCE_ROOT || "D:/xingcezhenti";

const outfile = path.join(projectRoot, "scripts", ".parser.bundle.mjs");
await esbuild.build({
	entryPoints: [path.join(projectRoot, "src", "parser.ts")],
	bundle: true,
	format: "esm",
	platform: "node",
	outfile,
});

const { parseExamNote, extractImageRefs, isIncompleteAnswer } = await import(
	pathToFileURL(outfile).href
);

async function walk(dir) {
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
		if (e.isDirectory()) {
			if (e.name === "90-图片") continue;
			out.push(...(await walk(full)));
		} else if (e.name.endsWith(".md") && e.name !== "README.md") {
			out.push(full);
		}
	}
	return out;
}

const files = await walk(root);
console.log(`题库根目录: ${root}`);
console.log(`待解析笔记: ${files.length} 篇\n`);

const stats = {
	total: 0,
	byModule: new Map(),
	byPoint: new Map(),
	byYear: new Map(),
	byRegion: new Map(),
	noOptions: 0,
	noAnswer: 0,
	noExplanation: 0,
	incomplete: 0,
	withImage: 0,
	mismatch: 0,
	examCount: new Set(),
	materialGroups: new Set(),
};
const samples = { mismatch: [], noOptions: [] };

for (const file of files) {
	const raw = await readFile(file, "utf8");
	const rel = path.relative(root, file).split(path.sep).join("/");
	let qs;
	try {
		qs = parseExamNote(raw, rel);
	} catch (err) {
		console.error(`解析失败: ${rel} -> ${err.message}`);
		continue;
	}

	for (const q of qs) {
		stats.total++;
		stats.byModule.set(q.module, (stats.byModule.get(q.module) ?? 0) + 1);
		stats.byPoint.set(q.point, (stats.byPoint.get(q.point) ?? 0) + 1);
		stats.byYear.set(q.year, (stats.byYear.get(q.year) ?? 0) + 1);
		stats.byRegion.set(q.region, (stats.byRegion.get(q.region) ?? 0) + 1);
		stats.examCount.add(q.exam);
		if (q.material) stats.materialGroups.add(`${rel}#${q.materialIndex}`);

		if (q.options.length === 0) {
			stats.noOptions++;
			if (samples.noOptions.length < 3) samples.noOptions.push(q);
		}
		if (!q.answer) stats.noAnswer++;
		if (!q.explanation) stats.noExplanation++;
		if (isIncompleteAnswer(q.answer)) stats.incomplete++;

		const stemImgs = extractImageRefs(q.stem);
		const optImgs = q.options.flatMap((o) => extractImageRefs(o.text));
		if (stemImgs.length || optImgs.length) stats.withImage++;

		const letters = [...(q.answer.match(/[A-H]/g) ?? [])].sort().join("");
		const marks = [...q.correctKeys].sort().join("");
		if (letters && marks && letters !== marks) {
			stats.mismatch++;
			if (samples.mismatch.length < 3) samples.mismatch.push(q);
		}
	}
}

const sortDesc = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

console.log("=== 总体 ===");
console.log(`解析题目总数:   ${stats.total}`);
console.log(`覆盖试卷数:     ${stats.examCount.size}`);
console.log(`资料分析材料组: ${stats.materialGroups.size}`);
console.log(`含图题目:       ${stats.withImage}`);

console.log("\n=== 模块分布 ===");
for (const [k, v] of sortDesc(stats.byModule))
	console.log(`  ${k.padEnd(14)} ${v}`);

console.log("\n=== 考点分布 ===");
for (const [k, v] of sortDesc(stats.byPoint))
	console.log(`  ${k.padEnd(14)} ${v}`);

console.log("\n=== 年份分布 ===");
for (const [k, v] of sortDesc(stats.byYear)) console.log(`  ${k}  ${v}`);

console.log(`\n=== 地区数: ${stats.byRegion.size} ===`);
console.log(
	sortDesc(stats.byRegion)
		.slice(0, 10)
		.map(([k, v]) => `${k}(${v})`)
		.join("  ")
);

console.log("\n=== 数据质量 ===");
console.log(`无选项题:       ${stats.noOptions}`);
console.log(`无答案:         ${stats.noAnswer}`);
console.log(`无解析:         ${stats.noExplanation}`);
console.log(`残缺答案:       ${stats.incomplete}`);
console.log(`✅与答案不符:   ${stats.mismatch}`);

if (samples.mismatch.length) {
	console.log("\n--- ✅标记与答案字段不一致样本 ---");
	for (const q of samples.mismatch)
		console.log(`  qid ${q.qid} 答案=${q.answer} ✅=${q.correctKeys}`);
}
if (samples.noOptions.length) {
	console.log("\n--- 无选项样本 ---");
	for (const q of samples.noOptions)
		console.log(`  qid ${q.qid} ${q.point} (${q.file})`);
}

await rm(outfile, { force: true });
