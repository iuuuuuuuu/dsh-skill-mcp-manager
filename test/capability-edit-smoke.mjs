import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { readSkillFile } from "../lib/skill.js";

export async function createEditHarness({ serve, pluginUrl = new URL("../lib/index.js", import.meta.url).href } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-capability-edit-"));
  process.env.DSH_HOME = join(root, "home");
  const { apply } = await import(pluginUrl);
  const dataDir = join(root, "data"); await mkdir(dataDir, {recursive:true});
  const paths = { own: join(root,"own","SKILL.md"), plugin: join(root,"plugin","SKILL.md"), shipped: join(root,"node_modules","fixture","SKILL.md") };
  for (const [name,file] of Object.entries(paths)) { await mkdir(join(file,".."),{recursive:true}); await writeFile(file,'---\nname: '+name+'\ndescription: Original description\n---\n\n# Original '+name+'\n'); }
  const require=createRequire(import.meta.url);
  const sdk=(name)=>JSON.stringify(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/'+name)).href);
  const serverFile=join(root,"server with spaces.mjs");
  await writeFile(serverFile,'import {Server} from '+sdk('server/index.js')+';\nimport {StdioServerTransport} from '+sdk('server/stdio.js')+';\nimport {ListToolsRequestSchema,CallToolRequestSchema} from '+sdk('types.js')+';\nconst s=new Server({name:"editor-fixture",version:"1"},{capabilities:{tools:{}}});s.setRequestHandler(ListToolsRequestSchema,async()=>{if(process.argv.includes("--slow-edit")){const {writeFile}=await import("node:fs/promises");await writeFile(process.argv[process.argv.indexOf("--slow-edit")+1],"ready");await new Promise(r=>setTimeout(r,400));}return {tools:[{name:"ping",description:"Ping",inputSchema:{type:"object"}}]};});s.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:"text",text:"pong"}]}));await s.connect(new StdioServerTransport());');
  const effects=[],routes=[];
  const service={registerProvider(){return()=>{}},invalidateCache(){},async list(){return await Promise.all(Object.keys(paths).map(name=>this.get(name)))},async get(name){if(!paths[name])return undefined;const parsed=await readSkillFile(paths[name],undefined,name);if(!parsed)return undefined;return {...parsed,path:paths[name],provider:name==='plugin'?'fixture-plugin':'filesystem'};}};
  const web={register(route){assert(!routes.some(r=>r.path===route.path&&r.kind===route.kind),'duplicate route');routes.push(route);return()=>{}}};
  const ctx={skills:service,tools:{register(){return()=>{}}},logger:{warn(){},error(){},info(){}},on(){return()=>{}},effect(fn){const off=fn();if(typeof off==='function')effects.push(off);return()=>{}},get(name){return name==='webServer'?web:name==='skills'?service:undefined},inject(names,fn){if([].concat(names).includes('webServer'))fn(ctx);if([].concat(names).includes('loader'))fn({loader:{entries(){return [{id:'plugin-row',options:{name:'@deepseek-ai/dsh-mcp-client',id:'plugin-row',config:{serverName:'plugin-mcp',transport:'stdio',command:process.execPath,args:[serverFile]}}}]}}});return()=>{}}};
  await apply(ctx,{dataDir,profile:'__test__',importNativeMcp:false});
  const server=createServer((req,res)=>{const route=routes.find(r=>r.path===new URL(req.url,'http://localhost').pathname);if(!route){if(serve){Promise.resolve(serve(req,res)).catch(e=>{res.writeHead(500);res.end(e.message);});return;}res.writeHead(404);res.end();return;}Promise.resolve(route.handler(req,res)).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  async function request(path,body){const res=await fetch(base+'/skill-mcp-manager/'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,body:await res.json()};}
  return {root,paths,dataDir,serverFile,base,request,async close(){await new Promise(r=>server.close(r));for(const off of effects)await off();await rm(root,{recursive:true,force:true});}};
}

export async function verifyEditHarness(h) {
 const {request,paths,dataDir,serverFile}=h;
 let r=await request('mcp/add',{name:'own-mcp',transport:'stdio',command:process.execPath,args:[serverFile],env:{FIXTURE_VALUE:'not-a-real-secret'}});assert.equal(r.status,200);
 await request('mcp/workspace',{name:'own-mcp',workspace:h.root});
 assert.equal((await request('mcp/add',{name:'plugin-mcp',transport:'stdio',command:process.execPath,args:[serverFile]})).status,200);
 assert.equal((await request('mcp/edit?name=plugin-mcp')).status,400);
 let m=(await request('mcp/edit?name=own-mcp')).body;assert.deepEqual(m.config.args,[serverFile]);
 const original=await readFile(join(dataDir,'registry.json'),'utf8');
 assert.equal((await request('mcp/update',{name:'plugin-mcp',revision:m.revision,config:m.config})).status,400);
 assert.equal((await request('mcp/update',{name:'no-such-mcp',revision:m.revision,config:m.config})).status,400);
 const bad={...m.config,args:['-e','process.exit(2)']};
 assert.equal((await request('mcp/update',{name:'own-mcp',revision:m.revision,config:bad})).status,400);assert.equal(await readFile(join(dataDir,'registry.json'),'utf8'),original);
 r=await request('mcp/update',{name:'own-mcp',revision:m.revision,config:{...m.config,args:[serverFile,'argument with spaces'],env:{},notes:'Edited note',cwd:''}});assert.equal(r.status,200);
 let saved=JSON.parse(await readFile(join(dataDir,'registry.json'),'utf8')).entries[0];assert.equal(saved.notes,'Edited note');assert.deepEqual(saved.env,{});assert.equal(saved.workspace,h.root);assert.deepEqual(saved.args,[serverFile,'argument with spaces']);
 assert.equal((await request('mcp/update',{name:'own-mcp',revision:m.revision,config:m.config})).status,400);
 m=(await request('mcp/edit?name=own-mcp')).body;
 assert.equal((await request('mcp/update',{name:'own-mcp',revision:m.revision,config:{...m.config,args:'not-array'}})).status,400);
 const httpConfig={...m.config,transport:'streamable-http',url:'http://127.0.0.1:1/mcp',headers:{'X-Fixture':'editor-value'},notes:''};
 assert.equal((await request('mcp/update',{name:'own-mcp',revision:m.revision,config:httpConfig,skipTrial:true})).status,200);
 const httpEdit=(await request('mcp/edit?name=own-mcp')).body;assert.equal(httpEdit.config.transport,'streamable-http');assert.equal(httpEdit.config.notes,'');assert.deepEqual(httpEdit.config.headers,{'X-Fixture':'editor-value'});
 assert.equal((await request('mcp/update',{name:'own-mcp',revision:httpEdit.revision,config:m.config})).status,200);
 // A real tools/list handshake stays in flight while the normal tier route changes the entry.
 const during=(await request('mcp/edit?name=own-mcp')).body;
 const marker=join(h.root,'trial-in-progress');
 const inFlight=request('mcp/update',{name:'own-mcp',revision:during.revision,config:{...during.config,args:[serverFile,'--slow-edit',marker],notes:'stale trial edit'}});
 let ready=false;for(let attempt=0;attempt<500;attempt++){if(await readFile(marker,'utf8').then(()=>true,()=>false)){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
 assert(ready,'fixture must reach its actual tools/list handler');
 assert.equal((await request('mcp/tier',{name:'own-mcp',tier:'disabled'})).status,200);
 assert.equal((await inFlight).status,400,'trial must not overwrite a concurrent tier change');
 const afterTrial=JSON.parse(await readFile(join(dataDir,'registry.json'),'utf8')).entries.find(e=>e.name==='own-mcp');
 assert.equal(afterTrial.tier,'disabled');assert.notEqual(afterTrial.notes,'stale trial edit');
 assert.equal((await request('mcp/tier',{name:'own-mcp',tier:'on-demand'})).status,200);
 for(const name of ['plugin','shipped']){const before=await readFile(paths[name],'utf8');assert.equal((await request('skills/edit?name='+name)).status,400);assert.equal((await request('skills/update',{name,revision:'forged',content:'forged'})).status,400);assert.equal(await readFile(paths[name],'utf8'),before);}
 let skill=(await request('skills/edit?name=own')).body;assert(skill.content.includes('name: own'));
 assert.equal((await request('skills/update',{name:'own',revision:skill.revision,content:skill.content.replace('name: own','name: renamed')})).status,400);
 assert.equal((await request('skills/update',{name:'own',revision:skill.revision,content:skill.content.replace('name: own\n','')})).status,400);
 assert.equal((await request('skills/update',{name:'own',revision:skill.revision,content:'---\nbad: [\n---\n'})).status,400);
 const changed=skill.content.replace('Original description','Edited description').replace('# Original own','# Edited own');
 assert.equal((await request('skills/update',{name:'own',revision:skill.revision,content:changed})).status,200);assert.equal(await readFile(paths.own,'utf8'),changed);assert.equal((await request('skills')).body.skills.find(s=>s.name==='own').description,'Edited description');
 assert.equal((await request('skills/update',{name:'own',revision:skill.revision,content:skill.content})).status,400);
 skill=(await request('skills/edit?name=own')).body;await writeFile(paths.own,skill.content+'\nExternal edit\n');assert.equal((await request('skills/update',{name:'own',revision:skill.revision,content:skill.content})).status,400);
 skill=(await request('skills/edit?name=own')).body;const pair=await Promise.all([1,2].map(n=>request('skills/update',{name:'own',revision:skill.revision,content:skill.content+'\nChange '+n})));assert.deepEqual(pair.map(r=>r.status).sort(),[200,400]);
 console.log('Real HTTP + stdio handshake + on-disk MCP/Skill edits, plugin/read-only guards, validation and concurrent conflicts verified');
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const h=await createEditHarness();try{await verifyEditHarness(h);console.log('CAPABILITY EDIT SMOKE PASSED');}finally{await h.close();}}
