#!/usr/bin/env node
/**
 * 通用题库导入工具
 * ================
 *
 * 把你自己整理的题库文件，转换成「行测真题笔记」格式，
 * 转换结果可直接被本插件的解析引擎读取并用于刷题。
 *
 * 用法：
 *   node scripts/import.mjs <输入文件> [选项]
 *   node scripts/import.mjs --sample > 我的题库.csv
 *
 * 选项：
 *   --out <目录>      笔记输出目录（默认 ./题库笔记）
 *   --images <目录>   图片源目录（默认：输入文件所在目录）
 *   --source <文本>   写入 frontmatter 的来源标注，便于日后追溯
 *   --module <名称>   数据里没有「模块」列时的兜底模块名
 *   --dry-run         只输出统计预览，不写任何文件
 *   --sample          打印一份 CSV 列名模板
 *
 * 支持的输入格式：
 *   .csv   一行一题（Excel / WPS / Numbers 均可另存为 CSV）
 *   .json  题目数组，或 { "questions": [...] }
 *
 * ⚠️ 合规说明
 * ----------
 * 本工具只做**格式转换**，自身不包含任何题目内容。
 * 它读取什么、输出什么，完全取决于你提供的文件。
 * 请确保你对自己导入的内容拥有合法权利——详见 README「关于题目版权」。
 *
 * 本工具不提供、也不会提供从任何商业题库数据库导出数据的能力。
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CHECK = "\u2705";
const FULL_SPACE = "\u3000";

/** 标准模块名，用于判断是否需要「材料 → 小题群」结构 */
const MODULE_WITH_MATERIAL = "资料分析";

/**
 * 列名别名表。
 * 用户整理表格时列名千差万别，这里尽量宽松匹配。
 * 匹配前统一做规范化（去空格/下划线/括号、转小写）。
 */
const FIELDS = {
	module: ["模块", "科目", "题型模块", "大类", "module", "category", "type"],
	exam: [
		"试卷",
		"卷名",
		"试卷名称",
		"来源卷",
		"套卷",
		"exam",
		"paper",
		"source",
	],
	region: ["地区", "省份", "省", "区域", "region", "province", "area"],
	year: ["年份", "年度", "年", "year"],
	point: [
		"考点",
		"知识点",
		"标签",
		"分类",
		"题型",
		"point",
		"tag",
		"knowledge",
	],
	qid: ["qid", "题目id", "题目编号", "题号", "编号", "id", "questionid"],
	stem: [
		"题干",
		"题目",
		"题目内容",
		"内容",
		"问题",
		"stem",
		"question",
		"content",
		"title",
	],
	material: [
		"材料",
		"材料内容",
		"背景材料",
		"材料正文",
		"材料文本",
		"material",
		"passage",
	],
	answer: [
		"答案",
		"正确答案",
		"参考答案",
		"answer",
		"correct",
		"correctanswer",
		"result",
	],
	explanation: [
		"解析",
		"官方解析",
		"详解",
		"试题解析",
		"分析",
		"explanation",
		"analysis",
		"explain",
	],
};

/** 选项列识别：选项A / A / optionA / A选项 / 选项_A */
const RE_OPT_COL = /^(?:选项|option|opt)?[\s_\-]?([a-h])[\s_\-]?(?:选项)?$/i;

function normKey(k) {
	return String(k ?? "")
		.trim()
		.toLowerCase()
		.replace(/[\s_\-()（）[\]{}:：.。]/g, "");
}

/**
 * CSV 解析。自己实现而不用库，保持零运行时依赖。
 * 支持：引号包裹、双引号转义、字段内换行、BOM 头、CRLF。
 */
function parseCSV(text) {
	if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

	const rows = [];
	let row = [];
	let field = "";
	let inQuotes = false;
	let i = 0;

	while (i < text.length) {
		const c = text[i];

		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += c;
			i++;
			continue;
		}

		if (c === '"') {
			inQuotes = true;
			i++;
			continue;
		}
		if (c === ",") {
			row.push(field);
			field = "";
			i++;
			continue;
		}
		if (c === "\r") {
			i++;
			continue;
		}
		if (c === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			i++;
			continue;
		}
		field += c;
		i++;
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}

/** 把「选项」合并列拆成 [{key,text}]，格式如 A. xxx|B. yyy */
function splitCombinedOptions(raw) {
	const s = String(raw ?? "").trim();
	if (!s) return [];
	const parts = s.split(/\||\n|;;/);
	const out = [];
	for (const p of parts) {
		const m = /^\s*[\-*+]?\s*([A-Ha-h])\s*[.。、:：]\s*([\s\S]*)$/.exec(p);
		if (!m) continue;
		out.push({ key: m[1].toUpperCase(), text: m[2].trim() });
	}
	return out;
}

