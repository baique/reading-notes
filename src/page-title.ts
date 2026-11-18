import { requestUrl } from 'obsidian';

const ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	hellip: '…',
};

function decode(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
		if (code.startsWith('#')) {
			const num = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isFinite(num) && num > 0 ? String.fromCodePoint(num) : whole;
		}
		return ENTITIES[code.toLowerCase()] ?? whole;
	});
}

/** 从 HTML 取 <title>，顺带认一下 og:title */
export function extractTitle(html: string): string {
	const head = html.slice(0, 200_000);

	const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(head)
		?? /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i.exec(head);
	const tag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
	const raw = tag?.[1] ?? og?.[1] ?? '';
	return decode(raw)
		.replace(/\s+/g, ' ')
		.replace(/^[\s|·-]+|[\s|·-]+$/g, '')
		.trim()
		.slice(0, 120);
}

function normalize(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return '';
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** 请求页面并取标题；失败返回空串，不打扰用户 */
export async function fetchPageTitle(url: string): Promise<string> {
	const target = normalize(url);
	if (!target) return '';
	try {
		const response = await requestUrl({ url: target, method: 'GET', throw: false });
		if (response.status >= 400) return '';
		return extractTitle(response.text);
	} catch {
		return '';
	}
}
