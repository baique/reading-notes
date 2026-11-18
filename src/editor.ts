import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** 语法着色全部走 Obsidian 的 CSS 变量，亮/暗主题都跟得上 */
const highlight = HighlightStyle.define([
	{ tag: tags.heading1, fontSize: '1.25em', fontWeight: '600', color: 'var(--text-accent)' },
	{ tag: tags.heading2, fontSize: '1.12em', fontWeight: '600', color: 'var(--text-accent)' },
	{ tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '600' },
	{ tag: tags.strong, fontWeight: '700' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.link, color: 'var(--text-accent)' },
	{ tag: tags.url, color: 'var(--text-faint)' },
	{ tag: tags.monospace, fontFamily: 'var(--font-monospace)', color: 'var(--text-muted)' },
	{ tag: tags.quote, color: 'var(--text-muted)' },
	{ tag: [tags.meta, tags.processingInstruction], color: 'var(--text-faint)' },
	{ tag: tags.strikethrough, textDecoration: 'line-through' },
]);

const theme = EditorView.theme({
	'&': { height: '100%', backgroundColor: 'transparent' },
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': { fontFamily: 'var(--font-text)', fontSize: '13px', lineHeight: '1.75', overflow: 'auto' },
	'.cm-content': { padding: '2px 20px 80px', color: 'var(--text-normal)', caretColor: 'var(--text-accent)' },
	'.cm-line': { padding: '0' },
	'.cm-gutters': { display: 'none' },
	'.cm-activeLine': { backgroundColor: 'transparent' },
});

export interface NotesEditor {
	getValue(): string;
	destroy(): void;
	focus(): void;
}

/** 笔记编辑器：CodeMirror 6 的 markdown 源码模式，装在插件自己的视图里 */
export function createNotesEditor(parent: HTMLElement, value: string, onChange: (text: string) => void): NotesEditor {
	const view = new EditorView({
		parent,
		state: EditorState.create({
			doc: value,
			extensions: [
				markdown(),
				syntaxHighlighting(highlight),
				history(),
				EditorView.lineWrapping,
				keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) onChange(update.state.doc.toString());
				}),
				theme,
			],
		}),
	});

	return {
		getValue: () => view.state.doc.toString(),
		destroy: () => view.destroy(),
		focus: () => view.focus(),
	};
}
