import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type { Question } from "../types";
import { toMarkdown } from "../render";
import type XingcePlugin from "../main";

export const VIEW_TYPE_PRACTICE = "xingce-practice-view";

interface Session {
	questions: Question[];
	idx: number;
	answers: Map<string, string[]>;
	revealed: Set<string>;
	startedAt: number;
}

export class PracticeView extends ItemView {
	private plugin: XingcePlugin;
	private session: Session | null = null;
	private source: "all" | "wrong" | "favorite" = "all";
	private loading = false;
	private progress = { done: 0, total: 0 };
	private pending: string[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: XingcePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_PRACTICE;
	}

	getDisplayText(): string {
		return "行测刷题";
	}

	getIcon(): string {
		return "pen-line";
	}

	async onOpen(): Promise<void> {
		await this.plugin.ensureBank((d, t) => {
			this.progress = { done: d, total: t };
			this.renderLoading();
		});
		this.render();
	}

	private get filter() {
		return this.plugin.filterState;
	}

	/** 供命令调用：直接开一组随机题 */
	async quickDraw(n: number): Promise<void> {
		await this.plugin.ensureBank();
		await this.startSession(n);
		this.render();
	}

	private renderLoading(): void {
		const el = this.contentEl;
		el.empty();
		const box = el.createDiv({ cls: "xc-loading" });
		box.createDiv({ cls: "xc-loading-title", text: "正在建立题库索引" });
		const bar = box.createDiv({ cls: "xc-progress" });
		const pct = this.progress.total
			? Math.round((this.progress.done / this.progress.total) * 100)
			: 0;
		const fill = bar.createDiv({ cls: "xc-progress-fill" });
		fill.style.width = `${pct}%`;
		box.createDiv({
			cls: "xc-loading-sub",
			text: `${this.progress.done} / ${this.progress.total} 篇`,
		});
	}

	private async render(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("xc-root");
		if (this.session) await this.renderSession(el);
		else this.renderSetup(el);
	}

	private renderSetup(el: HTMLElement): void {
		const head = el.createDiv({ cls: "xc-head" });
		head.createDiv({ cls: "xc-title", text: "行测刷题" });
		const size = this.plugin.bank.size;
		head.createDiv({
			cls: "xc-sub",
			text: size ? `题库已就绪 · 共 ${size.toLocaleString()} 题` : "未找到题库笔记",
		});

		if (!size) {
			const tip = el.createDiv({ cls: "xc-empty" });
			tip.createDiv({
				text: "没有解析到任何真题笔记。请到插件设置里，把「题库根目录」指向你的真题笔记文件夹。",
			});
			return;
		}

		const facets = this.plugin.bank.facets();
		const f = this.filter;
		const store = this.plugin.store;

		this.chipRow(
			el,
			"来源",
			["全部题库", "我的错题", "我的收藏"],
			[this.source],
			(v) => {
				this.source = v as "all" | "wrong" | "favorite";
			}
		);

		if (this.source !== "all") {
			const n =
				this.source === "wrong"
					? store.wrongList().length
					: store.data.favorite.length;
			el.createDiv({
				cls: "xc-source-count",
				text: `当前${this.source === "wrong" ? "错题" : "收藏"} ${n} 题${n ? "" : "，先去刷题吧"}`,
			});
		}

		this.chipRow(el, "模块", facets.modules, f.modules, (v) =>
			this.toggle(f.modules, v)
		);

		const pointPool = this.plugin.bank.filter({
			...this.filter,
			points: [],
		});
		const availPoints = [
			...new Set(pointPool.map((e) => e.point)),
		].sort((a, b) => a.localeCompare(b, "zh"));
		this.chipRow(el, "考点", availPoints, f.points, (v) =>
			this.toggle(f.points, v)
		);

		this.chipRow(el, "年份", facets.years, f.years, (v) =>
			this.toggle(f.years, v)
		);

		const regionPool = this.plugin.bank.filter({
			...this.filter,
			regions: [],
		});
		const regionCounts = new Map<string, number>();
		for (const e of regionPool)
			regionCounts.set(e.region, (regionCounts.get(e.region) ?? 0) + 1);
		const availRegions = [...regionCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([k]) => k);
		this.chipRow(
			el,
			"地区",
			availRegions,
			f.regions,
			(v) => this.toggle(f.regions, v),
			12
		);

		const opts = el.createDiv({ cls: "xc-options" });
		this.checkRow(
			opts,
			"只看含图题（图形推理等）",
			f.onlyWithImage,
			(v) => (this.filter.onlyWithImage = v)
		);
		this.checkRow(
			opts,
			"排除答案残缺的题目",
			f.excludeIncomplete,
			(v) => (this.filter.excludeIncomplete = v)
		);

		const pool = this.plugin.bank.filter(this.filter);
		const unitCount = this.plugin.bank.units(pool).length;

		const bar = el.createDiv({ cls: "xc-start-bar" });
		bar.createDiv({
			cls: "xc-pool",
			text: `匹配 ${pool.length.toLocaleString()} 题 · ${unitCount.toLocaleString()} 个抽题单元`,
		});

		const numWrap = bar.createDiv({ cls: "xc-num" });
		numWrap.createSpan({ text: "题数" });
		const input = numWrap.createEl("input", {
			type: "number",
			value: String(this.plugin.drawCount),
		});
		input.min = "1";
		input.max = "200";
		input.oninput = () => {
			const v = Number.parseInt(input.value, 10);
			if (!Number.isNaN(v)) this.plugin.drawCount = Math.max(1, Math.min(200, v));
		};

		const btn = bar.createEl("button", {
			cls: "xc-btn xc-btn-primary",
			text: "开始刷题",
		});
		btn.onclick = async () => {
			await this.startSession(this.plugin.drawCount);
			this.render();
		};

		if (!pool.length) {
			el.createDiv({
				cls: "xc-empty",
				text: "当前筛选条件下没有题目，放宽一点试试。",
			});
		}
	}

