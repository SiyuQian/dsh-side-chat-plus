import {build} from 'esbuild';
import {mkdir,readFile} from 'node:fs/promises';
const {name}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
await mkdir('lib',{recursive:true});
await build({entryPoints:['src/index.js'],outfile:'lib/index.js',bundle:true,format:'esm',platform:'node',target:'node24',packages:'external',sourcemap:true});
await build({entryPoints:['src/client.jsx'],outfile:'lib/client.js',bundle:true,format:'cjs',platform:'browser',target:'es2022',external:['react','react-dom','@deepseek-ai/*'],loader:{'.css':'text'},sourcemap:true,banner:{js:`window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory(require){const module={exports:{}};const exports=module.exports;`},footer:{js:'return module.exports;}});'}});
console.log('Built host and client bundles.');