/** 从答案文本里提取选项字母，如 "B" / "AB" / "答案：C" */
function normAnswer(raw) {
	const s = String(raw ?? "").toUpperCase();
	return (s.match(/[A-H]/g) ?? []).join("");
}

/** FNV-1a 哈希，用于给没有 qid 的题目生成稳定 id */
function fnv1a(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function safeName(s) {
	const cleaned = String(s ?? "")
		.trim()
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ");
	return cleaned || "未命名";
}

function yq(s) {
	return `"${String(s ?? "").replace(/"/g, "'")}"`;
}

/**
 * 把原始记录（键为原始列名）映射为标准字段。
 * 返回 { data, opts }，opts 是按字母排序的选项数组。
 */
function mapRecord(raw) {
	const index = new Map();
	const opts = new Map();

	for (const [k, v] of Object.entries(raw)) {
		const nk = normKey(k);
		if (!nk) continue;

		const om = RE_OPT_COL.exec(nk);
		if (om) {
			opts.set(om[1].toUpperCase(), String(v ?? "").trim());
			continue;
		}
		if (!index.has(nk)) index.set(nk, v);
	}

	const pick = (aliases) => {
		for (const a of aliases) {
			const nk = normKey(a);
			if (index.has(nk)) {
				const v = index.get(nk);
				return v == null ? "" : String(v).trim();
			}
		}
		return "";
	};

	// 单独的选项列（选项A…）优先；否则退回合并的「选项」列
	let options = [...opts.entries()]
		.filter(([, t]) => t !== "")
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([key, text]) => ({ key, text }));

	if (!options.length) options = splitCombinedOptions(pick(["选项"]));

	return {
		module: pick(FIELDS.module),
		exam: pick(FIELDS.exam),
		region: pick(FIELDS.region),
		year: pick(FIELDS.year),
		point: pick(FIELDS.point),
		qid: pick(FIELDS.qid),
		stem: pick(FIELDS.stem),
		material: pick(FIELDS.material),
		answer: pick(FIELDS.answer),
		explanation: pick(FIELDS.explanation),
		options,
	};
}

/** 读取 CSV / JSON，统一输出原始记录数组 */
function readRecords(file) {
	const ext = extname(file).toLowerCase();
	const text = readFileSync(file, "utf8");

	if (ext === ".json") {
		const parsed = JSON.parse(text);
		const arr = Array.isArray(parsed) ? parsed : parsed?.questions;
		if (!Array.isArray(arr))
			throw new Error("JSON 需为题目数组，或包含 questions 数组的对象");
		return arr;
	}

	if (ext === ".csv") {
		const rows = parseCSV(text);
		if (!rows.length) throw new Error("CSV 为空");
		const header = rows[0].map((h) => String(h).trim());

		let mismatch = 0;
		const out = rows.slice(1).map((r) => {
			if (r.length !== header.length) mismatch++;
			const obj = {};
			header.forEach((h, i) => {
				obj[h] = r[i] ?? "";
			});
			return obj;
		});

		// 列数对不上是新手最常见的错误，会导致字段整体错位
		if (mismatch) {
			console.error(
				`⚠️ 有 ${mismatch} 行的列数与表头不一致，字段很可能整体错位。`
			);
			console.error(`   表头共 ${header.length} 列：${header.join(" / ")}`);
			console.error(
				`   请确认每行的逗号数量与表头一致——即使某列为空，逗号也要保留。`
			);
			console.error(``);
		}

		return out;
	}

	throw new Error(`不支持的格式：${ext || "(无扩展名)"}，请使用 .csv 或 .json`);
}

/** 探测输入数据里能识别到哪些关键字段，用于提前给出可读的提示 */
function detectFields(records) {
	const keys = new Set();
	for (const r of records.slice(0, 200)) {
		for (const k of Object.keys(r)) keys.add(normKey(k));
	}
	const has = (aliases) => aliases.some((a) => keys.has(normKey(a)));
	const hasOptionCol = [...keys].some((k) => RE_OPT_COL.test(k));
	return {
		stem: has(FIELDS.stem),
		module: has(FIELDS.module),
		answer: has(FIELDS.answer),
		options: hasOptionCol,
		columns: [...keys],
	};
}

/** 文本里的图片引用：![alt](path) 或 <img src="path"> */
const RE_MD_IMG = /!\[[^\]]*\]\(([^)]+)\)/g;
const RE_HTML_IMG = /<img\b[^>]*?src=["']([^"']+)["']/g;

