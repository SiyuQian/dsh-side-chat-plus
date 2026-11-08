import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
await mkdir('lib',{recursive:true});
await build({entryPoints:['src/index.js'],outfile:'lib/index.js',bundle:true,format:'esm',platform:'node',target:'node24',packages:'external',sourcemap:true});
await build({entryPoints:['src/client.jsx'],outfile:'lib/client.js',bundle:true,format:'esm',platform:'browser',target:'es2022',external:['react','react-dom','@deepseek-ai/*'],loader:{'.css':'text'},sourcemap:true});
console.log('Built host and client bundles.');