	private toggle(arr: string[], v: string): void {
		const i = arr.indexOf(v);
		if (i >= 0) arr.splice(i, 1);
		else arr.push(v);
	}

	private chipRow(
		parent: HTMLElement,
		label: string,
		items: string[],
		selected: string[],
		onToggle: (v: string) => void,
		limit = 0
	): void {
		const row = parent.createDiv({ cls: "xc-filter-row" });
		row.createSpan({ cls: "xc-filter-label", text: label });
		const chips = row.createDiv({ cls: "xc-chips" });
		const list = limit > 0 && items.length > limit ? items.slice(0, limit) : items;
		for (const it of list) {
			const b = chips.createEl("button", {
				cls: `xc-chip${selected.includes(it) ? " is-on" : ""}`,
				text: it,
			});
			b.onclick = () => {
				onToggle(it);
				this.render();
			};
		}
		if (limit > 0 && items.length > limit)
			chips.createSpan({ cls: "xc-more", text: `等 ${items.length} 项` });
	}

	private checkRow(
		parent: HTMLElement,
		label: string,
		value: boolean,
		onChange: (v: boolean) => void
	): void {
		const row = parent.createDiv({ cls: "xc-check" });
		const cb = row.createEl("input", { type: "checkbox" });
		cb.checked = value;
		row.createSpan({ text: label });
		cb.onchange = () => onChange(cb.checked);
	}

	private async startSession(n: number): Promise<void> {
		this.loading = true;
		this.renderLoading();

		const store = this.plugin.store;
		let qs: Question[];
		if (this.source === "wrong") {
			qs = await this.plugin.bank.pickByQids(store.wrongList(), n);
		} else if (this.source === "favorite") {
			qs = await this.plugin.bank.pickByQids(store.data.favorite, n);
		} else {
			qs = await this.plugin.bank.draw(this.filter, n);
		}

		this.loading = false;
		if (!qs.length) {
			new Notice("没有匹配到题目");
			return;
		}
		this.session = {
			questions: qs,
			idx: 0,
			answers: new Map(),
			revealed: new Set(),
			startedAt: Date.now(),
		};
		this.pending = [];
	}

	private get current(): Question | null {
		if (!this.session) return null;
		return this.session.questions[this.session.idx] ?? null;
	}