function collectImages(text) {
	const out = [];
	for (const re of [RE_MD_IMG, RE_HTML_IMG]) {
		re.lastIndex = 0;
		let m;
		while ((m = re.exec(text)) !== null) {
			const src = m[1];
			if (src && !/^(https?:|data:|app:)/.test(src)) out.push(src);
		}
	}
	return out;
}

/** 把文本里的图片引用改写到输出目录（笔记位于「模块名/」下，故用 ../ 回退一级） */
function rewriteImages(text, copied, warn) {
	let out = text;

	out = out.replace(RE_MD_IMG, (full, src) => {
		if (/^(https?:|data:|app:)/.test(src)) return full;
		const mapped = copied.get(src);
		if (mapped) return `<img src="../${mapped}" />`;
		warn(src);
		return full;
	});

	out = out.replace(RE_HTML_IMG, (full) => {
		const src = /src=["']([^"']+)["']/.exec(full)?.[1] ?? "";
		if (!src || /^(https?:|data:|app:)/.test(src)) return full;
		const mapped = copied.get(src);
		if (mapped) return `<img src="../${mapped}" />`;
		warn(src);
		return full;
	});

	return out;
}

/**
 * 生成一篇笔记。
 * @param {object} meta  试卷级元信息
 * @param {Array} groups [{ material, materialIndex, questions }]
 */
function renderNote(meta, groups) {
	const lines = [];
	const total = groups.reduce((n, g) => n + g.questions.length, 0);

	lines.push("---");
	lines.push(`类型: ${yq("真题")}`);
	lines.push(`试卷: ${yq(meta.exam)}`);
	lines.push(`地区: ${yq(meta.region)}`);
	lines.push(`年份: ${yq(meta.year)}`);
	lines.push(`模块: ${yq(meta.module)}`);
	lines.push(`题数: ${yq(total)}`);
	if (meta.source) lines.push(`来源: ${yq(meta.source)}`);
	lines.push("---");
	lines.push("");
	lines.push(`# ${meta.exam}`);
	lines.push("");

	for (const g of groups) {
		// 资料分析：先输出材料正文，再挂上归属该材料的小题
		if (g.material) {
			lines.push(`## 材料 ${g.materialIndex}`);
			lines.push("");
			lines.push(g.material);
			lines.push("");
		}

		const heading = g.material ? "###" : "##";

		for (const q of g.questions) {
			lines.push(
				`${heading} 第 ${q.index} 题${FULL_SPACE}<sub>qid ${q.qid} · ${q.point}</sub>`
			);
			lines.push("");
			if (q.stem) {
				lines.push(q.stem);
				lines.push("");
			}
			for (const o of q.options) {
				const mark = q.correct.includes(o.key) ? `${FULL_SPACE}${CHECK}` : "";
				lines.push(`- **${o.key}**. ${o.text}${mark}`);
			}
			if (q.options.length) lines.push("");
			lines.push(`**答案**：${q.correct || q.answerRaw || ""}`);
			lines.push("");
			lines.push("**官方解析**");
			lines.push("");
			lines.push(q.explanation || "（暂无解析）");
			lines.push("");
			lines.push("---");
			lines.push("");
		}
	}

	return lines.join("\n").replace(/\n{3,}$/, "\n");
}

/** 把记录组织成：模块 → 试卷 → 材料分组 */
function organize(records) {
	const byExam = new Map();

	for (const raw of records) {
		const d = mapRecord(raw);
		const stem = d.stem || d.material;
		if (!stem) continue;

		const module = d.module || "未分类";
		const exam = d.exam || "未命名试卷";
		const key = `${module}\u0000${exam}`;

		let bucket = byExam.get(key);
		if (!bucket) {
			bucket = {
				module,
				exam,
				region: d.region,
				year: d.year,
				groups: [],
				groupByMaterial: new Map(),
			};
			byExam.set(key, bucket);
		}

		const material = d.material ?? "";
		let group;
		if (material) {
			group = bucket.groupByMaterial.get(material);
			if (!group) {
				group = {
					material,
					materialIndex: bucket.groups.length + 1,
					questions: [],
				};
				bucket.groups.push(group);
				bucket.groupByMaterial.set(material, group);
			}
		} else {
			group =
				bucket.groups[0] ??
				(() => {
					const g = { material: "", materialIndex: 0, questions: [] };
					bucket.groups.push(g);
					return g;
				})();
		}

		group.questions.push(d);
	}

	// 为非资料分析模块的题目补齐连续编号
	for (const bucket of byExam.values()) {
		for (const g of bucket.groups) {
			g.questions = g.questions
				.filter((q) => q.stem || q.material)
				.map((q, i) => ({ ...q, index: i + 1 }));
		}
		bucket.groups = bucket.groups.filter((g) => g.questions.length);

		for (const g of bucket.groups) {
			for (const [i, q] of g.questions.entries()) {
				const seed = `${bucket.module}|${bucket.exam}|${g.materialIndex}|${q.stem}|${i}`;
				q.qid = /^\d+$/.test(q.qid)
					? q.qid
					: String(8000000000 + (fnv1a(seed) % 1999999999));
				q.correct = normAnswer(q.answer);
				q.answerRaw = q.answer;
			}
		}
	}

	return [...byExam.values()];
}

