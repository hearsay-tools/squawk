// No model call. Run one runner at a time. Output is metadata only.
import {hostSkillCatalogAdapters} from '../../../packages/cezar/src/core/host-skill-catalog.ts';
import {RunnerSkillCatalog} from '../../../packages/cezar/src/core/runner-skill-catalog.ts';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import { RUNNER_IDS } from '../../../packages/cezar/src/core/agent-runner.ts';
const runner=process.argv[2];
if (!RUNNER_IDS.includes(runner)) throw new Error('Pass a runner id');
const cwd=mkdtempSync('/tmp/real-skill-adapter-');execFileSync('git',['init','-q',cwd]);
for(const folder of ['.agents','.claude','.omp','.pi']) {const p=cwd+'/'+folder+'/skills/probe-project';mkdirSync(p,{recursive:true});writeFileSync(p+'/SKILL.md','---\nname: probe-project\ndescription: Project fixture.\n---\nFixture.\n');}
const started=Date.now();const result=await new RunnerSkillCatalog({adapters:hostSkillCatalogAdapters()}).get({runner,cwd});
const trim = (skill) => skill ? { ...skill, description: skill.description?.slice(0, 80) } : undefined;
console.log(JSON.stringify({runner,ms:Date.now()-started,source:result.source,count:result.skills.length,problems:result.problems.length,reason:result.reason,project:trim(result.skills.find(s=>s.id==='probe-project')),user:trim(result.skills.find(s=>s.scope==='user'&&!s.plugin)),plugin:trim(result.skills.find(s=>s.plugin))}));rmSync(cwd,{recursive:true,force:true});
