import { FileView, MarkdownRenderer, Platform, Scope, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import { createNotesEditor, type NotesEditor } from './editor';
import { ASK_MAX, ASK_MIN, TOP_MAX, TOP_MIN, dragValue } from './layout';
import type ReadingNotesPlugin from './main';
import { READING_EXT, type Question, type ReadingFile } from './store';

export const VIEW_TYPE_READING = 'reading-notes-view';

interface WebviewElement extends HTMLElement {
	loadURL?: (url: string) => void;
	reload?: () => void;
}

/** Obsidian 的 BrowserWindow 开了 webviewTag 才能用 <webview>，否则只是个未知元素 */
function webviewAvailable(): boolean {
	if (!Platform.isDesktopApp) return false;
	return document.createElement('webview').constructor.name !== 'HTMLUnknownElement';
}

export class ReadingView extends FileView {
	private data: ReadingFile | null = null;
	private frameEl: HTMLElement | null = null;
	/** 真正承载网页的元素（<webview> 或 iframe），重载靠它 */
	private webEl: HTMLIFrameElement | WebviewElement | null = null;
	private listEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private panesEl: HTMLElement | null = null;
	private editor: NotesEditor | null = null;
	private saveTimer = 0;
	private committers = new Map<HTMLTextAreaElement, () => void>();
	/** 问题 id → 卡片元素，增量更新用 */
	private cards = new Map<string, HTMLElement>();
	/** 收起了参考的问题 id，重建卡片时照样收起 */
	private collapsedRefs = new Set<string>();
	private collapsedFollowUps = new Set<string>();
	private inflightFollowUps = new Set<string>();

	constructor(leaf: WorkspaceLeaf, private plugin: ReadingNotesPlugin) {
		super(leaf);
		// ⌘/Ctrl + Enter 走 Obsidian 的 scope，而不是自己监听 keydown
		const scope = this.scope ?? new Scope(this.app.scope);
		this.scope = scope;
		scope.register(['Mod'], 'Enter', (event) => {
			const active = document.activeElement;
			if (!(active instanceof HTMLTextAreaElement) || !this.contentEl.contains(active)) return true;
			const commit = this.committers.get(active);
			if (!commit) return true;
			event?.preventDefault();
			commit();
			return false;
		});
	}

	getViewType(): string {
		return VIEW_TYPE_READING;
	}

	getDisplayText(): string {
		return this.data?.title || this.file?.basename || '阅读';
	}

	getIcon(): string {
		return 'book-open';
	}

	canAcceptExtension(extension: string): boolean {
		return extension === READING_EXT;
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async onClose(): Promise<void> {
		await this.flushNotes();
		this.teardownEditor();
	}

	async onLoadFile(file: TFile): Promise<void> {
		await super.onLoadFile(file);
		await this.reload();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		await this.flushNotes();
		this.teardownEditor();
		this.data = null;
		this.committers.clear();
		this.contentEl.empty();
		await super.onUnloadFile(file);
	}

	async reload(): Promise<void> {
		if (!this.file) return;
		this.teardownEditor();
		// 旧版本留下的同名 .md 先收回 JSON
		await this.plugin.store.absorbCompanionFile(this.file.path);
		this.data = (await this.plugin.store.read(this.file.path)) ?? null;
		await this.render();
	}

	private async pull(): Promise<void> {
		if (!this.file) return;
		this.data = (await this.plugin.store.read(this.file.path)) ?? this.data;
	}

	private isEditing(): boolean {
		const active = document.activeElement;
		if (!(active instanceof HTMLElement) || !this.contentEl.contains(active)) return false;
		if (active.classList.contains('rn-input') || active.classList.contains('rn-follow__input')) return false;
		return active.classList.contains('rn-mine__input') || active.classList.contains('rn-q__edit') || active.closest('.cm-editor') !== null;
	}

	// ---------- 骨架：上 = 预览 | 问题，下 = 笔记 ----------

	private async render(): Promise<void> {
		const host = this.contentEl;
		host.empty();
		host.addClass('rn-view');
		this.frameEl = null;
		this.webEl = null;
		this.listEl = null;
		this.countEl = null;
		this.cards.clear();
		this.panesEl = null;
		this.committers.clear();

		const data = this.data;
		if (!data) {
			host.createDiv({ cls: 'rn-blank' }).createEl('p', { text: '这个文件不是有效的阅读笔记，内容应该是 JSON。' });
			return;
		}

		const bar = host.createDiv({ cls: 'rn-bar' });
		const title = bar.createEl('button', { cls: 'rn-bar__title', text: data.title, attr: { type: 'button' } });
		title.addEventListener('click', () => this.plugin.promptEditMeta(this.file?.path ?? '', data.title, data.url));
		if (data.url) bar.createEl('span', { cls: 'rn-bar__url', text: data.url });
		this.countEl = bar.createSpan({ cls: 'rn-bar__count' });
		this.updateQuestionCount(data.questions.length);
		bar.createDiv({ cls: 'rn-bar__actions' })
			.createEl('button', { cls: 'rn-plain', text: '重载', attr: { type: 'button' } })
			.addEventListener('click', () => this.reloadWeb());

		const panes = host.createDiv({ cls: 'rn-panes' });
		this.panesEl = panes;
		this.applyLayout();

		const top = panes.createDiv({ cls: 'rn-top' });
		const preview = top.createDiv({ cls: 'rn-preview' });
		const frame = preview.createDiv({ cls: 'rn-frame' });
		this.frameEl = frame;
		this.mountWeb(data.url, frame);

		this.colSplitter(top);
		this.renderQuestions(top.createDiv({ cls: 'rn-ask' }));

		this.rowSplitter(panes);
		const notes = panes.createDiv({ cls: 'rn-notes', attr: { 'data-label': 'Markdown 笔记' } });
		this.editor = createNotesEditor(notes, data.notes, (text) => this.queueNotesSave(text));
	}

	// ---------- 分隔条（指针捕获，拖过 <webview> 也不丢事件） ----------

	private colSplitter(parent: HTMLElement): void {
		const handle = parent.createDiv({ cls: 'rn-split rn-split--col', attr: { role: 'separator', 'aria-orientation': 'vertical' } });
		this.drag(handle, {
			axis: 'x',
			read: () => this.plugin.settings.layout.questions,
			// 往右拖，问题栏变窄
			write: (value) => this.plugin.applyLayout({ top: this.plugin.settings.layout.top, questions: value }),
			min: ASK_MIN,
			max: ASK_MAX,
			invert: true,
		});
	}

	private rowSplitter(parent: HTMLElement): void {
		const handle = parent.createDiv({ cls: 'rn-split rn-split--row', attr: { role: 'separator', 'aria-orientation': 'horizontal' } });
		this.drag(handle, {
			axis: 'y',
			read: () => this.plugin.settings.layout.top,
			// 往下拖，上半变高
			write: (value) => this.plugin.applyLayout({ top: value, questions: this.plugin.settings.layout.questions }),
			min: TOP_MIN,
			max: TOP_MAX,
			invert: false,
		});
	}

	private drag(
		handle: HTMLElement,
		config: {
			axis: 'x' | 'y';
			/** 每次都从当前值起算，避免用渲染时的旧比例 */
			read: () => number;
			write: (value: number) => void;
			min: number;
			max: number;
			invert: boolean;
		},
	): void {
		handle.addEventListener('pointerdown', (event) => {
			event.preventDefault();
			const box = handle.parentElement;
			if (!box) return;
			const origin = config.axis === 'x' ? event.clientX : event.clientY;
			const total = (config.axis === 'x' ? box.clientWidth : box.clientHeight) || 1;
			const base = config.read();
			const id = event.pointerId;

			handle.setPointerCapture(id);
			handle.addClass('is-dragging');
			this.contentEl.addClass('is-resizing');
			document.body.style.userSelect = 'none';

			// 每帧只落一次布局，指针事件追不上重排时就丢中间帧
			let frame = 0;
			let pending: PointerEvent | null = null;
			const apply = (): void => {
				frame = 0;
				const latest = pending;
				pending = null;
				if (!latest) return;
				const current = config.axis === 'x' ? latest.clientX : latest.clientY;
				const step = (current - origin) / total;
				config.write(dragValue(base, step, config.invert, config.min, config.max));
			};
			const move = (moveEvent: PointerEvent): void => {
				if (moveEvent.pointerId !== id) return;
				// getCoalescedEvents：一次抬手前可能有多个点，取最后一个最新的
				const events = typeof moveEvent.getCoalescedEvents === 'function' ? moveEvent.getCoalescedEvents() : [];
				pending = events.length > 0 ? (events[events.length - 1] ?? moveEvent) : moveEvent;
				if (frame === 0) frame = window.requestAnimationFrame(apply);
			};
			const end = (): void => {
				if (frame) window.cancelAnimationFrame(frame);
				frame = 0;
				pending = null;
				handle.removeClass('is-dragging');
				this.contentEl.removeClass('is-resizing');
				document.body.style.userSelect = '';
				handle.removeEventListener('pointermove', move);
				handle.removeEventListener('pointerup', end);
				handle.removeEventListener('pointercancel', end);
				if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
				void this.plugin.saveLayout();
			};

			handle.addEventListener('pointermove', move);
			handle.addEventListener('pointerup', end);
			handle.addEventListener('pointercancel', end);
		});
	}

	applyLayout(): void {
		const panes = this.panesEl;
		if (!panes) return;
		const { top, questions } = this.plugin.settings.layout;
		panes.style.setProperty('--rn-top', `${top * 100}%`);
		panes.style.setProperty('--rn-ask', `${questions * 100}%`);
	}

	layoutChanged(): void {
		this.applyLayout();
	}

	/** 重载 = 回到文件里记的那个地址，而不是当前停留页 */
	private reloadWeb(): void {
		const url = this.data?.url;
		const element = this.webEl as WebviewElement | null;
		if (!url || !element) return;
		if (typeof element.loadURL === 'function') {
			element.loadURL(url);
			return;
		}
		// iframe：同地址赋值不触发导航，先断开再设回来
		const frame = element as HTMLIFrameElement;
		frame.src = 'about:blank';
		frame.src = url;
	}

	private mountWeb(url: string, host: HTMLElement): void {
		if (!url) {
			host.createDiv({ cls: 'rn-blank' }).createEl('p', { text: '还没填链接。点标题可以补上。' });
			return;
		}
		if (!webviewAvailable()) {
			host.createDiv({ cls: 'rn-blank' }).createEl('p', { text: '当前环境不支持内嵌网页，退回 iframe，部分站点会拒绝显示。' });
			this.webEl = host.createEl('iframe', { cls: 'rn-iframe', attr: { src: url, referrerpolicy: 'no-referrer' } });
			return;
		}
		const webview = document.createElement('webview');
		webview.setAttribute('src', url);
		webview.setAttribute('allowpopups', '');
		webview.addClass('rn-webview');
		host.appendChild(webview);
		this.webEl = webview;
	}

	// ---------- 笔记 ----------

	private queueNotesSave(text: string): void {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flushNotes(text), 600);
	}

	private async flushNotes(text?: string): Promise<void> {
		window.clearTimeout(this.saveTimer);
		const path = this.file?.path;
		const value = text ?? this.editor?.getValue();
		if (!path || value === undefined || value === this.data?.notes) return;
		if (this.data) this.data.notes = value;
		await this.plugin.store.setNotes(path, value);
	}

	private teardownEditor(): void {
		window.clearTimeout(this.saveTimer);
		this.editor?.destroy();
		this.editor = null;
	}

	// ---------- 问题 ----------

	private renderQuestions(col: HTMLElement): void {
		const capture = col.createDiv({ cls: 'rn-capture' });
		const input = col.ownerDocument.createElement('textarea');
		input.className = 'rn-input';
		input.rows = 1;
		input.placeholder = '哪里没看懂？记一句，AI 解答会自动查询';
		capture.appendChild(input);
		this.autosize(input);
		window.requestAnimationFrame(() => this.autosize(input));
		input.addEventListener('input', () => this.autosize(input));

		const commit = (): void => {
			const value = input.value;
			if (!value.trim() || !this.file) return;
			input.value = '';
			this.autosize(input);
			void this.plugin.store.addQuestion(this.file.path, value).then(async () => {
				await this.pull();
				const question = this.data?.questions[0];
				if (question && this.plugin.settings.aiEnabled && this.file) {
					void this.plugin.answerOne(this.file.path, question.id);
					return;
				}
				this.syncQuestions();
			});
		};
		capture.createEl('button', { cls: 'rn-plain rn-plain--right', text: '记下', attr: { type: 'button' } }).addEventListener('click', commit);
		this.committers.set(input, commit);

		this.listEl = col.createDiv({ cls: 'rn-scroll' });
		this.syncQuestions();
	}

	/** 只增删改变化的那几张卡，不重建整个列表（滚动位置和正在输入的框都保住） */
	private syncQuestions(): void {
		const list = this.listEl;
		if (!list) return;
		const questions = this.data?.questions ?? [];
		this.updateQuestionCount(questions.length);

		if (questions.length === 0) {
			for (const card of this.cards.values()) card.remove();
			this.cards.clear();
			if (!list.querySelector('.rn-blank')) {
				list.createDiv({ cls: 'rn-blank' }).createEl('p', { text: '还没有问题。' });
			}
			return;
		}
		const blank = list.querySelector('.rn-blank');
		if (blank) blank.remove();

		const alive = new Set<string>();
		for (const question of questions) {
			alive.add(question.id);
			const card = this.cards.get(question.id);
			const signature = [
				question.text,
				question.answer,
				question.answerAt,
				question.error,
				String(question.tries),
				JSON.stringify(question.followUps),
				JSON.stringify([...this.inflightFollowUps]),
				this.plugin.isInflight(question.id) ? 'busy' : 'idle',
			].join('|');
			if (card && card.dataset.sig === signature) continue;
			const next = this.createCard(question);
			next.dataset.sig = signature;
			if (card) card.replaceWith(next);
			else list.appendChild(next);
			this.cards.set(question.id, next);
		}
		for (const [id, card] of [...this.cards]) {
			if (alive.has(id)) continue;
			card.remove();
			this.cards.delete(id);
		}
		// 顺序对齐（新问题在最前，删除后也不错位）
		questions.forEach((question, index) => {
			const card = this.cards.get(question.id);
			if (!card) return;
			if (list.children[index] !== card) list.insertBefore(card, list.children[index] ?? null);
		});
	}

	private createCard(question: Question): HTMLElement {
		const item = createEl('div', { cls: 'rn-q' });

		const head = item.createDiv({ cls: 'rn-q__head' });
		const actions = head.createDiv({ cls: 'rn-q__actions' });
		const edit = actions.createEl('button', { cls: 'rn-q__action', text: '编辑', attr: { type: 'button' } });
		edit.addEventListener('click', () => this.editQuestion(head, question));
		const remove = actions.createEl('button', { cls: 'rn-q__action rn-q__action--danger', text: '删除', attr: { type: 'button' } });
		remove.addEventListener('click', () => this.removeQuestion(question, remove));
		head.createDiv({ cls: 'rn-q__text', text: question.text });

		if (!question.answer) this.renderQuestionStatus(head, question);

		if (question.answer) {
			const collapsed = this.collapsedRefs.has(question.id);
			const ref = item.createDiv({ cls: 'rn-ref' });
			ref.toggleClass('is-collapsed', collapsed);

			const toggle = ref.createEl('button', {
				cls: 'rn-ref__toggle',
				attr: { type: 'button', 'aria-expanded': String(!collapsed), title: '展开或收起 AI 解答' },
			});
			const chevron = toggle.createSpan({ cls: 'rn-ref__chevron' });
			setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
			toggle.createSpan({ cls: 'rn-ref__label', text: 'AI 解答' });

			const body = ref.createDiv({ cls: 'rn-ref__body' });
			void MarkdownRenderer.render(this.app, question.answer, body, this.file?.path ?? '', this.plugin);

			toggle.addEventListener('click', () => {
				const next = !this.collapsedRefs.has(question.id);
				if (next) this.collapsedRefs.add(question.id);
				else this.collapsedRefs.delete(question.id);
				ref.toggleClass('is-collapsed', next);
				toggle.setAttribute('aria-expanded', String(!next));
				setIcon(chevron, next ? 'chevron-right' : 'chevron-down');
			});
		}

		const follow = item.createDiv({ cls: 'rn-follow' });

		for (const followUp of question.followUps) {
			const row = follow.createDiv({ cls: 'rn-follow__item' });
			const followHead = row.createDiv({ cls: 'rn-q__head' });
			const followActions = followHead.createDiv({ cls: 'rn-q__actions' });
			const removeFollow = followActions.createEl('button', { cls: 'rn-q__action rn-q__action--danger', text: '删除', attr: { type: 'button' } });
			removeFollow.addEventListener('click', () => this.removeFollowUp(question, followUp, removeFollow));
			followHead.createDiv({ cls: 'rn-q__text', text: followUp.question });
			if (!followUp.answer) {
				const busy = this.inflightFollowUps.has(followUp.id);
				const status = followHead.createDiv({ cls: 'rn-q__status' });
				status.createSpan({ cls: busy || !followUp.error ? 'rn-q__waiting' : 'rn-q__error', text: busy ? '正在由 AI 解答……' : (followUp.error ? `AI 解答失败：${followUp.error}` : '等待 AI 解答') });
				if (followUp.error && !busy) {
					status.createEl('button', { cls: 'rn-plain', text: '重试', attr: { type: 'button' } }).addEventListener('click', () => {
						const path = this.file?.path;
						if (!path || this.inflightFollowUps.has(followUp.id)) return;
						this.inflightFollowUps.add(followUp.id);
						this.syncQuestions();
						void this.plugin.answerFollowUp(path, question.id, followUp.id).finally(() => {
							this.inflightFollowUps.delete(followUp.id);
							void this.pull().then(() => this.syncQuestions());
						});
					});
				}
			}
			if (followUp.answer) {
				const collapsed = this.collapsedFollowUps.has(followUp.id);
				const answer = row.createDiv({ cls: 'rn-ref' });
				answer.toggleClass('is-collapsed', collapsed);
				const toggle = answer.createEl('button', { cls: 'rn-ref__toggle', attr: { type: 'button', 'aria-expanded': String(!collapsed), title: '展开或收起 AI 解答' } });
				const chevron = toggle.createSpan({ cls: 'rn-ref__chevron' });
				setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');
				toggle.createSpan({ cls: 'rn-ref__label', text: 'AI 解答' });
				const body = answer.createDiv({ cls: 'rn-ref__body' });
				void MarkdownRenderer.render(this.app, followUp.answer, body, this.file?.path ?? '', this.plugin);
				toggle.addEventListener('click', () => {
					const next = !this.collapsedFollowUps.has(followUp.id);
					if (next) this.collapsedFollowUps.add(followUp.id);
					else this.collapsedFollowUps.delete(followUp.id);
					answer.toggleClass('is-collapsed', next);
					toggle.setAttribute('aria-expanded', String(!next));
					setIcon(chevron, next ? 'chevron-right' : 'chevron-down');
				});
			}
		}

		follow.createDiv({ cls: 'rn-follow__title', text: '继续追问' });
		const followInput = follow.createEl('textarea', { cls: 'rn-follow__input', attr: { rows: '1', placeholder: '针对 AI 解答继续提问' } });
		followInput.addEventListener('input', () => this.autosize(followInput));
		follow.createEl('button', { cls: 'rn-plain', text: '提交追问', attr: { type: 'button' } }).addEventListener('click', () => {
			const text = followInput.value.trim();
			const path = this.file?.path;
			if (!text || !path) return;
			followInput.value = '';
			void this.plugin.store.addFollowUp(path, question.id, text).then(async (id) => {
				await this.pull();
				this.syncQuestions();
				if (id && this.plugin.settings.aiEnabled) {
					this.inflightFollowUps.add(id);
					this.syncQuestions();
					void this.plugin.answerFollowUp(path, question.id, id).finally(() => {
						this.inflightFollowUps.delete(id);
						void this.pull().then(() => this.syncQuestions());
					});
				}
			});
		});

		const mine = item.createDiv({ cls: 'rn-mine' });
		const input = mine.createEl('textarea', { cls: 'rn-mine__input', attr: { rows: '1', placeholder: '你的答案' } });
		input.value = question.mine;
		this.autosize(input);
		window.requestAnimationFrame(() => this.autosize(input));
		input.addEventListener('input', () => this.autosize(input));
		const commit = (): void => {
			const path = this.file?.path;
			if (!path || input.value === question.mine) return;
			question.mine = input.value;
			void this.plugin.store.setMine(path, question.id, input.value);
		};
		input.addEventListener('blur', commit);
		this.committers.set(input, () => {
			commit();
			input.blur();
		});

		return item;
	}

	private removeQuestion(question: Question, button: HTMLButtonElement): void {
		if (button.dataset.confirm !== 'true') {
			button.dataset.confirm = 'true';
			button.setText('确认删除');
			window.setTimeout(() => {
				if (button.isConnected && button.dataset.confirm === 'true') {
					button.dataset.confirm = '';
					button.setText('删除');
				}
			}, 2400);
			return;
		}
		const path = this.file?.path;
		if (!path) return;
		void this.plugin.store.removeQuestion(path, question.id).then(async () => {
			await this.pull();
			this.syncQuestions();
		});
	}

	private removeFollowUp(question: Question, followUp: { id: string }, button: HTMLButtonElement): void {
		if (button.dataset.confirm !== 'true') {
			button.dataset.confirm = 'true';
			button.setText('确认删除');
			window.setTimeout(() => {
				if (button.isConnected && button.dataset.confirm === 'true') {
					button.dataset.confirm = '';
					button.setText('删除');
				}
			}, 2400);
			return;
		}
		const path = this.file?.path;
		if (!path) return;
		void this.plugin.store.removeFollowUp(path, question.id, followUp.id).then(async () => {
			await this.pull();
			this.syncQuestions();
		});
	}

	private editQuestion(head: HTMLElement, question: Question): void {
		if (head.querySelector('textarea')) return;
		const text = head.querySelector('.rn-q__text');
		const more = head.querySelector('.rn-q__more');
		if (!(text instanceof HTMLElement)) return;

		const box = head.ownerDocument.createElement('textarea');
		box.className = 'rn-input rn-q__edit';
		box.rows = 2;
		box.value = question.text;
		text.replaceWith(box);
		if (more instanceof HTMLElement) more.hide();
		this.autosize(box);
		box.focus();
		box.setSelectionRange(box.value.length, box.value.length);
		box.addEventListener('input', () => this.autosize(box));
		box.addEventListener('keydown', (event) => event.stopPropagation());

		let done = false;
		const commit = (): void => {
			if (done) return;
			done = true;
			this.committers.delete(box);
			const path = this.file?.path;
			if (!path || !box.value.trim() || box.value.trim() === question.text) {
				box.replaceWith(text);
				if (more instanceof HTMLElement) more.show();
				return;
			}
			void this.plugin.store.setQuestionText(path, question.id, box.value).then(async () => {
				await this.pull();
				this.syncQuestions();
			});
		};
		box.addEventListener('blur', commit);
		this.committers.set(box, commit);
	}

	/** 没答案时的三种状态：查询中 / 失败（可重试）/ 还没查 */
	private renderQuestionStatus(parent: HTMLElement, question: Question): void {
		const row = parent.createDiv({ cls: 'rn-q__status' });
		if (this.plugin.isInflight(question.id)) {
			row.createSpan({ cls: 'rn-q__waiting', text: '正在由 AI 解答……' });
			return;
		}
		if (question.error) {
			const text = question.error.length > 80 ? `${question.error.slice(0, 80)}…` : question.error;
			const error = row.createSpan({ cls: 'rn-q__error', text: `AI 解答失败：${text}` });
			error.title = question.error;
		} else {
			row.createSpan({ cls: 'rn-q__waiting', text: '等待 AI 解答' });
		}
		row.createEl('button', {
			cls: 'rn-plain',
			text: question.error ? '重试' : '立即解答',
			attr: { type: 'button' },
		}).addEventListener('click', () => {
			const path = this.file?.path;
			if (!path) return;
			void this.plugin
				.answerOne(path, question.id)
				.catch((error: unknown) => console.error('[reading-notes] 重试失败：', error))
				.finally(() => {
					void this.pull().then(() => this.syncQuestions());
				});
		});
		if (question.tries > 1) row.createSpan({ cls: 'rn-q__waiting', text: `已试 ${question.tries} 次` });
	}

	/** AI 写到文件后只刷新变化的那几张卡 */
	async refreshAnswers(): Promise<void> {
		if (!this.file) return;
		const next = await this.plugin.store.read(this.file.path);
		if (!next) return;
		this.data = next;
		if (this.isEditing()) return;
		this.syncQuestions();
	}

	private updateQuestionCount(count: number): void {
		if (this.countEl) this.countEl.setText(count > 0 ? `${count} 个问题` : '暂无问题');
	}

	private autosize(box: HTMLTextAreaElement): void {
		box.style.height = 'auto';
		box.style.height = `${Math.max(box.scrollHeight, 22)}px`;
	}
}