function moduleNeedsMaterial(module) {
	return String(module).includes(MODULE_WITH_MATERIAL);
}

function parseArgs(argv) {
	const opts = {
		out: "题库笔记",
		images: null,
		source: null,
		module: "常识判断",
		dry: false,
		help: false,
		sample: false,
		file: null,
	};
	const rest = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--out") opts.out = argv[++i];
		else if (a === "--images") opts.images = argv[++i];
		else if (a === "--source") opts.source = argv[++i];
		else if (a === "--module") opts.module = argv[++i];
		else if (a === "--dry-run" || a === "--dry") opts.dry = true;
		else if (a === "--sample") opts.sample = true;
		else if (a === "-h" || a === "--help") opts.help = true;
		else if (a.startsWith("-")) {
			console.error(`未知选项：${a}`);
			process.exit(1);
		} else rest.push(a);
	}

	opts.file = rest[0] ?? null;
	return opts;
}

const SAMPLE_CSV = [
	"模块,试卷,地区,年份,考点,题干,选项A,选项B,选项C,选项D,答案,解析",
	"常识判断,示例卷一,示例,2026,地理国情,下列关于我国地理的说法正确的是？,我国地势西高东低呈三级阶梯分布,我国最大的岛屿是海南岛,长江是我国第二长河,我国最南端在海南岛,A,（此处填写你自己的解析）",
].join("\n");

