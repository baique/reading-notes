import { App, TFile } from 'obsidian';

/** 一篇在读内容是一个自有类型文件：.read，内容是结构化 JSON，跟 canvas 一个思路 */
export const READING_EXT = 'read';

export interface FollowUp {
	id: string;
	question: string;
	answer: string;
	answerAt: string;
	error: string;
	tries: number;
}

export interface Question {
	id: string;
	text: string;
	/** AI 参考答案，空表示还没查 */
	answer: string;
	/** 形如 02-14 15:03 */
	answerAt: string;
	/** 我自己写的回答 */
	mine: string;
	/** 上次查询失败的说明，空表示没失败过 */
	error: string;
	/** 尝试次数，用来避免一直重试 */
	tries: number;
	followUps: FollowUp[];
}

export interface ReadingFile {
	title: string;
	url: string;
	created: string;
	/** 笔记就是这一段 markdown，跟着 .read 文件走，不另建文件 */
	notes: string;
	questions: Question[];
}

export interface ReadingEntry {
	file: TFile;
	data: ReadingFile;
}

function newId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function blank(title: string, url: string, created: string): ReadingFile {
	return { title, url, created, notes: '', questions: [] };
}

/** 兼容早期形态：notes 是数组或字符串 */
function notesOf(raw: unknown): string {
	if (typeof raw === 'string') return raw;
	if (!Array.isArray(raw)) return '';
	return raw
		.map((item) => (typeof (item as { text?: unknown } | null)?.text === 'string' ? (item as { text: string }).text : ''))
		.filter((text) => text.trim() !== '')
		.map((text) => `- ${text}`)
		.join('\n');
}

function parse(raw: string): ReadingFile | null {
	try {
		const data = JSON.parse(raw) as Partial<ReadingFile> | null;
		if (!data || typeof data !== 'object') return null;
		return {
			title: typeof data.title === 'string' ? data.title : '未命名阅读',
			url: typeof data.url === 'string' ? data.url : '',
			created: typeof data.created === 'string' ? data.created : '',
			notes: notesOf((data as { notes?: unknown }).notes),
			questions: Array.isArray(data.questions)
				? data.questions.map((q) => ({
						id: typeof q?.id === 'string' ? q.id : newId(),
						text: typeof q?.text === 'string' ? q.text : '',
						answer: typeof q?.answer === 'string' ? q.answer : '',
						answerAt: typeof q?.answerAt === 'string' ? q.answerAt : '',
						mine: typeof q?.mine === 'string' ? q.mine : '',
						error: typeof q?.error === 'string' ? q.error : '',
						tries: typeof q?.tries === 'number' ? q.tries : 0,
						followUps: Array.isArray((q as { followUps?: unknown }).followUps)
							? ((q as { followUps: unknown[] }).followUps).map((f) => ({
								id: typeof (f as any)?.id === 'string' ? (f as any).id : newId(),
								question: typeof (f as any)?.question === 'string' ? (f as any).question : '',
								answer: typeof (f as any)?.answer === 'string' ? (f as any).answer : '',
								answerAt: typeof (f as any)?.answerAt === 'string' ? (f as any).answerAt : '',
								error: typeof (f as any)?.error === 'string' ? (f as any).error : '',
								tries: typeof (f as any)?.tries === 'number' ? (f as any).tries : 0,
							}))
							: [],
					}))
				: [],
		};
	} catch {
		return null;
	}
}

/** 文件读写层：一个 .read 文件是一篇在读内容，配套一个同名 .md 存笔记 */
export class Store {
	constructor(private app: App) {}

	private file(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	async read(path: string): Promise<ReadingFile | null> {
		const file = this.file(path);
		return file ? parse(await this.app.vault.read(file)) : null;
	}

	/** 全库扫描：.read 放哪儿由用户决定 */
	async list(): Promise<ReadingEntry[]> {
		const out: ReadingEntry[] = [];
		for (const file of this.app.vault.getFiles()) {
			if (file.extension !== READING_EXT) continue;
			const data = await this.read(file.path);
			if (data) out.push({ file, data });
		}
		return out.sort((a, b) => (a.data.created < b.data.created ? 1 : -1));
	}

	async create(dir: string, title: string, url: string, created: string): Promise<TFile> {
		const clean = title.trim().replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名阅读';
		const prefix = dir ? `${dir}/` : '';
		if (prefix && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir).catch(() => undefined);
		let path = `${prefix}${clean}.${READING_EXT}`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = `${prefix}${clean} ${n}.${READING_EXT}`;
			n += 1;
		}
		return this.app.vault.create(path, JSON.stringify(blank(clean, url.trim(), created), null, '\t'));
	}

