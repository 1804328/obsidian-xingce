import { ItemView, MarkdownRenderer, Notice, WorkspaceLeaf } from "obsidian";
import type { Question } from "../types";
import { toMarkdown } from "../render";
import type XingcePlugin from "../main";

export const VIEW_TYPE_EXAM = "xingce-exam-view";

interface ExamSession {
	exam: string;
	questions: Question[];
	idx: number;
	answers: Map<string, string[]>;
	startedAt: number;
	durationMs: number;
	submitted: boolean;
	timer: number | null;
	pending: string[];
}

function fmt(ms: number): string {
	const t = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export class ExamView extends ItemView {
	private plugin: XingcePlugin;
	private session: ExamSession | null = null;
	private loading = false;
	private selected = "";
	private minutes = 120;

	constructor(leaf: WorkspaceLeaf, plugin: XingcePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_EXAM;
	}

	getDisplayText(): string {
		return "整卷模考";
	}

	getIcon(): string {
		return "timer";
	}

	async onOpen(): Promise<void> {
		this.minutes = this.plugin.store.data.settings.examMinutes;
		await this.plugin.ensureBank();
		if (!this.selected) {
			const first = this.plugin.bank.exams()[0];
			if (first) this.selected = first.exam;
		}
		this.render();
	}

	async onClose(): Promise<void> {
		this.stopTimer();
	}

	private stopTimer(): void {
		const s = this.session;
		if (s?.timer !== null && s?.timer !== undefined) {
			window.clearInterval(s.timer);
			s.timer = null;
		}
	}

	private async render(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("xc-root");
		if (this.session) await this.renderExam(el);
		else this.renderSetup(el);
	}

	private renderSetup(el: HTMLElement): void {
		el.createDiv({ cls: "xc-title", text: "整卷模考" });
		const exams = this.plugin.bank.exams();
		el.createDiv({
			cls: "xc-sub",
			text: `共 ${exams.length} 套原卷可选，按原卷顺序作答并计时。`,
		});

		if (!exams.length) {
			el.createDiv({
				cls: "xc-empty",
				text: "没有解析到任何真题笔记。请到插件设置里指定题库根目录。",
			});
			return;
		}

		const row = el.createDiv({ cls: "xc-exam-pick" });

		const selWrap = row.createDiv({ cls: "xc-select-wrap" });
		const filterInput = selWrap.createEl("input", {
			type: "text",
			cls: "xc-exam-filter",
			placeholder: "搜索地区或年份，如「浙江」「2025」",
		});
		const sel = selWrap.createEl("select", { cls: "xc-exam-select" });

		const renderOptions = (kw: string) => {
			sel.empty();
			const k = kw.trim();
			const list = k
				? exams.filter(
						(e) => e.exam.includes(k) || e.region.includes(k) || e.year.includes(k)
					)
				: exams;
			if (!list.length) {
				sel.createEl("option", { text: "无匹配试卷", value: "" });
				return;
			}
			for (const e of list)
				sel.createEl("option", {
					text: `${e.exam} · ${e.total} 题`,
					value: e.exam,
				});
			if (!list.some((e) => e.exam === this.selected))
				this.selected = list[0].exam;
			sel.value = this.selected;
		};
		renderOptions("");
		filterInput.oninput = () => renderOptions(filterInput.value);
		sel.onchange = () => {
			this.selected = sel.value;
		};

		const mWrap = row.createDiv({ cls: "xc-num" });
		mWrap.createSpan({ text: "时长" });
		const mInput = mWrap.createEl("input", {
			type: "number",
			value: String(this.minutes),
		});
		mInput.min = "5";
		mInput.max = "300";
		mInput.oninput = () => {
			const v = Number.parseInt(mInput.value, 10);
			if (!Number.isNaN(v)) this.minutes = Math.max(5, Math.min(300, v));
		};

		const btn = row.createEl("button", {
			cls: "xc-btn xc-btn-primary",
			text: "开始模考",
		});
		btn.onclick = async () => {
			this.loading = true;
			this.renderLoading();
			const qs = await this.plugin.bank.drawExam(this.selected);
			this.loading = false;
			if (!qs.length) {
				new Notice("该卷没有可用题目");
				this.render();
				return;
			}
			this.session = {
				exam: this.selected,
				questions: qs,
				idx: 0,
				answers: new Map(),
				startedAt: Date.now(),
				durationMs: this.minutes * 60_000,
				submitted: false,
				timer: null,
				pending: [],
			};
			this.startTimer();
			this.render();
		};
	}

	private startTimer(): void {
		this.stopTimer();
		const s = this.session;
		if (!s) return;
		s.timer = window.setInterval(() => {
			const remain = s.durationMs - (Date.now() - s.startedAt);
			const slot = this.contentEl.querySelector(".xc-timer");
			if (slot) slot.textContent = fmt(remain);
			if (remain <= 0) {
				this.stopTimer();
				void this.submit();
			}
		}, 1000);
	}

	private renderLoading(): void {
		const el = this.contentEl;
		el.empty();
		const box = el.createDiv({ cls: "xc-loading" });
		box.createDiv({ cls: "xc-loading-title", text: "正在组卷" });
	}

	private async renderExam(el: HTMLElement): Promise<void> {
		const s = this.session;
		if (!s) return;
		const q = s.questions[s.idx];
		if (!q) return;

		if (s.submitted) {
			await this.renderReview(el, q);
			return;
		}

		const correct = this.correctKeysOf(q);
		const multi = correct.length > 1;
		const choice = s.answers.get(q.uid) ?? [];

		const bar = el.createDiv({ cls: "xc-top-bar" });
		bar.createDiv({
			cls: "xc-progress-text",
			text: `第 ${s.idx + 1} / ${s.questions.length} 题`,
		});
		const right = bar.createDiv({ cls: "xc-exam-status" });
		right.createSpan({
			cls: "xc-timer",
			text: fmt(s.durationMs - (Date.now() - s.startedAt)),
		});
		right.createSpan({
			cls: "xc-tag",
			text: `已答 ${s.answers.size}`,
		});

		await this.renderQuestionBody(el, s, q, multi, choice);

		const nav = el.createDiv({ cls: "xc-nav" });
		const prev = nav.createEl("button", { cls: "xc-btn", text: "上一题" });
		prev.disabled = s.idx === 0;
		prev.onclick = () => this.goto(s.idx - 1);

		const next = nav.createEl("button", { cls: "xc-btn", text: "下一题" });
		next.disabled = s.idx >= s.questions.length - 1;
		next.onclick = () => this.goto(s.idx + 1);

		const sub = nav.createEl("button", {
			cls: "xc-btn xc-btn-primary",
			text: "交卷",
		});
		sub.onclick = () => void this.submit();

		const quit = nav.createEl("button", {
			cls: "xc-btn xc-btn-ghost",
			text: "放弃",
		});
		quit.onclick = () => {
			this.stopTimer();
			this.session = null;
			this.render();
		};

		el.createDiv({ cls: "xc-sheet-label", text: "答题卡" });
		const sheet = el.createDiv({ cls: "xc-sheet" });
		s.questions.forEach((qq, i) => {
			const b = sheet.createEl("button", {
				cls: `xc-sheet-cell${s.answers.has(qq.uid) ? " is-done" : ""}${
					i === s.idx ? " is-current" : ""
				}`,
				text: String(i + 1),
			});
			b.onclick = () => this.goto(i);
		});
	}

	private async renderQuestionBody(
		el: HTMLElement,
		s: ExamSession,
		q: Question,
		multi: boolean,
		choice: string[]
	): Promise<void> {
		if (q.material) {
			const mat = el.createDiv({ cls: "xc-material" });
			mat.createDiv({
				cls: "xc-material-label",
				text: `材料 ${q.materialIndex}`,
			});
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

		const list = el.createDiv({ cls: "xc-options-list" });
		for (const opt of q.options) {
			const picked = choice.includes(opt.key);
			const b = list.createDiv({
				cls: `xc-option${picked ? " is-picked" : ""}`,
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
			b.onclick = () => {
				const cur = s.answers.get(q.uid) ?? [];
				if (multi) {
					const i2 = cur.indexOf(opt.key);
					const next = i2 >= 0 ? cur.filter((k) => k !== opt.key) : [...cur, opt.key];
					if (next.length) s.answers.set(q.uid, next);
					else s.answers.delete(q.uid);
				} else {
					s.answers.set(q.uid, [opt.key]);
				}
				this.render();
			};
		}
	}

	private goto(i: number): void {
		const s = this.session;
		if (!s) return;
		s.idx = Math.max(0, Math.min(s.questions.length - 1, i));
		s.pending = [];
		this.render();
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

	private async submit(): Promise<void> {
		const s = this.session;
		if (!s) return;
		this.stopTimer();

		let ok = 0;
		let mastered = 0;
		for (const q of s.questions) {
			const c = s.answers.get(q.uid) ?? [];
			const correct = this.grade(q, c);
			if (correct) ok++;
			if (this.plugin.store.recordAnswer(q.qid, correct, c).removed)
				mastered++;
		}
		await this.plugin.store.save();
		if (mastered)
			new Notice(`本次有 ${mastered} 道错题连续答对达标，已移出错题本`);

		s.submitted = true;
		s.idx = 0;
		await this.render();
	}

	private async renderReview(el: HTMLElement, q: Question): Promise<void> {
		const s = this.session;
		if (!s) return;

		let ok = 0;
		for (const qq of s.questions) {
			const c = s.answers.get(qq.uid) ?? [];
			if (this.grade(qq, c)) ok++;
		}

		const total = s.questions.length;
		const pct = total ? Math.round((ok / total) * 100) : 0;
		const used = Date.now() - s.startedAt;

		const bar = el.createDiv({ cls: "xc-top-bar" });
		bar.createDiv({
			cls: "xc-progress-text",
			text: `交卷完成 · ${pct}%`,
		});
		const right = bar.createDiv({ cls: "xc-exam-status" });
		right.createSpan({ cls: "xc-tag", text: `答对 ${ok} / ${total}` });
		right.createSpan({ cls: "xc-tag", text: `用时 ${fmt(used)}` });

		const correct = this.correctKeysOf(q);
		const choice = s.answers.get(q.uid) ?? [];
		const isRight = this.grade(q, choice);

		el.createDiv({
			cls: `xc-verdict ${isRight ? "is-ok" : "is-bad"}`,
			text: isRight
				? "回答正确"
				: `回答错误 · 正确答案 ${correct.join("") || q.answer}`,
		});

		await this.renderQuestionBody(el, s, q, false, choice);

		const feed = el.createDiv({ cls: "xc-feedback" });
		const exp = feed.createDiv({ cls: "xc-explanation" });
		await MarkdownRenderer.render(
			this.app,
			toMarkdown(q.explanation, q.file),
			exp,
			q.file,
			this
		);
		const src = feed.createDiv({ cls: "xc-source" });
		src.createSpan({ text: `来源：${q.exam}` });
		src.createSpan({ cls: "xc-qid", text: `qid ${q.qid}` });

		const nav = el.createDiv({ cls: "xc-nav" });
		const prev = nav.createEl("button", { cls: "xc-btn", text: "上一题" });
		prev.disabled = s.idx === 0;
		prev.onclick = () => this.goto(s.idx - 1);

		const next = nav.createEl("button", { cls: "xc-btn", text: "下一题" });
		next.disabled = s.idx >= s.questions.length - 1;
		next.onclick = () => this.goto(s.idx + 1);

		const back = nav.createEl("button", { cls: "xc-btn", text: "返回" });
		back.onclick = () => {
			this.session = null;
			this.render();
		};
	}
}
