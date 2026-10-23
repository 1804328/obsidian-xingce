import { ItemView, WorkspaceLeaf } from "obsidian";
import type XingcePlugin from "../main";

export const VIEW_TYPE_STATS = "xingce-stats-view";

/** 简单的天数格式化：今天 / 昨天 / M-D */
function dayLabel(ts: number, idxFromToday: number): string {
	if (idxFromToday === 0) return "今天";
	if (idxFromToday === 1) return "昨天";
	const d = new Date(ts);
	return `${d.getMonth() + 1}-${d.getDate()}`;
}

function pct(n: number, d: number): number {
	return d ? Math.round((n / d) * 100) : 0;
}

export class StatsView extends ItemView {
	private plugin: XingcePlugin;

	constructor(leaf: WorkspaceLeaf, plugin: XingcePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_STATS;
	}
	getDisplayText(): string {
		return "刷题数据";
	}
	getIcon(): string {
		return "bar-chart";
	}

	async onOpen(): Promise<void> {
		await this.plugin.ensureBank();
		this.render();
	}

	private render(): void {
		const el = this.contentEl;
		el.empty();
		el.addClass("xc-root");

		const head = el.createDiv({ cls: "xc-head" });
		head.createDiv({ cls: "xc-title", text: "刷题数据" });
		const refresh = head.createEl("button", {
			cls: "xc-btn xc-btn-ghost",
			text: "刷新",
		});
		refresh.onclick = () => this.render();

		const store = this.plugin.store;
		const history = store.data.history;
		const total = history.length;
		const correct = history.filter((h) => h.correct).length;
		const wrongCount = store.wrongList().length;

		// qid -> module 映射，用于按模块聚合
		const qidModule = new Map<string, string>();
		for (const e of this.plugin.bank.all()) qidModule.set(e.qid, e.module);

		const modAgg = new Map<string, { count: number; ok: number }>();
		for (const h of history) {
			const m = qidModule.get(h.qid) ?? "未归类";
			const a = modAgg.get(m) ?? { count: 0, ok: 0 };
			a.count++;
			if (h.correct) a.ok++;
			modAgg.set(m, a);
		}

		// 近 7 天趋势
		const days: { ts: number; label: string; count: number; ok: number }[] = [];
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		for (let i = 6; i >= 0; i--) {
			const ts = now.getTime() - i * 86400000;
			days.push({ ts, label: dayLabel(ts, i), count: 0, ok: 0 });
		}
		const dayKey = days.map((d) => {
			const dt = new Date(d.ts);
			return `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
		});
		for (const h of history) {
			const dt = new Date(h.at);
			const key = `${dt.getFullYear()}-${dt.getMonth()}-${dt.getDate()}`;
			const idx = dayKey.indexOf(key);
			if (idx >= 0) {
				days[idx].count++;
				if (h.correct) days[idx].ok++;
			}
		}

		// ---- 概览卡片 ----
		const overview = el.createDiv({ cls: "xc-stats-overview" });
		this.card(overview, "累计答题", String(total), total ? `正确率 ${pct(correct, total)}%` : "暂无记录");
		this.card(overview, "累计正确", String(correct), `占比 ${pct(correct, total)}%`);
		this.card(overview, "当前错题", String(wrongCount), wrongCount ? "待攻克" : "全清啦 🎉");

		// ---- 模块强弱 ----
		const secMod = el.createDiv({ cls: "xc-stats-section" });
		secMod.createDiv({ cls: "xc-stats-h", text: "模块正确率" });
		if (!modAgg.size) {
			secMod.createDiv({ cls: "xc-empty", text: "还没有作答记录，去刷几题就有了。" });
		} else {
			const rows = [...modAgg.entries()].sort(
				(a, b) => pct(b[1].ok, b[1].count) - pct(a[1].ok, a[1].count)
			);
			const maxCount = Math.max(...rows.map((r) => r[1].count));
			for (const [m, a] of rows) {
				const r = pct(a.ok, a.count);
				const row = secMod.createDiv({ cls: "xc-stat-row" });
				row.createSpan({ cls: "xc-stat-name", text: m });
				const barWrap = row.createDiv({ cls: "xc-stat-bar" });
				const bar = barWrap.createDiv({ cls: "xc-stat-bar-fill" });
				bar.style.width = `${(a.count / maxCount) * 100}%`;
				bar.addClass(r >= 70 ? "is-good" : r >= 50 ? "is-mid" : "is-bad");
				row.createSpan({
					cls: "xc-stat-val",
					text: `${r}% · ${a.count}题`,
				});
			}
			secMod.createDiv({
				cls: "xc-hint",
				text: "绿=稳（≥70%）· 黄=将就（50–69%）· 红=薄弱（<50%），优先刷红的。",
			});
		}

		// ---- 近 7 天趋势 ----
		const secTrend = el.createDiv({ cls: "xc-stats-section" });
		secTrend.createDiv({ cls: "xc-stats-h", text: "近 7 天正确率" });
		const chart = secTrend.createDiv({ cls: "xc-trend" });
		const maxTrend = Math.max(1, ...days.map((d) => d.count));
		for (const d of days) {
			const col = chart.createDiv({ cls: "xc-trend-col" });
			const r = pct(d.ok, d.count);
			const bar = col.createDiv({ cls: "xc-trend-bar" });
			bar.style.height = `${(d.count / maxTrend) * 100}%`;
			bar.addClass(
				d.count === 0 ? "is-empty" : r >= 70 ? "is-good" : r >= 50 ? "is-mid" : "is-bad"
			);
			col.createSpan({ cls: "xc-trend-rate", text: d.count ? `${r}%` : "—" });
			col.createSpan({ cls: "xc-trend-label", text: d.label });
		}

		el.createDiv({
			cls: "xc-hint xc-stats-foot",
			text: "数据只存在你本机（插件的 data.json），不会上传。",
		});
	}

	private card(parent: HTMLElement, title: string, value: string, sub: string): void {
		const c = parent.createDiv({ cls: "xc-stat-card" });
		c.createDiv({ cls: "xc-stat-card-v", text: value });
		c.createDiv({ cls: "xc-stat-card-t", text: title });
		c.createDiv({ cls: "xc-stat-card-s", text: sub });
	}
}
