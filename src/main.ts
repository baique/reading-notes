import { App, FuzzySuggestModal, Modal, Notice, Plugin, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { runAnswer } from './run';
import { fetchPageTitle } from './page-title';
import { ReadingView, VIEW_TYPE_READING } from './reading-view';
import { DEFAULT_SETTINGS, ReadingSettingTab, type ReadingSettings } from './settings';
import { READING_EXT, Store, type ReadingEntry } from './store';

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

function dayKey(d: Date = new Date()): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function stamp(d: Date = new Date()): string {
	return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 新建与编辑共用：标题 + 链接，链接粘完自动识别网页标题 */
class ReadingMetaModal extends Modal {
	constructor(
		app: App,
		private initial: { title: string; url: string },
		private heading: string,
		private confirmText: string,
		private onSubmit: (title: string, url: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.heading });

		const urlLabel = contentEl.createEl('label', { cls: 'rn-field-label', text: '链接' });
		urlLabel.setAttribute('for', 'rn-meta-url');
		const url = contentEl.createEl('input', {
			cls: 'rn-field',
			attr: { id: 'rn-meta-url', type: 'text', placeholder: 'https://' },
		});
		url.value = this.initial.url;

		const titleLabel = contentEl.createEl('label', { cls: 'rn-field-label', text: '标题' });
		titleLabel.setAttribute('for', 'rn-meta-title');
		const title = contentEl.createEl('input', {
			cls: 'rn-field',
			attr: { id: 'rn-meta-title', type: 'text', placeholder: '留空就按网页标题填' },
		});
		title.value = this.initial.title;

		const hint = contentEl.createDiv({ cls: 'rn-field-hint' });

		// 粘完链接自动去抓网页标题，只在标题还空着时填，不覆盖手打的
		let timer = 0;
		let seq = 0;
		const autoFill = (): void => {
			const target = url.value.trim();
			if (!target) return;
			const ticket = ++seq;
			hint.setText('识别标题中…');
			void fetchPageTitle(target).then((fetched) => {
				if (ticket !== seq) return;
				hint.setText(fetched ? '' : '没抓到标题，手动填一下');
				if (fetched && !title.value.trim()) title.value = fetched;
			});
		};
		if (!this.initial.title.trim() && this.initial.url.trim()) autoFill();
		url.addEventListener('input', () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(autoFill, 500);
		});
		url.addEventListener('blur', autoFill);

		const submit = (): void => {
			if (!title.value.trim() || !url.value.trim()) return;
			const value = { title: title.value, url: url.value };
			this.close();
			this.onSubmit(value.title, value.url);
		};

		for (const input of [title, url]) {
			input.addEventListener('keydown', (event) => {
				event.stopPropagation();
				if (event.key !== 'Enter') return;
				// 链接后直接回车：先把标题补上，再回车才提交
				if (input === url && !title.value.trim()) {
					autoFill();
					return;
				}
				submit();
			});
		}

		const row = contentEl.createDiv({ cls: 'rn-modal__actions' });
		row.createEl('button', { cls: 'mod-cta', text: this.confirmText, attr: { type: 'button' } }).addEventListener('click', submit);
		window.setTimeout(() => (this.initial.title.trim() ? url : title).focus(), 60);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ReadingPicker extends FuzzySuggestModal<ReadingEntry> {
	constructor(app: App, private entries: ReadingEntry[], private onPick: (entry: ReadingEntry) => void) {
		super(app);
		this.setPlaceholder('选择在读内容');
	}

	getItems(): ReadingEntry[] {
		return this.entries;
	}

	getItemText(entry: ReadingEntry): string {
		return entry.data.title;
	}

	onChooseItem(entry: ReadingEntry): void {
		this.onPick(entry);
	}
}

const MAX_AUTO_TRIES = 3;

export default class ReadingNotesPlugin extends Plugin {
	settings: ReadingSettings = DEFAULT_SETTINGS;
	store!: Store;
	private answering = false;
	/** 正在查的问题 id，界面据此显示「查询中」 */
	private inflight = new Set<string>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.store = new Store(this.app);

		this.registerView(VIEW_TYPE_READING, (leaf) => new ReadingView(leaf, this));
		// 双击 .read 文件就用阅读视图打开
		this.registerExtensions([READING_EXT], VIEW_TYPE_READING);

		this.addCommand({ id: 'new-reading', name: '新建在读（标题 + 链接）', callback: () => this.promptNewReading() });
		this.addCommand({ id: 'open-reading', name: '打开在读内容', callback: () => void this.promptPickReading() });
		this.addCommand({ id: 'answer-pending', name: '立即补齐待答问题', callback: () => void this.runAnswering(true) });

		// 文件夹右键就能新建，放哪个目录由你决定
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFolder)) return;
				const dir = file.path === '/' ? '' : file.path;
				menu.addItem((item) =>
					item
						.setTitle('新建阅读')
						.setIcon('book-open')
						.onClick(() => this.promptNewReading(dir)),
				);
			}),
		);

		this.addSettingTab(new ReadingSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			// 启动后和每 5 分钟各扫一次待答问题，静默写回
			window.setTimeout(() => void this.runAnswering(false), 8000);
			this.registerInterval(window.setInterval(() => void this.runAnswering(false), 5 * 60 * 1000));
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/** 拖动分隔条时只改内存里的比例，落盘在松手后 */
	applyLayout(layout: { top: number; questions: number }): void {
		this.settings.layout = layout;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_READING)) {
			const view = leaf.view;
			if (view instanceof ReadingView) view.layoutChanged();
		}
	}

	async saveLayout(): Promise<void> {
		await this.saveSettings();
	}

	/** 笔记/答案的时间戳，形如 02-14 15:03 */
	stamp(d: Date = new Date()): string {
		return stamp(d);
	}

	async silentAnswer(): Promise<void> {
		await this.runAnswering(false);
	}

	/** 不传目录就跟着当前文件走，没有就放库根 */
	private dirFromActive(): string {
		const parent = this.app.workspace.getActiveFile()?.parent?.path;
		return parent && parent !== '/' ? parent : '';
	}

	promptNewReading(dir = this.dirFromActive()): void {
		new ReadingMetaModal(this.app, { title: '', url: '' }, '新建在读', '开始读', (title, url) => void this.createReading(dir, title, url)).open();
	}

	promptEditMeta(path: string, title: string, url: string): void {
		if (!path) return;
		new ReadingMetaModal(this.app, { title, url }, '编辑在读', '保存', async (nextTitle, nextUrl) => {
			await this.store.setMeta(path, nextTitle, nextUrl);
			this.refreshReadingViews();
			new Notice('已保存');
		}).open();
	}

	async promptPickReading(): Promise<void> {
		const entries = await this.store.list();
		if (entries.length === 0) {
			this.promptNewReading();
			return;
		}
		new ReadingPicker(this.app, entries, (entry) => void this.openReading(entry.file)).open();
	}

	private async createReading(dir: string, title: string, url: string): Promise<void> {
		const file = await this.store.create(dir, title, url, dayKey());
		await this.openReading(file);
	}

	async openReading(file: TFile): Promise<void> {
		const leaf: WorkspaceLeaf = this.app.workspace.getLeaf('tab');
		await leaf.openFile(file);
		await this.app.workspace.revealLeaf(leaf);
	}


	private async runAnswering(manual: boolean): Promise<void> {
		if (this.answering) return;
		if (!this.settings.aiEnabled) {
			if (manual) new Notice('后台查询已关闭，设置里可以打开');
			return;
		}
		this.answering = true;
		let done = 0;
		let failed = 0;
		try {
			const pending = await this.store.pending();
			// 自动轮询最多试 3 次，手动触发则无条件再试
			const queue = pending.filter((item) => manual || item.question.tries < MAX_AUTO_TRIES);
			if (manual) new Notice(`待查 ${queue.length} 条`);
			for (const item of queue) {
				const ok = await this.answerOne(item.path, item.question.id);
				if (ok) done += 1;
				else failed += 1;
			}
		} finally {
			this.answering = false;
		}
		if (manual) new Notice(failed ? `已补 ${done} 条，${failed} 条失败` : `已补 ${done} 条 AI 解答`);
	}

	isInflight(id: string): boolean {
		return this.inflight.has(id);
	}

	/** 查一条：成功写回答案，失败记下原因，两种都把状态刷到界面上 */
	async answerOne(path: string, id: string): Promise<boolean> {
		const data = await this.store.read(path);
		const question = data?.questions.find((item) => item.id === id);
		if (!data || !question || this.inflight.has(id)) return false;

		this.inflight.add(id);
		this.refreshReadingViews();
		try {
			const answer = await runAnswer(
				{
					command: this.settings.aiCommand,
					template: this.settings.aiTemplate,
					timeoutMs: this.settings.aiTimeoutMs,
					cwd: (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '',
				},
				{
					link: data.url,
					title: data.title,
					question: question.text,
					notes: data.notes.slice(0, 2000),
				},
			);
			await this.store.setAnswer(path, id, answer, stamp());
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await this.store.recordFailure(path, id, message.replace(/^Error:\s*/, ''));
			console.error('[reading-notes] 查答案失败：', question.text, error);
			return false;
		} finally {
			this.inflight.delete(id);
			this.refreshReadingViews();
		}
	}

	async answerFollowUp(path: string, questionId: string, followUpId: string): Promise<void> {
		const data = await this.store.read(path);
		const question = data?.questions.find((item) => item.id === questionId);
		const followUp = question?.followUps.find((item) => item.id === followUpId);
		if (!data || !question || !followUp || followUp.answer) return;
		try {
			const answer = await runAnswer(
				{ command: this.settings.aiCommand, template: this.settings.aiTemplate, timeoutMs: this.settings.aiTimeoutMs, cwd: (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '' },
				{ link: data.url, title: data.title, question: `${question.text}\n\n原 AI 解答：${question.answer}\n\n追问：${followUp.question}`, notes: data.notes.slice(0, 2000) },
			);
			await this.store.setFollowUpAnswer(path, questionId, followUpId, answer, stamp());
		} catch (error) {
			await this.store.recordFollowUpFailure(path, questionId, followUpId, error instanceof Error ? error.message : String(error));
		} finally {
			this.refreshReadingViews();
		}
	}

	private refreshReadingViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_READING)) {
			const view = leaf.view;
			if (view instanceof ReadingView) void view.refreshAnswers();
		}
	}
}
