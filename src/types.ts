export interface Option {
	key: string;
	text: string;
}

export interface Question {
	/**
	 * 原始题库 id。注意它在全库中并非唯一：
	 * 联考卷共用题目，同一道题会出现在多套卷里（最多 27 次）。
	 * 因此它只用作错题本的语义主键，会话内不要用。
	 */
	qid: string;
	/** 会话内唯一标识：文件 + 材料号 + 题号 */
	uid: string;
	module: string;
	exam: string;
	region: string;
	year: string;
	/** 考点标签，取自标题 <sub> 片段 */
	point: string;
	index: number;
	/** 题干原文，可能包含 HTML 片段与 <img> 引用 */
	stem: string;
	options: Option[];
	/** 官方答案原文，单选为 A-D，多选可能为组合，缺失时为「（缺）」等 */
	answer: string;
	/** 从选项 ✅ 标记推导出的正确选项键 */
	correctKeys: string[];
	explanation: string;
	file: string;
	/** 资料分析题所属材料正文，其余模块为空 */
	material: string;
	materialIndex: number;
}

export interface ExamMeta {
	exam: string;
	region: string;
	year: string;
	modules: string[];
	total: number;
}

export type PracticeMode = "random" | "point" | "exam" | "wrong" | "favorite";

export interface FilterState {
	modules: string[];
	points: string[];
	years: string[];
	regions: string[];
	/** 仅抽取带图形的题目 */
	onlyWithImage: boolean;
	/** 排除答案为「（缺）」等残缺题目 */
	excludeIncomplete: boolean;
}

export interface WrongRecord {
	qid: string;
	/** 累计答错次数 */
	count: number;
	/**
	 * 当前连续答对次数。
	 * 达到 settings.masterStreak 时自动移出错题本，答错则清零。
	 */
	streak: number;
	lastAt: number;
	lastChoice: string[];
}

export interface PluginData {
	wrong: Record<string, WrongRecord>;
	favorite: string[];
	history: { qid: string; correct: boolean; at: number }[];
	settings: {
		rootFolder: string;
		feedbackMode: "immediate" | "after";
		examMinutes: number;
		/**
		 * 连续答对多少次后自动移出错题本。
		 * 0 表示永不自动移除，只能手动删除。
		 */
		masterStreak: number;
		/** 智能模式：抽题优先推送薄弱模块与个人易错题；关闭则均匀随机 */
		smartMode: boolean;
	};
}
