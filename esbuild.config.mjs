import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';

const shared = {
	bundle: true,
	target: 'es2021',
	logLevel: 'info',
	treeShaking: true,
	minify: prod,
	sourcemap: prod ? false : 'inline',
};

const jsContext = await esbuild.context({
	...shared,
	entryPoints: ['src/main.ts'],
	external: ['obsidian', 'electron', ...builtinModules],
	format: 'cjs',
	outfile: 'main.js',
});

const cssContext = await esbuild.context({
	...shared,
	entryPoints: ['src/styles.css'],
	outfile: 'styles.css',
});

if (prod) {
	await jsContext.rebuild();
	await cssContext.rebuild();
	process.exit(0);
} else {
	await Promise.all([jsContext.watch(), cssContext.watch()]);
}
