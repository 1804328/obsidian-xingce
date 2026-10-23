import { App, PluginSettingTab, Setting } from "obsidian";
import type XingcePlugin from "./main";

export class XingceSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: XingcePlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createDiv({
			cls: "xc-settings-note",
			text: "本插件不含任何题目数据，只读取你仓库里已有的真题笔记。",
		});

		new Setting(containerEl)
			.setName("题库根目录")
			.setDesc(
				"真题笔记在仓库中的文件夹路径，例如「行测真题」。留空则扫描整个仓库。"
			)
			.addText((t) =>
				t
					.setPlaceholder("留空 = 整个仓库")
					.setValue(this.plugin.store.data.settings.rootFolder)
					.onChange(async (v) => {
						const val = v.trim();
						this.plugin.store.data.settings.rootFolder = val;
						await this.plugin.store.save();
						this.plugin.bank.setRoot(val);
					})
			);

		new Setting(containerEl)
			.setName("反馈方式")
			.setDesc("作答后立即显示解析，还是一组做完再统一看。")
			.addDropdown((d) =>
				d
					.addOption("immediate", "立即反馈")
					.addOption("after", "做完再看")
					.setValue(this.plugin.store.data.settings.feedbackMode)
					.onChange(async (v) => {
						this.plugin.store.data.settings.feedbackMode = v as
							| "immediate"
							| "after";
						await this.plugin.store.save();
					})
			);

		new Setting(containerEl)
			.setName("模考时长")
			.setDesc("整卷模考的倒计时分钟数。")
			.addText((t) =>
				t
					.setValue(String(this.plugin.store.data.settings.examMinutes))
					.onChange(async (v) => {
						const n = Number.parseInt(v, 10);
						if (!Number.isNaN(n))
							this.plugin.store.data.settings.examMinutes = n;
						await this.plugin.store.save();
					})
			);

		new Setting(containerEl)
			.setName("错题本：连续答对几次移出")
			.setDesc(
				"同一道错题连续答对这么多次后，自动移出错题本。选「永不」则只能手动移除（做题页有「移出错题本」按钮）。"
			)
			.addDropdown((d) =>
				d
					.addOption("1", "答对 1 次")
					.addOption("2", "答对 2 次（推荐）")
					.addOption("3", "答对 3 次")
					.addOption("5", "答对 5 次")
					.addOption("0", "永不自动移出")
					.setValue(String(this.plugin.store.masterStreak()))
					.onChange(async (v) => {
						this.plugin.store.data.settings.masterStreak = Number.parseInt(
							v,
							10
						);
						await this.plugin.store.save();
					})
			);

		new Setting(containerEl)
			.setName("智能模式（优先薄弱模块）")
			.setDesc(
				"开启后，刷题优先推送你掌握较弱的模块和个人易错题；关闭则均匀随机。可在刷题页随时切换。"
			)
			.addToggle((t) =>
				t
					.setValue(this.plugin.store.data.settings.smartMode)
					.onChange(async (v) => {
						this.plugin.store.data.settings.smartMode = v;
						await this.plugin.store.save();
					})
			);

		new Setting(containerEl)
			.setName("重建题库索引")
			.setDesc(
				this.plugin.bank.size
					? `当前索引 ${this.plugin.bank.size.toLocaleString()} 题`
					: "尚未建立索引"
			)
			.addButton((b) =>
				b.setButtonText("重建").onClick(async () => {
					await this.plugin.rebuild();
					this.display();
				})
			);
	}
}
