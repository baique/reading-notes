import { App, PluginSettingTab, Setting } from 'obsidian';
import type ReadingNotesPlugin from './main';
import { DEFAULT_COMMAND, DEFAULT_TEMPLATE } from './run';

export interface ReadingSettings {
	/** 是否让 AI 在后台静默补参考答案 */
	aiEnabled: boolean;
	/** 取答案的外部命令，${prompt} 是提示词占位 */
	aiCommand: string;
	/** 提示词模板，支持 ${link} ${title} ${question} ${notes} */
	aiTemplate: string;
	/** 命令超时，毫秒 */
	aiTimeoutMs: number;
	/** 上半高度占比，以及上半里问题栏的宽度占比 */
	layout: { top: number; questions: number };
}

export const DEFAULT_SETTINGS: ReadingSettings = {
	aiEnabled: true,
	aiCommand: DEFAULT_COMMAND,
	aiTemplate: DEFAULT_TEMPLATE,
	aiTimeoutMs: 180000,
	layout: { top: 0.66, questions: 0.34 },
};

export class ReadingSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: ReadingNotesPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('自动查询 AI 解答')
			.setDesc('记下问题后自动查询；关闭后只在手动触发时查询')
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.aiEnabled).onChange(async (value) => {
					this.plugin.settings.aiEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('取答案的命令')
			.setDesc('在登录 shell 里执行，stdout 全文就是答案（按 markdown 渲染）。${prompt} 会被替换成提示词，须出现在命令里。')
			.addTextArea((area) => {
				area.inputEl.rows = 3;
				area.inputEl.addClass('rn-setting-mono');
				area.setPlaceholder(DEFAULT_COMMAND)
					.setValue(this.plugin.settings.aiCommand)
					.onChange(async (value) => {
						this.plugin.settings.aiCommand = value.trim() || DEFAULT_COMMAND;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('提示词模板')
			.setDesc('可用变量：${link} ${title} ${question} ${notes}；${prompt} 由它生成后交给命令。')
			.addTextArea((area) => {
				area.inputEl.rows = 6;
				area.setPlaceholder(DEFAULT_TEMPLATE)
					.setValue(this.plugin.settings.aiTemplate)
					.onChange(async (value) => {
						this.plugin.settings.aiTemplate = value.trim() ? value : DEFAULT_TEMPLATE;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('命令超时（毫秒）')
			.setDesc('超过这个时间就放弃这次查询，不影响别的题')
			.addText((text) =>
				text.setValue(String(this.plugin.settings.aiTimeoutMs)).onChange(async (value) => {
					const n = Number(value);
					if (!Number.isFinite(n) || n < 1000) return;
					this.plugin.settings.aiTimeoutMs = Math.floor(n);
					await this.plugin.saveSettings();
				}),
			);
	}
}
