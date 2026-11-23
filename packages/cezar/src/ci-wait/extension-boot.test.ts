import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['pi', 'omp'])('%s extension seals wait kinds before advertising schemas in a cold process', runner => {
  const entry = new URL(`../../scripts/${runner}-ci-wait.mjs`, import.meta.url).href;
  const script = `
    const { default: extension } = await import(${JSON.stringify(entry)});
    const tools = [];
    extension({ registerTool(tool) { tools.push({ name: tool.name, parameters: tool.parameters }); } });
    console.log(JSON.stringify(tools));
  `;
  // bound: a cold extension only registers tools; it starts no controller or provider.
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)), encoding: 'utf8', timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const tools = JSON.parse(result.stdout) as { name: string; parameters: { properties: { kind?: { enum: string[] } } } }[];
  expect(tools.find(tool => tool.name === 'cezar_wait')?.parameters.properties.kind?.enum)
    .toEqual(['pr', 'worker', 'request', 'peer', 'timer', 'process']);
});