	/** 读改写一次性完成，避免覆盖别处的编辑 */
	async mutate(path: string, fn: (data: ReadingFile) => void): Promise<ReadingFile | null> {
		const file = this.file(path);
		if (!file) return null;
		let next: ReadingFile | null = null;
		await this.app.vault.process(file, (raw) => {
			const data = parse(raw) ?? blank(file.basename, '', '');
			fn(data);
			next = data;
			return JSON.stringify(data, null, '\t');
		});
		return next;
	}

	async addQuestion(path: string, text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) return;
		await this.mutate(path, (data) => {
			data.questions.unshift({ id: newId(), text: clean, answer: '', answerAt: '', mine: '', error: '', tries: 0, followUps: [] });
		});
	}

	async addFollowUp(path: string, questionId: string, text: string): Promise<string | null> {
		const clean = text.trim();
		if (!clean) return null;
		const id = newId();
		await this.mutate(path, (data) => {
			const question = data.questions.find((q) => q.id === questionId);
			question?.followUps.push({ id, question: clean, answer: '', answerAt: '', error: '', tries: 0 });
		});
		return id;
	}

	async removeFollowUp(path: string, questionId: string, followUpId: string): Promise<void> {
		await this.mutate(path, (data) => {
			const question = data.questions.find((q) => q.id === questionId);
			if (question) question.followUps = question.followUps.filter((f) => f.id !== followUpId);
		});
	}

	async setFollowUpAnswer(path: string, questionId: string, followUpId: string, answer: string, at: string): Promise<void> {
		await this.mutate(path, (data) => {
			const followUp = data.questions.find((q) => q.id === questionId)?.followUps.find((f) => f.id === followUpId);
			if (followUp) { followUp.answer = answer; followUp.answerAt = at; followUp.error = ''; followUp.tries = 0; }
		});
	}

	async recordFollowUpFailure(path: string, questionId: string, followUpId: string, error: string): Promise<void> {
		await this.mutate(path, (data) => {
			const followUp = data.questions.find((q) => q.id === questionId)?.followUps.find((f) => f.id === followUpId);
			if (followUp) { followUp.error = error.slice(0, 300); followUp.tries += 1; }
		});
	}

	async setQuestionText(path: string, id: string, text: string): Promise<void> {
		const clean = text.trim();
		if (!clean) return;
		await this.mutate(path, (data) => {
			const question = data.questions.find((q) => q.id === id);
			if (question) question.text = clean;
		});
	}

	async removeQuestion(path: string, id: string): Promise<void> {
		await this.mutate(path, (data) => {
			data.questions = data.questions.filter((q) => q.id !== id);
		});
	}

	async setMine(path: string, id: string, mine: string): Promise<void> {
		await this.mutate(path, (data) => {
			const question = data.questions.find((q) => q.id === id);
			if (question) question.mine = mine;
		});
	}

	async setAnswer(path: string, id: string, answer: string, at: string): Promise<void> {
		await this.mutate(path, (data) => {
			const question = data.questions.find((q) => q.id === id);
			if (!question || question.answer) return;
			question.answer = answer;
			question.answerAt = at;
			question.error = '';
			question.tries = 0;
		});
	}

	/** 记一次失败，顺便累加尝试次数 */
	async recordFailure(path: string, id: string, error: string): Promise<void> {
		await this.mutate(path, (data) => {
			const question = data.questions.find((q) => q.id === id);
			if (!question) return;
			question.error = error.slice(0, 300);
			question.tries += 1;
		});
	}

	async setMeta(path: string, title: string, url: string): Promise<void> {
		await this.mutate(path, (data) => {
			data.title = title.trim() || data.title;
			data.url = url.trim();
		});
	}

	// ---------- 笔记：.read 里的一段 markdown ----------

	async setNotes(path: string, notes: string): Promise<void> {
		await this.mutate(path, (data) => {
			data.notes = notes;
		});
	}

	/**
	 * 早期版本给每篇 .read 配过一个同名 .md。把内容收回 JSON 再删文件，不丢字。
	 */
	async absorbCompanionFile(path: string): Promise<string | null> {
		const companion = path.replace(new RegExp(`\\.${READING_EXT}$`), '.md');
		const file = this.file(companion);
		if (!file) return null;
		const text = (await this.app.vault.read(file)).replace(/^# 笔记\n+/, '').trim();
		if (text) {
			await this.mutate(path, (data) => {
				data.notes = data.notes.trim() ? `${data.notes.trim()}\n\n${text}` : text;
			});
		}
		await this.app.vault.delete(file);
		return text;
	}

	/** 所有还没有参考答案的问题 */
	async pending(): Promise<{ path: string; data: ReadingFile; question: Question }[]> {
		const out: { path: string; data: ReadingFile; question: Question }[] = [];
		for (const entry of await this.list()) {
			for (const question of entry.data.questions) {
				if (question.answer || !question.text) continue;
				out.push({ path: entry.file.path, data: entry.data, question });
			}
		}
		return out;
	}
}
