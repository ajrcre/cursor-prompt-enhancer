const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const isMinify = process.argv.includes('--minify');

// Read the hook script source to embed as a compile-time constant
const hookScript = fs.readFileSync(
  path.join(__dirname, 'hooks', 'prompt-enhancer.mjs'),
  'utf-8'
);

const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  minify: isMinify,
  sourcemap: !isMinify,
  define: {
    __HOOK_SCRIPT_SOURCE__: JSON.stringify(hookScript),
  },
};

if (isWatch) {
  esbuild.context(buildOptions).then(ctx => {
    ctx.watch();
    console.log('Watching for changes...');
  }).catch(() => process.exit(1));
} else {
  esbuild.build(buildOptions)
    .then(() => console.log('Build complete'))
    .catch(() => process.exit(1));
}
