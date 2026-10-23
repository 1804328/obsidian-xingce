import type { IndexEntry } from "./bank";
import type { PluginData } from "./types";

export interface ModuleAccuracy {
	module: string;
	total: number;
	correct: number;
	/** 正确率 0..1，无样本时记 1（视为已掌握，不加权） */
	acc: number;
}

export interface WeaknessOptions {
	/** 是否启用智能加权；false 时整体退化为均匀随机 */
	smart: boolean;
	/** 模块加成系数：权重 += boost * (1 - 正确率) */
	boost: number;
	/** 个人每答错一次的额外加成（按 qid 维度） */
	perWrongBoost: number;
	/** 单题权重上限，防止极端值 */
	maxWeight: number;
	/** 判定「薄弱模块」所需最小样本量，样本不足不进入排序 */
	minSample: number;
}

export const DEFAULT_WEAKNESS: WeaknessOptions = {
	smart: true,
	boost: 1.6,
	perWrongBoost: 0.5,
	maxWeight: 8,
	minSample: 3,
};

export interface Weakness {
	/** 给定 qid 返回抽取权重（>=0.05） */
	weightOf: (qid: string) => number;
	/** 按薄弱度升序排列的模块名（正确率低者在前），仅含样本足够的 */
	weakModules: string[];
	/** 每个模块的正确率统计 */
	modules: ModuleAccuracy[];
	/** 是否存在可用作答历史（决定智能模式是否真的「智能」） */
	hasData: boolean;
}

interface Agg {
	total: number;
	correct: number;
}

/**
 * 基于作答历史计算抽题权重——复制粉笔「测学练考」里「练」的核心：
 * 把用户真正掌握得差的模块、以及个人反复答错的题，权重调高。
 *
 * - 模块维度：正确率越低，权重越高（boost * (1 - acc)）。
 * - 个人维度：同一道题历史答错次数越多，权重越高（perWrongBoost * 错次）。
 * - 无历史 / 关闭智能：全部权重为 1，等价于均匀随机，不会让新人一直刷同一批题。
 */
export function buildWeakness(
	entries: IndexEntry[],
	history: PluginData["history"],
	opts: Partial<WeaknessOptions> = {}
): Weakness {
	const o = { ...DEFAULT_WEAKNESS, ...opts };

	// qid -> 模块：同一题跨卷重复，只记一个模块
	const qidModule = new Map<string, string>();
	for (const e of entries) qidModule.set(e.qid, e.module);

	// qid -> 个人作答聚合
	const byQid = new Map<string, Agg>();
	for (const h of history) {
		const a = byQid.get(h.qid) ?? { total: 0, correct: 0 };
		a.total++;
		if (h.correct) a.correct++;
		byQid.set(h.qid, a);
	}

	// 模块 -> 作答聚合（按 qid 去重后累加）
	const byModule = new Map<string, Agg>();
	for (const [qid, agg] of byQid) {
		const m = qidModule.get(qid);
		if (!m) continue;
		const a = byModule.get(m) ?? { total: 0, correct: 0 };
		a.total += agg.total;
		a.correct += agg.correct;
		byModule.set(m, a);
	}

	const modules: ModuleAccuracy[] = [...byModule.entries()].map(
		([module, a]) => ({
			module,
			total: a.total,
			correct: a.correct,
			acc: a.total ? a.correct / a.total : 1,
		})
	);
	const accOf = (m: string): number =>
		modules.find((x) => x.module === m)?.acc ?? 1;

	const weakModules = modules
		.filter((m) => m.total >= o.minSample)
		.sort((a, b) => a.acc - b.acc)
		.map((m) => m.module);

	const hasData = byQid.size > 0;

	// 未启用或没有历史：均匀随机
	if (!o.smart || !hasData) {
		return { weightOf: () => 1, weakModules, modules, hasData };
	}

	// 个人错次（total - correct）
	const qidWrong = new Map<string, number>();
	for (const [qid, a] of byQid) qidWrong.set(qid, a.total - a.correct);

	return {
		weightOf: (qid: string): number => {
			const m = qidModule.get(qid);
			const acc = m ? accOf(m) : 1;
			const wrong = qidWrong.get(qid) ?? 0;
			const w = 1 + o.boost * (1 - acc) + o.perWrongBoost * wrong;
			return Math.max(0.05, Math.min(o.maxWeight, w));
		},
		weakModules,
		modules,
		hasData,
	};
}
