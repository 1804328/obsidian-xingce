import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { Bank } from "./bank";
import { Store } from "./store";
import { PracticeView, VIEW_TYPE_PRACTICE } from "./views/practice-view";
import { ExamView, VIEW_TYPE_EXAM } from "./views/exam-view";
import { XingceSettingTab } from "./settings";
import type { FilterState } from "./types";

export default class XingcePlugin extends Plugin {
	bank!: Bank;
	store!: Store;

	filterState: FilterState = {
		modules: [],
		points: [],
		years: [],
		regions: [],
		onlyWithImage: false,
		excludeIncomplete: true,
	};

	drawCount = 20;

	async onload(): Promise<void> {
		this.store = new Store(this);
		await this.store.load();

		this.bank = new Bank(this.app, this.store.data.settings.rootFolder);

		this.registerView(
			VIEW_TYPE_PRACTICE,
			(leaf) => new PracticeView(leaf, this)
		);

		this.registerView(
			VIEW_TYPE_EXAM,
			(leaf) => new ExamView(leaf, this)
		);

		this.addRibbonIcon("pen-line", "行测刷题", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "xingce-open",
			name: "打开刷题面板",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "xingce-draw-10",
			name: "随机刷 10 题",
			callback: () => void this.draw(10),
		});

		this.addCommand({
			id: "xingce-draw-20",
			name: "随机刷 20 题",
			callback: () => void this.draw(20),
		});

		this.addCommand({
			id: "xingce-exam",
			name: "打开整卷模考",
			callback: () => void this.activateExamView(),
		});

		this.addCommand({
			id: "xingce-rebuild-index",
			name: "重建题库索引",
			callback: () => void this.rebuild(),
		});

		this.addSettingTab(new XingceSettingTab(this.app, this));
	}

	onunload(): void {
		// 视图由 Obsidian 统一回收
	}

	async activateView(): Promise<PracticeView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(VIEW_TYPE_PRACTICE)[0] ?? null;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf)
				await leaf.setViewState({
					type: VIEW_TYPE_PRACTICE,
					active: true,
				});
		}

		if (leaf) workspace.revealLeaf(leaf);
		return (leaf?.view as PracticeView) ?? null;
	}

	async activateExamView(): Promise<ExamView | null> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null =
			workspace.getLeavesOfType(VIEW_TYPE_EXAM)[0] ?? null;

		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf)
				await leaf.setViewState({
					type: VIEW_TYPE_EXAM,
					active: true,
				});
		}

		if (leaf) workspace.revealLeaf(leaf);
		return (leaf?.view as ExamView) ?? null;
	}

	async ensureBank(
		onProgress?: (done: number, total: number) => void
	): Promise<void> {
		if (this.bank.ready) return;
		await this.bank.load(onProgress);
	}

	async draw(n: number): Promise<void> {
		const view = await this.activateView();
		if (view) await view.quickDraw(n);
	}

	async rebuild(): Promise<void> {
		const t0 = Date.now();
		await this.bank.rebuild();
		const secs = ((Date.now() - t0) / 1000).toFixed(1);
		new Notice(`题库索引已重建 · ${this.bank.size.toLocaleString()} 题（${secs}s）`);
	}
}
