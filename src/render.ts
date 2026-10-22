import { resolveVaultPath } from "./parser";

const RE_IMG_TAG = /<img\b[^>]*>/g;
const RE_SRC = /\bsrc\s*=\s*(["'])([^"']+)\1/;
const RE_WIDTH = /\bwidth\s*=\s*(["']?)(\d+)/;
const RE_HEIGHT = /\bheight\s*=\s*(["']?)(\d+)/;
const ABSOLUTE = /^(https?:|app:|data:|file:)/;

/**
 * 把笔记里的原始 <img src="相对路径"> 转成 Obsidian 内嵌语法 ![[仓库内路径|宽x高]]。
 *
 * 不做这一步的话，Obsidian 的 markdown 渲染器无法解析相对路径，
 * 图形推理与资料分析会整片变裂图。
 */
export function normalizeImages(text: string, notePath: string): string {
	return text.replace(RE_IMG_TAG, (tag) => {
		const srcM = RE_SRC.exec(tag);
		if (!srcM) return tag;
		const src = srcM[2];
		if (ABSOLUTE.test(src)) return tag;

		const abs = resolveVaultPath(notePath, src);
		const w = RE_WIDTH.exec(tag);
		const h = RE_HEIGHT.exec(tag);
		let suffix = "";
		if (w && h) suffix = `|${w[2]}x${h[2]}`;
		else if (w) suffix = `|${w[2]}`;

		return `![[${abs}${suffix}]]`;
	});
}

/**
 * 笔记正文大量使用 <p>…</p> 包裹。转成 markdown 段落，
 * 否则在 Obsidian 里会渲染成没有段间距的一坨。
 */
export function htmlParasToMarkdown(text: string): string {
	return text
		.replace(/<\/p>\s*<p[^>]*>/g, "\n\n")
		.replace(/<\/?p[^>]*>/g, "\n")
		.replace(/[ \t　]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function toMarkdown(text: string, notePath: string): string {
	if (!text) return "";
	return htmlParasToMarkdown(normalizeImages(text, notePath));
}
