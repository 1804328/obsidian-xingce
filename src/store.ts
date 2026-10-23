import type { Plugin } from "obsidian";
import type { PluginData } from "./types";

export const DEFAULT_DATA: PluginData = {
	wrong: {},
	favorite: [],
	history: [],
	settings: {
		rootFolder: "",
		feedbackMode: "immediate",
		examMinutes: 120,
		/**
		 * 默认「连续答对 2 次」移出错题本：
		 * 答对一次可能只是蒙对或刚看过解析，连续两次才说明真会了。
		 */
		masterStreak: 2,
		/** 默认开启智能模式：优先推送薄弱模块 */
		smartMode: true,
	},
};

const MAX_HISTORY = 2000;

/** 记录一次作答后，错题本发生的变化 */
export interface RecordResult {
	/** 本次是否因连续答对达标而被移出错题本 */
	removed: boolean;
	/** 移出前的连续答对次数 */
	streak: number;
}

export class Store {
	data: PluginData = structuredClone(DEFAULT_DATA);

	constructor(private plugin: Plugin) {}

	async load(): Promise<void> {
		const loaded = await this.plugin.loadData();
		this.data = {
			...structuredClone(DEFAULT_DATA),
			...(loaded ?? {}),
			settings: { ...DEFAULT_DATA.settings, ...(loaded?.settings ?? {}) },
		};
		this.data.wrong ??= {};
		this.data.favorite ??= [];
		this.data.history ??= [];
		// 兼容旧版本数据：早期记录没有 streak 字段
		for (const rec of Object.values(this.data.wrong)) {
			if (typeof rec.streak !== "number") rec.streak = 0;
		}
	}

	async save(): Promise<void> {
		if (this.data.history.length > MAX_HISTORY)
			this.data.history = this.data.history.slice(-MAX_HISTORY);
		await this.plugin.saveData(this.data);
	}

	/**
	 * 记录一次作答。
	 * 答错：累计次数 +1，连续答对清零；
	 * 答对：连续答对 +1，达到设定阈值后自动移出错题本。
	 */
	recordAnswer(qid: string, correct: boolean, choice: string[]): RecordResult {
		this.data.history.push({ qid, correct, at: Date.now() });
		const need = this.masterStreak();
		const rec = this.data.wrong[qid];

		if (!correct) {
			if (rec) {
				rec.count++;
				rec.streak = 0;
				rec.lastAt = Date.now();
				rec.lastChoice = choice;
			} else {
				this.data.wrong[qid] = {
					qid,
					count: 1,
					streak: 0,
					lastAt: Date.now(),
					lastChoice: choice,
				};
			}
			return { removed: false, streak: 0 };
		}

		// 答对：只在它确实是错题时才有意义
		if (!rec) return { removed: false, streak: 0 };
		rec.streak = (rec.streak ?? 0) + 1;
		rec.lastAt = Date.now();
		rec.lastChoice = choice;
		if (need > 0 && rec.streak >= need) {
			delete this.data.wrong[qid];
			return { removed: true, streak: rec.streak };
		}
		return { removed: false, streak: rec.streak };
	}

	/** 连续答对多少次移出错题本，0 = 永不自动移除 */
	masterStreak(): number {
		const n = Number(this.data.settings.masterStreak);
		if (!Number.isFinite(n) || n < 0) return 2;
		return Math.floor(n);
	}

	isFavorite(qid: string): boolean {
		return this.data.favorite.includes(qid);
	}

	async toggleFavorite(qid: string): Promise<boolean> {
		const i = this.data.favorite.indexOf(qid);
		if (i >= 0) this.data.favorite.splice(i, 1);
		else this.data.favorite.push(qid);
		await this.save();
		return i < 0;
	}

	removeWrong(qid: string): void {
		delete this.data.wrong[qid];
	}

	wrongList(): string[] {
		return Object.keys(this.data.wrong);
	}

	async clearWrong(): Promise<void> {
		this.data.wrong = {};
		await this.save();
	}

	async clearHistory(): Promise<void> {
		this.data.history = [];
		await this.save();
	}
}
