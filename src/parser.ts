import type { Question } from "./types";

/**
 * 真题笔记解析器。
 *
 * 设计约束：不依赖 Obsidian API，纯字符串处理，
 * 以便在 Node 端跑全量校验、在插件端直接复用同一套逻辑。
 *
 * 解析目标格式：
 * ```
 * ---
 * 试卷: "..." / 地区: "..." / 年份: "..." / 模块: "..." / 题数: "..."
 * ---
 * ## 材料 1              <- 仅资料分析有，后续题目归属该材料
 * <p>材料正文…</p>
 * ### 第 1 题　<sub>qid 2263114 · 综合</sub>
 * 题干正文
 * - **A**. 选项　✅
 * **答案**：D
 * **官方解析**
 * 解析正文
 * ---
 * ```
 */

const RE_Q = /^(#{2,3})\s*第\s*(\d+)\s*题[\s　]*<sub>\s*qid\s*(\d+)\s*[·•・]\s*([^<]*?)\s*<\/sub>/;
const RE_MATERIAL = /^#{2,3}\s*材料\s*(\d+)/;
const RE_OPTION = /^[-*+]\s*\*\*([A-H])\*\*\s*[.。、]?\s*(.*)$/;
const RE_ANSWER = /^\*\*答案\*\*\s*[：:]\s*(.*)$/;
const RE_EXPLAIN = /^\*\*官方解析\*\*/;
const RE_SEPARATOR = /^-{3,}$/;
const RE_IMG = /<img[^>]+src=["']([^"']+)["']/g;

const CHECK = "\u2705";

type Mode = "stem" | "options" | "answer" | "explanation";

function trimBlank(text: string): string {
	return text.replace(/^[\s　]*\n/, "").replace(/[\s　]+$/, "");
}

/** 移除选项末尾用于标记正确答案的 ✅ */
export function cleanOptionText(text: string): string {
	return text.replace(/[\s　]*\u2705[\s　]*/g, "").trim();
}

/** 抽取文本中的 <img src="..."> 引用 */
export function extractImageRefs(text: string): string[] {
	const out: string[] = [];
	RE_IMG.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = RE_IMG.exec(text)) !== null) out.push(m[1]);
	return out;
}

/** 把笔记里的相对图片路径解析为仓库内绝对路径 */
export function resolveVaultPath(srcFile: string, src: string): string {
	if (/^(https?:|app:|data:|file:)/.test(src)) return src;
	const base = srcFile.split("/");
	base.pop();
	for (const seg of src.split("?")[0].split("/")) {
		if (seg === "." || seg === "") continue;
		if (seg === "..") base.pop();
		else base.push(seg);
	}
	return base.join("/");
}

export function isIncompleteAnswer(answer: string): boolean {
	return !answer || /缺|无|空|略/.test(answer);
}

export function parseExamNote(content: string, file: string): Question[] {
	const { fm, body } = splitFrontmatter(content);
	const lines = body.split(/\r?\n/);
	const out: Question[] = [];

	let cur: Question | null = null;
	let mode: Mode = "stem";
	let material = "";
	let materialIndex = 0;
	let inMaterial = false;

	const flush = () => {
		if (cur) {
			cur.stem = trimBlank(cur.stem);
			cur.explanation = trimBlank(cur.explanation);
			cur.material = trimBlank(material);
			if (cur.stem || cur.options.length) out.push(cur);
		}
		cur = null;
	};

	for (const line of lines) {
		if (RE_SEPARATOR.test(line.trim())) {
			if (mode === "explanation") flush();
			continue;
		}

		const mm = RE_MATERIAL.exec(line);
		if (mm) {
			flush();
			materialIndex = Number.parseInt(mm[1], 10);
			material = "";
			inMaterial = true;
			continue;
		}

		const qq = RE_Q.exec(line);
		if (qq) {
			flush();
			inMaterial = false;
			const index = Number.parseInt(qq[2], 10);
			cur = {
				qid: qq[3],
				uid: `${file}#${materialIndex}#${index}`,
				module: fm["模块"] ?? "",
				exam: fm["试卷"] ?? "",
				region: fm["地区"] ?? "",
				year: fm["年份"] ?? "",
				point: (qq[4] ?? "").trim(),
				index,
				stem: "",
				options: [],
				answer: "",
				correctKeys: [],
				explanation: "",
				file,
				material,
				materialIndex,
			};
			mode = "stem";
			continue;
		}

		if (!cur) {
			if (inMaterial) material += (material ? "\n" : "") + line;
			continue;
		}

		const aa = RE_ANSWER.exec(line);
		if (aa) {
			cur.answer = (aa[1] ?? "").trim();
			mode = "answer";
			continue;
		}

		if (RE_EXPLAIN.test(line)) {
			mode = "explanation";
			continue;
		}

		const oo = RE_OPTION.exec(line);
		if (oo) {
			const text = oo[2] ?? "";
			if (text.includes(CHECK)) cur.correctKeys.push(oo[1]);
			cur.options.push({ key: oo[1], text: cleanOptionText(text) });
			mode = "options";
			continue;
		}

		if (inMaterial) {
			material += (material ? "\n" : "") + line;
			continue;
		}

		if (mode === "stem") cur.stem += (cur.stem ? "\n" : "") + line;
		else if (mode === "explanation")
			cur.explanation += (cur.explanation ? "\n" : "") + line;
	}

	flush();
	return out;
}

export function splitFrontmatter(content: string): {
	fm: Record<string, string>;
	body: string;
} {
	const fm: Record<string, string> = {};
	const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(content);
	if (!m) return { fm, body: content };
	for (const line of m[1].split(/\r?\n/)) {
		const kv = /^([^:]+):\s*(.*)$/.exec(line);
		if (kv) fm[kv[1].trim()] = kv[2].trim().replace(/^["']|["']$/g, "");
	}
	return { fm, body: content.slice(m[0].length) };
}