function help() {
	console.log(`通用题库导入工具

用法：
  node scripts/import.mjs <输入文件> [选项]
  node scripts/import.mjs --sample      打印 CSV 列名模板

选项：
  --out <目录>      笔记输出目录（默认 ./题库笔记）
  --images <目录>   图片源目录（默认：输入文件所在目录）
  --source <文本>   写入 frontmatter 的来源标注
  --module <名称>   数据里没有「模块」列时的兜底模块名
  --dry-run         只输出统计预览，不写文件

支持输入：.csv（一行一题）、.json（数组或 {questions:[...]}）

常用列名（会自动匹配别名，不区分大小写与空格）：
  模块 / 试卷 / 地区 / 年份 / 考点 / qid / 材料 / 题干
  选项A…选项H（或 A、optionA、A选项）
  答案 / 解析

⚠️ 本工具不含任何题目数据，请确保你有权使用导入的内容。`);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (opts.help) {
		help();
		return;
	}
	if (opts.sample) {
		console.log(SAMPLE_CSV);
		return;
	}
	if (!opts.file) {
		help();
		process.exit(1);
	}

	const input = resolve(opts.file);
	if (!existsSync(input)) {
		console.error(`找不到输入文件：${input}`);
		process.exit(1);
	}

	const outDir = resolve(opts.out);
	const imgBase = opts.images ? resolve(opts.images) : dirname(input);

	console.log(`输入：${input}`);
	console.log(`输出：${outDir}`);
	console.log(`图片源：${imgBase}`);
	console.log("");

	let records;
	try {
		records = readRecords(input);
	} catch (e) {
		console.error(`读取失败：${e.message}`);
		process.exit(1);
	}

	console.log(`读取到 ${records.length} 条记录`);

	const probe = detectFields(records);
	if (!probe.stem) {
		console.error(`\n❌ 没找到「题干」列，无法导入。`);
		console.error(`   文件里的列名：${Object.keys(records[0] ?? {}).join(" / ")}`);
		console.error(`   请补一列名为「题干」的列（也接受 question / stem / 题目 / 内容）。`);
		process.exit(1);
	}
	if (!probe.module)
		console.error(
			`⚠️ 没找到「模块」列，全部题目将归入「${opts.module}」（可用 --module 修改）。`
		);
	if (!probe.answer)
		console.error(`⚠️ 没找到「答案」列，导入后这些题将无法自动判分。`);
	if (!probe.options)
		console.error(`⚠️ 没找到任何选项列（选项A…），将只能做「显示答案」模式。`);

	const buckets = organize(records);
	if (!buckets.length) {
		console.error("没有可用的题目：请检查是否缺少「题干」或「模块」列");
		process.exit(1);
	}

	// 收集并复制图片
	const copied = new Map();
	const missing = new Set();
	const warn = (s) => missing.add(s);

	for (const b of buckets) {
		for (const g of b.groups) {
			for (const q of g.questions) {
				const blob = [
					g.material,
					q.stem,
					q.explanation,
					...q.options.map((o) => o.text),
				].join("\n");
				for (const src of collectImages(blob)) {
					if (copied.has(src)) continue;
					const abs = src.startsWith("/") ? src : join(imgBase, src);
					if (!existsSync(abs)) {
						warn(src);
						continue;
					}
					const kind = /公式|formula|tex/i.test(src) ? "公式图" : "题目图";
					const name = basename(abs);
					const rel = `90-图片/${kind}/${name}`;
					const dest = join(outDir, "90-图片", kind, name);
					mkdirSync(dirname(dest), { recursive: true });
					copyFileSync(abs, dest);
					copied.set(src, rel);
				}
			}
		}
	}

	// 改写所有图片路径后渲染
	let total = 0;
	const byModule = new Map();
	const noAnswer = [];
	const noOption = [];
	const files = [];

	for (const b of buckets) {
		const groups = b.groups.map((g) => ({
			material: rewriteImages(g.material, copied, warn),
			materialIndex: g.materialIndex,
			questions: g.questions.map((q) => ({
				...q,
				stem: rewriteImages(q.stem, copied, warn),
				explanation: rewriteImages(q.explanation, copied, warn),
				options: q.options.map((o) => ({
					...o,
					text: rewriteImages(o.text, copied, warn),
				})),
			})),
		}));

		const content = renderNote(
			{
				exam: b.exam,
				region: b.region || "未标注",
				year: b.year || "未标注",
				module: b.module,
				source: opts.source,
			},
			groups
		);

		const dir = join(outDir, safeName(b.module));
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `${safeName(b.exam)}.md`);
		files.push(file);

		if (!opts.dry) writeFileSync(file, content, "utf8");

		for (const g of groups) {
			for (const q of g.questions) {
				total++;
				byModule.set(b.module, (byModule.get(b.module) ?? 0) + 1);
				if (!q.correct) noAnswer.push(q.qid);
				if (!q.options.length) noOption.push(q.qid);
			}
		}
	}

	console.log("");
	console.log("=== 导入统计 ===");
	console.log(`生成笔记：${files.length} 篇`);
	console.log(`题目总数：${total} 题`);
	console.log("");
	console.log("各模块分布：");
	for (const [m, n] of [...byModule.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${m.padEnd(16, " ")} ${n} 题`);
	}
	if (copied.size) console.log(`\n复制图片：${copied.size} 张`);
	if (noAnswer.length)
		console.log(`\n⚠️ 有 ${noAnswer.length} 题缺少可识别的答案字母，将无法判分`);
	if (noOption.length)
		console.log(`⚠️ 有 ${noOption.length} 题没有任何选项`);
	if (missing.size) {
		console.log(`\n⚠️ 有 ${missing.size} 处图片引用找不到文件，已保留原路径：`);
		for (const s of [...missing].slice(0, 5)) console.log(`  ${s}`);
		if (missing.size > 5) console.log(`  …还有 ${missing.size - 5} 处`);
	}

	if (opts.dry) {
		console.log("\n（--dry-run 模式，未写入任何文件）");
		return;
	}

	// 回读校验：用解析引擎重新解析生成结果，确认能被识别
	const parserBundle = join(projectRoot, "scripts", ".parser.bundle.mjs");
	await esbuild.build({
		entryPoints: [join(projectRoot, "src", "parser.ts")],
		bundle: true,
		format: "esm",
		platform: "node",
		outfile: parserBundle,
	});
	const { parseExamNote } = await import(
		pathToFileURL(parserBundle).href
	);

	let reparsed = 0;
	let unresolved = 0;
	for (const file of files) {
		const text = readFileSync(file, "utf8");
		const qs = parseExamNote(
			text,
			file.slice(outDir.length + 1).split(sep).join("/")
		);
		reparsed += qs.length;
		unresolved += qs.filter((q) => !q.answer).length;
	}

	console.log("");
	console.log("=== 回读校验 ===");
	console.log(
		reparsed === total
			? `✅ 解析引擎完整识别 ${reparsed} 题，与导入数一致`
			: `❌ 回读 ${reparsed} 题，与导入的 ${total} 题不一致，请检查格式`
	);

	if (reparsed !== total) process.exitCode = 1;

	rmSync(parserBundle, { force: true });
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