	private async renderSession(el: HTMLElement): Promise<void> {
		const s = this.session;
		if (!s) return;
		const q = this.current;
		if (!q) return;

		const revealed = s.revealed.has(q.uid);
		const choice = s.answers.get(q.uid) ?? [];

		const bar = el.createDiv({ cls: "xc-top-bar" });
		bar.createDiv({
			cls: "xc-progress-text",
			text: `第 ${s.idx + 1} / ${s.questions.length} 题`,
		});
		const tag = bar.createDiv({ cls: "xc-tags" });
		if (q.module) tag.createSpan({ cls: "xc-tag", text: q.module });
		if (q.point) tag.createSpan({ cls: "xc-tag xc-tag-point", text: q.point });
		if (q.year) tag.createSpan({ cls: "xc-tag", text: q.year });
		if (q.region) tag.createSpan({ cls: "xc-tag", text: q.region });

		const correct = this.correctKeysOf(q);

		if (q.material) {
			const mat = el.createDiv({ cls: "xc-material" });
			mat.createDiv({ cls: "xc-material-label", text: `材料 ${q.materialIndex}` });
			const body = mat.createDiv({ cls: "xc-material-body" });
			await MarkdownRenderer.render(
				this.app,
				toMarkdown(q.material, q.file),
				body,
				q.file,
				this
			);
		}

		const stem = el.createDiv({ cls: "xc-stem" });
		await MarkdownRenderer.render(
			this.app,
			toMarkdown(q.stem, q.file),
			stem,
			q.file,
			this
		);

		const multi = correct.length > 1;

		if (!q.options.length) {
			const noOpt = el.createDiv({ cls: "xc-no-option" });
			noOpt.createDiv({ text: "此题无选项（判断 / 填空类），直接查看答案解析。" });
			const show = noOpt.createEl("button", { cls: "xc-btn", text: "显示答案" });
			show.onclick = () => {
				s.revealed.add(q.uid);
				s.answers.set(q.uid, []);
				this.render();
			};
		} else {
			const list = el.createDiv({ cls: "xc-options-list" });
			for (const opt of q.options) {
				const isRight = correct.includes(opt.key);
				const picked = choice.includes(opt.key);
				const b = list.createDiv({
					cls: [
						"xc-option",
						picked ? "is-picked" : "",
						revealed && isRight ? "is-right" : "",
						revealed && picked && !isRight ? "is-wrong" : "",
					]
						.filter(Boolean)
						.join(" "),
				});
				b.createSpan({ cls: "xc-opt-key", text: opt.key });
				const tx = b.createDiv({ cls: "xc-opt-text" });
				await MarkdownRenderer.render(
					this.app,
					toMarkdown(opt.text, q.file),
					tx,
					q.file,
					this
				);
				b.onclick = () => this.onPick(q, opt.key, multi);
			}

			if (multi && !revealed) {
				const bar2 = el.createDiv({ cls: "xc-submit-bar" });
				bar2.createSpan({
					cls: "xc-hint",
					text: this.pending.length
						? `已选 ${this.pending.join(" ")}`
						: "多选题，可多选后提交",
				});
				const sub = bar2.createEl("button", {
					cls: "xc-btn xc-btn-primary",
					text: "提交",
				});
			sub.disabled = !this.pending.length;
			sub.onclick = () => {
				this.commit(q, [...this.pending]);
				this.pending = [];
				this.render();
			};
			}
		}

		if (revealed) {
			const feed = el.createDiv({ cls: "xc-feedback" });
			const ok = this.grade(q, choice);
			const hasChoice = q.options.length > 0;
			feed.createDiv({
				cls: `xc-verdict ${!hasChoice ? "is-neutral" : ok ? "is-ok" : "is-bad"}`,
				text: !hasChoice
					? "答案与解析"
					: ok
						? "回答正确"
						: `回答错误 · 正确答案 ${correct.join("") || q.answer}`,
			});
			const exp = feed.createDiv({ cls: "xc-explanation" });
			await MarkdownRenderer.render(
				this.app,
				toMarkdown(q.explanation, q.file),
				exp,
				q.file,
				this
			);
			const acts = feed.createDiv({ cls: "xc-feedback-actions" });
			const rec = this.plugin.store.data.wrong[q.qid];
			if (rec) {
				if (this.plugin.store.masterStreak() > 0) {
					acts.createDiv({
						cls: "xc-hint",
						text: `错题本：累计答错 ${rec.count} 次 · 连续答对 ${rec.streak} / ${this.plugin.store.masterStreak()}`,
					});
				}
				const rm = acts.createEl("button", {
					cls: "xc-btn xc-btn-ghost",
					text: "移出错题本",
				});
				rm.onclick = async () => {
					this.plugin.store.removeWrong(q.qid);
					await this.plugin.store.save();
					new Notice("已移出错题本");
					this.render();
				};
			}

			const src = feed.createDiv({ cls: "xc-source" });
			src.createSpan({ text: `来源：${q.exam}` });
			src.createSpan({ cls: "xc-qid", text: `qid ${q.qid}` });
		}

		const nav = el.createDiv({ cls: "xc-nav" });
		const prev = nav.createEl("button", { cls: "xc-btn", text: "上一题" });
		prev.disabled = s.idx === 0;
		prev.onclick = () => {
			s.idx = Math.max(0, s.idx - 1);
			this.pending = [];
			this.render();
		};

		const fav = nav.createEl("button", {
			cls: `xc-btn${this.plugin.store.isFavorite(q.qid) ? " is-on" : ""}`,
			text: this.plugin.store.isFavorite(q.qid) ? "已收藏" : "收藏",
		});
		fav.onclick = async () => {
			await this.plugin.store.toggleFavorite(q.qid);
			this.render();
		};

		const next = nav.createEl("button", { cls: "xc-btn", text: "下一题" });
		next.disabled = s.idx >= s.questions.length - 1;
		next.onclick = () => {
			s.idx = Math.min(s.questions.length - 1, s.idx + 1);
			this.pending = [];
			this.render();
		};

		if (s.idx >= s.questions.length - 1) {
			const fin = nav.createEl("button", {
				cls: "xc-btn xc-btn-primary",
				text: "结束并查看成绩",
			});
			fin.onclick = () => this.showResult();
		}

		const quit = nav.createEl("button", { cls: "xc-btn xc-btn-ghost", text: "退出" });
		quit.onclick = () => {
			this.session = null;
			this.render();
		};
	}

