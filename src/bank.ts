import { App, TFile } from "obsidian";
import {
	parseExamNote,
	extractImageRefs,
	isIncompleteAnswer,
} from "./parser";
import type { ExamMeta, FilterState, Question } from "./types";

export interface IndexEntry {
	qid: string;
	uid: string;
	module: string;
	exam: string;
	region: string;
	year: string;
	point: string;
	file: string;
	index: number;
	materialIndex: number;
	hasImage: boolean;
	incomplete: boolean;
}

/** 抽题单元：普通题一题一单元，资料分析按「材料 + 下属小题群」整体为一个单元 */
export interface DrawUnit {
	key: string;
	file: string;
	materialIndex: number;
	questions: IndexEntry[];
}

function shuffle<T>(arr: T[]): T[] {
	const a = [...arr];
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

export class Bank {
	private entries: IndexEntry[] = [];
	private loaded = false;

	constructor(
		private app: App,
		private rootFolder: string
	) {}

	private get cachePath(): string {
		return `${this.app.vault.configDir}/plugins/obsidian-xingce/bank-index.json`;
	}

	/** 更换题库根目录后需要重建索引 */
	setRoot(folder: string): void {
		const next = folder.replace(/^\/+|\/+$/g, "");
		if (next === this.rootFolder) return;
		this.rootFolder = next;
		this.entries = [];
		this.loaded = false;
	}

	private notes(): TFile[] {
		const root = this.rootFolder.replace(/\/+$/, "");
		return this.app.vault.getMarkdownFiles().filter((f) => {
			if (f.path.endsWith("README.md")) return false;
			return root === "" || f.path.startsWith(root + "/");
		});
	}

	private signature(files: TFile[]): string {
		let m = 0;
		for (const f of files) m = (m + f.stat.mtime) % 2147483647;
		return `${files.length}:${m}`;
	}

	async load(
		onProgress?: (done: number, total: number) => void
	): Promise<IndexEntry[]> {
		const files = this.notes();
		const sig = this.signature(files);

		try {
			if (await this.app.vault.adapter.exists(this.cachePath)) {
				const raw = await this.app.vault.adapter.read(this.cachePath);
				const parsed = JSON.parse(raw);
				if (parsed?.signature === sig && Array.isArray(parsed.entries)) {
					this.entries = parsed.entries;
					this.loaded = true;
					onProgress?.(files.length, files.length);
					return this.entries;
				}
			}
		} catch {
			// 缓存损坏则重建
		}

		const built = await this.buildIndex(files, onProgress);
		this.entries = built;
		this.loaded = true;
		try {
			await this.app.vault.adapter.write(
				this.cachePath,
				JSON.stringify({ signature: sig, entries: built })
			);
		} catch {
			// 写缓存失败不影响使用
		}
		return built;
	}

	async rebuild(
		onProgress?: (done: number, total: number) => void
	): Promise<IndexEntry[]> {
		return this.buildIndex(this.notes(), onProgress).then(async (built) => {
			this.entries = built;
			this.loaded = true;
			return built;
		});
	}

	private async buildIndex(
		files: TFile[],
		onProgress?: (done: number, total: number) => void
	): Promise<IndexEntry[]> {
		const out: IndexEntry[] = [];
		for (let i = 0; i < files.length; i++) {
			const f = files[i];
			try {
				const raw = await this.app.vault.cachedRead(f);
				for (const q of parseExamNote(raw, f.path)) {
					const imgs = [
						...extractImageRefs(q.stem),
						...q.options.flatMap((o) => extractImageRefs(o.text)),
					];
					out.push({
						qid: q.qid,
						uid: q.uid,
						module: q.module,
						exam: q.exam,
						region: q.region,
						year: q.year,
						point: q.point,
						file: f.path,
						index: q.index,
						materialIndex: q.material ? q.materialIndex : 0,
						hasImage: imgs.length > 0,
						incomplete: isIncompleteAnswer(q.answer),
					});
				}
			} catch {
				// 单篇解析失败跳过
			}
			onProgress?.(i + 1, files.length);
		}
		return out;
	}

	get ready(): boolean {
		return this.loaded;
	}

	get size(): number {
		return this.entries.length;
	}

	all(): IndexEntry[] {
		return this.entries;
	}

	filter(f: FilterState): IndexEntry[] {
		return this.entries.filter((e) => {
			if (f.modules.length && !f.modules.includes(e.module)) return false;
			if (f.points.length && !f.points.includes(e.point)) return false;
			if (f.years.length && !f.years.includes(e.year)) return false;
			if (f.regions.length && !f.regions.includes(e.region)) return false;
			if (f.onlyWithImage && !e.hasImage) return false;
			if (f.excludeIncomplete && e.incomplete) return false;
			return true;
		});
	}

	units(pool: IndexEntry[]): DrawUnit[] {
		const groups = new Map<string, IndexEntry[]>();
		for (const e of pool) {
			// 资料分析按「材料 + 小题群」整体成组，其余模块一题一单元。
			// 这里用 uid 而非 qid 做键：qid 在联考卷之间会重复。
			const key =
				e.module === "资料分析"
					? `${e.file}#${e.materialIndex}`
					: `u:${e.uid}`;
			let g = groups.get(key);
			if (!g) {
				g = [];
				groups.set(key, g);
			}
			g.push(e);
		}
		return [...groups.entries()].map(([key, questions]) => ({
			key,
			file: questions[0].file,
			materialIndex: questions[0].materialIndex,
			questions: [...questions].sort((a, b) => a.index - b.index),
		}));
	}

	/** 随机抽题，返回完整题目正文（按单元边界取整） */
	async draw(f: FilterState, n: number): Promise<Question[]> {
		const pool = this.filter(f);
		if (!pool.length) return [];
		const picked: IndexEntry[] = [];
		for (const u of shuffle(this.units(pool))) {
			picked.push(...u.questions);
			if (picked.length >= n) break;
		}
		return this.hydrate(picked);
	}

	/**
	 * 智能加权抽题：weightOf 越大的题目越容易被抽中。
	 * 配合 buildWeakness 使用——薄弱模块与个人易错题权重更高。
	 */
	async drawSmart(
		f: FilterState,
		n: number,
		weightOf: (qid: string) => number
	): Promise<Question[]> {
		const pool = this.filter(f);
		if (!pool.length) return [];
		return this.hydrate(this.weightedPick(this.units(pool), n, weightOf));
	}

	/** 按 qid 集合抽题（错题本 / 收藏用），同样按单元边界取整。
	 *  传入 weightOf 时按权重抽取，否则均匀随机。 */
	async pickByQids(
		qids: string[],
		n: number,
		weightOf?: (qid: string) => number
	): Promise<Question[]> {
		const set = new Set(qids);
		const pool = this.entries.filter((e) => set.has(e.qid));
		if (!pool.length) return [];
		if (!weightOf) {
			const picked: IndexEntry[] = [];
			for (const u of shuffle(this.units(pool))) {
				picked.push(...u.questions);
				if (picked.length >= n) break;
			}
			return this.hydrate(picked);
		}
		return this.hydrate(this.weightedPick(this.units(pool), n, weightOf));
	}

	/** 按试卷名取整套（模考用），按模块与题号排序 */
	async drawExam(exam: string): Promise<Question[]> {
		const pool = this.entries.filter((e) => e.exam === exam);
		pool.sort(
			(a, b) =>
				a.module.localeCompare(b.module, "zh") ||
				a.materialIndex - b.materialIndex ||
				a.index - b.index
		);
		return this.hydrate(pool);
	}

	exams(): ExamMeta[] {
		const map = new Map<string, ExamMeta>();
		for (const e of this.entries) {
			let m = map.get(e.exam);
			if (!m) {
				m = { exam: e.exam, region: e.region, year: e.year, modules: [], total: 0 };
				map.set(e.exam, m);
			}
			m.total++;
			if (!m.modules.includes(e.module)) m.modules.push(e.module);
		}
		return [...map.values()].sort(
			(a, b) => b.year.localeCompare(a.year) || a.exam.localeCompare(b.exam, "zh")
		);
	}

	async hydrate(entries: IndexEntry[]): Promise<Question[]> {
		const byFile = new Map<string, string[]>();
		for (const e of entries) {
			let arr = byFile.get(e.file);
			if (!arr) {
				arr = [];
				byFile.set(e.file, arr);
			}
			arr.push(e.uid);
		}

		const out: Question[] = [];
		for (const [fp, qids] of byFile) {
			const af = this.app.vault.getAbstractFileByPath(fp);
			if (!(af instanceof TFile)) continue;
			const raw = await this.app.vault.cachedRead(af);
			const map = new Map(parseExamNote(raw, fp).map((q) => [q.uid, q]));
			for (const id of qids) {
				const q = map.get(id);
				if (q) out.push(q);
			}
		}

		const order = new Map<string, number>();
		entries.forEach((e, i) => order.set(e.uid, i));
		out.sort((a, b) => (order.get(a.uid) ?? 0) - (order.get(b.uid) ?? 0));
		return out;
	}

	/** 按单元加权随机抽取：每轮按权重选一个单元，凑够 n 题为止 */
	private weightedPick(
		units: DrawUnit[],
		n: number,
		weightOf: (qid: string) => number
	): IndexEntry[] {
		const weighted = units.map((u) => ({
			u,
			w:
				u.questions.reduce(
					(s, e) => s + Math.max(0.01, weightOf(e.qid)),
					0
				) / u.questions.length,
		}));
		const picked: IndexEntry[] = [];
		const avail = [...weighted];
		while (avail.length && picked.length < n) {
			const total = avail.reduce((s, x) => s + x.w, 0);
			let r = Math.random() * total;
			let idx = 0;
			for (; idx < avail.length; idx++) {
				r -= avail[idx].w;
				if (r <= 0) break;
			}
			if (idx >= avail.length) idx = avail.length - 1;
			picked.push(...avail.splice(idx, 1)[0].u.questions);
		}
		return picked;
	}

	facets() {
		const uniq = (key: keyof IndexEntry) =>
			[...new Set(this.entries.map((e) => e[key] as string))].sort((a, b) =>
				(a as string).localeCompare(b as string, "zh")
			);
		return {
			modules: uniq("module"),
			points: uniq("point"),
			years: uniq("year").sort().reverse(),
			regions: uniq("region"),
		};
	}
}
