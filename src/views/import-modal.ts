import { App, Modal, Notice, Setting } from "obsidian";
import type XingcePlugin from "../main";
import { convertInput, importToVault, type ImportResult } from "../importer";

/**
 * 导入弹窗：选择 / 粘贴 CSV·JSON → 预览统计 → 写入仓库。
 * 复用与命令行导入完全相同的转换逻辑（importer.ts）。
 */
export class ImportModal extends Modal {
	private plugin: XingcePlugin;
	private text = "";
	private filename = "pasted.csv";
	private moduleFallback = "常识判断";
	private source = "";
	private previewEl!: HTMLElement;
	private lastResult: ImportResult | null = null;

	constructor(app: App, plugin: XingcePlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("xc-import-modal");

		contentEl.createEl("h3", { text: "导入我的题库" });
		contentEl.createEl("p", {
			cls: "xc-import-hint",
			text: "支持 CSV（一行一题）或 JSON（题目数组）。列名可用「题干 / 选项A~H / 答案 / 解析 / 模块 / 试卷 / 考点」等，已做宽松匹配。本工具只做格式转换，请确保你有权使用导入的内容。",
		});

		// 文件选择
		const fileInput = contentEl.createEl("input", {
			type: "file",
			cls: "xc-import-file",
		});
		fileInput.setAttribute("accept", ".csv,.json,text/csv,application/json");
		fileInput.addEventListener("change", async () => {
			const f = fileInput.files?.[0];
			if (!f) return;
			this.text = await f.text();
			this.filename = f.name;
			this.lastResult = null;
			this.renderPreview();
		});

		contentEl.createEl("div", {
			cls: "xc-import-or",
			text: "—— 或把内容粘贴到下面 ——",
		});

		// 粘贴区
		const ta = contentEl.createEl("textarea", {
			cls: "xc-import-textarea",
			attr: { placeholder: "在此粘贴 CSV 或 JSON 文本…" },
		});
		ta.addEventListener("input", () => {
			this.text = ta.value;
			this.filename = this.filename.endsWith(".json")
				? "pasted.json"
				: "pasted.csv";
			this.lastResult = null;
		});

		// 兜底模块 + 来源标注
		new Setting(contentEl)
			.setName("兜底模块")
			.setDesc("题目没有「模块」列时，统一归入此模块。")
			.addText((t) =>
				t
					.setPlaceholder("常识判断")
					.setValue(this.moduleFallback)
					.onChange((v) => (this.moduleFallback = v.trim() || "常识判断"))
			);

		new Setting(contentEl)
			.setName("来源标注")
			.setDesc("写入笔记 frontmatter 的「来源」字段，便于日后追溯。留空则不写。")
			.addText((t) =>
				t.setValue(this.source).onChange((v) => (this.source = v.trim()))
			);

		// 预览
		this.previewEl = contentEl.createDiv({ cls: "xc-import-preview" });

		// 操作按钮
		const btnRow = contentEl.createDiv({ cls: "xc-import-actions" });
		const previewBtn = btnRow.createEl("button", {
			text: "预览",
			cls: "mod-cta",
		});
		previewBtn.addEventListener("click", () => this.renderPreview());

		const importBtn = btnRow.createEl("button", {
			text: "导入并写入仓库",
			cls: "mod-warning",
		});
		importBtn.addEventListener("click", () => void this.doImport());
	}

	private renderPreview(): void {
		this.previewEl.empty();
		if (!this.text.trim()) {
			this.previewEl.createSpan({
				cls: "xc-muted",
				text: "尚未提供内容。选择文件或粘贴文本后点「预览」。",
			});
			return;
		}
		let res: ImportResult;
		try {
			res = convertInput(this.text, this.filename, {
				moduleFallback: this.moduleFallback,
				source: this.source,
			});
		} catch (e) {
			this.previewEl.createSpan({
				cls: "xc-err",
				text: `解析失败：${(e as Error).message}`,
			});
			return;
		}
		this.lastResult = res;

		this.previewEl.createEl("div", {
			cls: "xc-import-stat",
			text: `将生成 ${res.notes.length} 篇笔记 · 共 ${res.total} 题`,
		});
		if (res.total > 0) {
			const list = this.previewEl.createEl("div", { cls: "xc-import-modules" });
			for (const [m, n] of Object.entries(res.byModule).sort((a, b) => b[1] - a[1])) {
				list.createSpan({ cls: "xc-tag", text: `${m} ${n}` });
			}
		}
		for (const w of res.warnings) {
			this.previewEl.createDiv({ cls: "xc-warn", text: w });
		}
	}

	private async doImport(): Promise<void> {
		if (!this.text.trim()) {
			new Notice("请先选择文件或粘贴内容");
			return;
		}
		let res = this.lastResult;
		if (!res) {
			try {
				res = convertInput(this.text, this.filename, {
					moduleFallback: this.moduleFallback,
					source: this.source,
				});
			} catch (e) {
				new Notice(`解析失败：${(e as Error).message}`);
				return;
			}
		}
		if (!res.notes.length) {
			new Notice("没有可导入的题目（请检查是否缺少「题干」列）");
			return;
		}

		const rootFolder = this.plugin.store.data.settings.rootFolder;
		const written = await importToVault(this.app, rootFolder, res.notes);
		if (written.errors.length) {
			console.error("导入写入错误：", written.errors);
		}

		// 写入后重建索引，使新题立即可被刷到
		await this.plugin.rebuild();

		const skipped = written.skipped
			? `（跳过已存在 ${written.skipped} 篇）`
			: "";
		new Notice(
			`已导入 ${written.created} 篇笔记 / ${res.total} 题${skipped}，索引已重建`,
			6000
		);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
