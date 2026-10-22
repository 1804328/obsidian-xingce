import esbuild from "esbuild";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	".."
);
const root = process.argv[2] || "D:/xingcezhenti";

const stub = path.join(projectRoot, "scripts", ".stub.mjs");
await writeFile(
	stub,
	"export class TFile {}\nexport class App {}\n"
);
const entry = path.join(projectRoot, "scripts", ".entry.mjs");
await writeFile(
	entry,
	'export { parseExamNote } from "../src/parser";\n'
);
const bundle = path.join(projectRoot, "scripts", ".bundle.mjs");
await esbuild.build({
	entryPoints: [entry],
	bundle: true,
	format: "esm",
	platform: "node",
	alias: { obsidian: stub },
	outfile: bundle,
});
const { parseExamNote } = await import(pathToFileURL(bundle).href);

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
		if (e.isDirectory()) {
			if (e.name === "90-图片") continue;
			out.push(...(await walk(full, base)));
		} else if (e.name.endsWith(".md") && e.name !== "README.md")
			out.push(path.relative(base, full).split(path.sep).join("/"));
	}
	return out;
}

const paths = await walk(root);
const counts = new Map();
const where = new Map();
let dupQids = 0;
let dupEntries = 0;

for (const p of paths) {
	const raw = await readFile(path.join(root, p), "utf8");
	for (const q of parseExamNote(raw, p)) {
		counts.set(q.qid, (counts.get(q.qid) ?? 0) + 1);
		const k = where.get(q.qid) ?? [];
		k.push(`${p}#${q.index}`);
		where.set(q.qid, k);
	}
}

for (const [qid, c] of counts) {
	if (c > 1) {
		dupQids++;
		dupEntries += c;
	}
}

console.log(`总题目数: ${counts.size ? [...counts.values()].reduce((a, b) => a + b, 0) : 0}`);
console.log(`去重 qid 数: ${counts.size}`);
console.log(`重复的 qid 数: ${dupQids}`);
console.log(`重复 qid 涉及的题目条目: ${dupEntries}`);

const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log("\n出现次数最多的 qid:");
for (const [qid, c] of top) {
	console.log(`  qid ${qid} × ${c}`);
	for (const w of (where.get(qid) ?? []).slice(0, 3))
		console.log(`      ${w}`);
}

await rm(bundle, { force: true });
await rm(stub, { force: true });
await rm(entry, { force: true });