	private onPick(q: Question, key: string, multi: boolean): void {
		const s = this.session;
		if (!s || s.revealed.has(q.uid)) return;
		if (multi) {
			const i = this.pending.indexOf(key);
			if (i >= 0) this.pending.splice(i, 1);
			else this.pending.push(key);
			this.render();
		} else {
			this.commit(q, [key]);
			this.render();
		}
	}

	private commit(q: Question, choice: string[]): void {
		const s = this.session;
		if (!s) return;
		s.answers.set(q.uid, choice);
		s.revealed.add(q.uid);
		const ok = this.grade(q, choice);
		const r = this.plugin.store.recordAnswer(q.qid, ok, choice);
		void this.plugin.store.save().then(() => {
			if (r.removed) new Notice(`连续答对 ${r.streak} 次，已移出错题本`);
		});
	}

	private correctKeysOf(q: Question): string[] {
		if (q.correctKeys.length) return q.correctKeys;
		return [...(q.answer.match(/[A-H]/g) ?? [])];
	}

	private grade(q: Question, choice: string[]): boolean {
		const right = this.correctKeysOf(q);
		if (!right.length) return false;
		return [...choice].sort().join("") === [...right].sort().join("");
	}

	private showResult(): void {
		const s = this.session;
		if (!s) return;
		let ok = 0;
		for (const q of s.questions) {
			const c = s.answers.get(q.uid);
			if (c && this.grade(q, c)) ok++;
		}
		const total = s.questions.length;
		const secs = Math.round((Date.now() - s.startedAt) / 1000);
		const mm = Math.floor(secs / 60);
		const ss = secs % 60;
		const pct = total ? Math.round((ok / total) * 100) : 0;

		const el = this.contentEl;
		el.empty();
		const box = el.createDiv({ cls: "xc-result" });
		box.createDiv({ cls: "xc-title", text: "本次练习完成" });
		const grid = box.createDiv({ cls: "xc-result-grid" });
		const cell = (label: string, value: string) => {
			const c = grid.createDiv({ cls: "xc-result-cell" });
			c.createDiv({ cls: "xc-result-value", text: value });
			c.createDiv({ cls: "xc-result-label", text: label });
		};
		cell("正确率", `${pct}%`);
		cell("答对", `${ok} / ${total}`);
		cell("用时", `${mm} 分 ${ss} 秒`);

		const btns = box.createDiv({ cls: "xc-result-btns" });
		const again = btns.createEl("button", {
			cls: "xc-btn xc-btn-primary",
			text: "再来一组",
		});
		again.onclick = async () => {
			await this.startSession(this.plugin.drawCount);
			this.render();
		};
		const back = btns.createEl("button", { cls: "xc-btn", text: "返回筛选" });
		back.onclick = () => {
			this.session = null;
			this.render();
		};
	}
}
