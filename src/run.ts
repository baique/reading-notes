import { spawn } from 'child_process';
import { Platform } from 'obsidian';

export interface CommandConfig {
	/** 例：pi --no-session -p "${prompt}" */
	command: string;
	/** 例：阅读这个链接的内容：${link}，回答我的问题：${question} */
	template: string;
	timeoutMs: number;
	/** 执行目录，一般给 vault 根 */
	cwd: string;
}

export interface PromptVars {
	link: string;
	title: string;
	question: string;
	notes: string;
}

export const DEFAULT_TEMPLATE = '阅读这个链接的内容：${link}\n\n我的问题是：${question}\n\n只给结论和依据，不要客套话。';
export const DEFAULT_COMMAND = 'pi --no-session -p "${prompt}"';

/** 模板里的 ${变量} 替换；未知变量原样留着，方便排查 */
export function fillTemplate(template: string, vars: Record<string, string>): string {
	return template.replace(/\$\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** 放进双引号里安全：转义 $、`、"、\ */
export function escapeForCommand(text: string): string {
	return text.replace(/[\\$`"]/g, (char) => `\\${char}`);
}

const SHELL = Platform.isMacOS ? '/bin/zsh' : '/bin/bash';

function shellFor(command: string): { file: string; args: string[] } {
	if (Platform.isWin) return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
	return { file: SHELL, args: ['-c', command] };
}

/** 把失败翻译成人能看的话：不要那串 Command failed: <整条命令> */
export function describeFailure(code: number | null, stderr: string, timedOut: boolean, timeout: number): string {
	const detail = stderr.trim().slice(0, 400);
	const seconds = Math.round(timeout / 1000);
	// 超时被杀时，命令往往已经把真正的原因打到 stderr 了
	if (timedOut) return detail ? `超时（${seconds} 秒），已收到的错误输出：${detail}` : `超时（${seconds} 秒），没有任何输出`;
	if (detail) return code !== null && code !== 0 ? `${detail}（退出码 ${code}）` : detail;
	if (code === 127) return '命令没找到（退出码 127）：检查命令名，或它是否装在 PATH 里';
	if (code !== null) return `退出码 ${code}，且没有输出错误信息`;
	return '命令执行失败，没有输出错误信息';
}

const MAX_STDOUT = 16 * 1024 * 1024;

/** 跑子进程：stdin 接 /dev/null，超时自己杀，stdout 全文返回 */
function exec(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { cwd: cwd || undefined, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			setTimeout(() => child.kill('SIGKILL'), 2000);
		}, timeout);

		child.stdout?.setEncoding('utf8');
		child.stderr?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			if (stdout.length < MAX_STDOUT) stdout += chunk;
		});
		child.stderr?.on('data', (chunk: string) => {
			if (stderr.length < 4000) stderr += chunk;
		});
		child.on('error', (error: Error) => {
			clearTimeout(timer);
			reject(new Error(`无法启动命令：${error.message}`));
		});
		child.on('close', (code: number | null, signal: string | null) => {
			clearTimeout(timer);
			if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
				reject(new Error(describeFailure(code, stderr, true, timeout)));
				return;
			}
			if (code !== 0) {
				reject(new Error(describeFailure(code, stderr, false, timeout)));
				return;
			}
			resolve(stdout);
		});
	});
}

let cachedPath: string | null = null;

/**
 * GUI 启动的 Obsidian 只有 /usr/bin:/bin 这类最小 PATH，nvm / homebrew 装的命令都在
 * ~/.zshrc 里追加，而 -lc 只读 .zprofile，读不到 → 所以单独问一次交互式登录 shell。
 */
export async function resolveShellPath(): Promise<string> {
	if (Platform.isWin) return process.env.PATH ?? '';
	if (cachedPath) return cachedPath;
	const probe = await exec(SHELL, ['-ilc', 'printf %s "$PATH"'], process.env, '', 8000).catch(() => '');
	const parts = [probe.trim(), process.env.PATH ?? ''].join(':').split(':').filter(Boolean);
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const part of parts) {
		if (seen.has(part)) continue;
		seen.add(part);
		merged.push(part);
	}
	cachedPath = merged.join(':');
	return cachedPath;
}

/** 跑外部命令，stdout 就是答案 */
export async function runAnswer(config: CommandConfig, vars: PromptVars): Promise<string> {
	const prompt = fillTemplate(config.template, { ...vars });
	if (!config.command.trim()) throw new Error('没有配置命令');
	if (!/\$\{prompt\}/.test(config.command)) throw new Error('命令里缺少 ${prompt} 占位');

	const command = fillTemplate(config.command, { prompt: escapeForCommand(prompt), ...vars });
	const { file, args } = shellFor(command);
	const env = { ...process.env, PATH: await resolveShellPath() };
	const raw = await exec(file, args, env, config.cwd, Math.max(config.timeoutMs, 1000));
	const output = raw.trim();
	if (!output) throw new Error('命令没有输出');
	return output;
}
