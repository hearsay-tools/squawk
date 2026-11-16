import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {once} from 'node:events';
const root=mkdtempSync('/tmp/skill-open-checks-');const repo=join(root,'repo');mkdirSync(repo);execFileSync('git',['init','-q',repo]);
const skill=(path,name)=>{mkdirSync(path,{recursive:true});writeFileSync(join(path,'SKILL.md'),`---\nname: ${name}\ndescription: Probe fixture.\n---\nFixture.\n`);};
async function launch(bin,args,env,run){const c=spawn(bin,args,{cwd:repo,env:{...process.env,TMPDIR:'/tmp',...env}});c.stderr.resume();const end=once(c,'exit');const timer=setTimeout(()=>c.kill('SIGKILL'),10000);try{await run(c);}finally{c.kill('SIGKILL');await end;clearTimeout(timer);}}
async function lines(c,fn){let pending='';return new Promise((resolve,reject)=>{c.on('error',reject);c.on('exit',()=>reject(new Error('no reply')));c.stdout.on('data',v=>{pending+=v;let i;while((i=pending.indexOf('\n'))>=0){let line=pending.slice(0,i);pending=pending.slice(i+1);try{let v=JSON.parse(line);if(fn(v))resolve(v);}catch{}}});});}
const mode=process.argv[2];
if(mode==='claude'||mode==='claude-mcp-start'){
 const home=join(root,'claude');mkdirSync(home);skill(join(home,'skills/probe-user'),'probe-user');skill(join(repo,'.claude/skills/probe-project'),'probe-project');
 const hook=join(root,'hook-ran'), mcp=join(root,'mcp-ran');
 writeFileSync(join(root,'mcp.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(mcp)},'yes');process.stdin.resume();`);
 const settings={hooks:{SessionStart:[{hooks:[{type:'command',command:`touch '${hook}'`}]}]}};
 mkdirSync(join(repo,'.claude'),{recursive:true});writeFileSync(join(repo,'.claude/settings.json'),JSON.stringify(settings));
 writeFileSync(join(home,'settings.json'),JSON.stringify(settings));
 writeFileSync(join(home,'.claude.json'),JSON.stringify({mcpServers:{probe:{type:'stdio',command:process.execPath,args:[join(root,'mcp.mjs')]}}}));
 await launch('claude',['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--settings','{"disableAllHooks":true}','--no-session-persistence',...(mode==='claude' ? ['--strict-mcp-config','--mcp-config','{"mcpServers":{}}'] : ['--mcp-config',JSON.stringify({mcpServers:{probe:{command:process.execPath,args:[join(root,'mcp.mjs')]}}})])],{CLAUDE_CONFIG_DIR:home},async c=>{
 const reply=lines(c,v=>v.type==='control_response'&&v.response?.request_id==='skills');c.stdin.write('{"type":"control_request","request_id":"skills","request":{"subtype":"get_skills_dialog"}}\n');const v=await reply;console.log('list names',v.response.response.skills.map(s=>s.name).join(','));
 });
 console.log('hook marker',existsSync(hook),'MCP marker',existsSync(mcp));console.log('home top-level',readdirSync(home).join(','));console.log('session files',execFileSync('find',[home,'-name','*.jsonl'],{encoding:'utf8'}).trim()||'none');
}
if(mode==='codex'){
 const home=join(root,'codex');mkdirSync(home);skill(join(repo,'.agents/skills/probe-original'),'probe-original');mkdirSync(join(repo,'.codex/skills'),{recursive:true});execFileSync('ln',['-s','../../.agents/skills/probe-original',join(repo,'.codex/skills/probe-mirror')]);
 await launch('codex',['app-server'],{CODEX_HOME:home},async c=>{const reply=lines(c,v=>{if(v.id===1)c.stdin.write('{"id":2,"method":"skills/list","params":'+JSON.stringify({cwds:[repo]})+'}\n');return v.id===2;});c.stdin.write('{"id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"1"}}}\n');const v=await reply;console.log('mirrors',JSON.stringify(v.result.data[0].skills.filter(s=>s.name==='probe-original')));});console.log('new home entries',readdirSync(home).join(','));
}
if(mode==='omp'){
 const name='squawk-list-probe-'+Date.now();
 const profile=join(process.env.PI_CONFIG_DIR ?? join(process.env.HOME,'.omp'),'profiles',name);
 skill(join(profile,'agent/skills/probe-profile'),'probe-profile');
 // OMP_PROFILE alone, against the real root. omp owns every write in that profile.
 await launch('omp',['skill','list','--json'],{OMP_PROFILE:name},async c=>{let out='';c.stdout.on('data',s=>out+=s);await once(c,'close');const v=JSON.parse(out);console.log('profile',name,'list',v.skills.length,'warnings',v.warnings.length,'skill',JSON.stringify(v.skills.find(s=>s.name==='probe-profile')));});
 rmSync(profile,{recursive:true,force:true});
}
console.log('scratch',root);

rmSync(root,{recursive:true,force:true});
