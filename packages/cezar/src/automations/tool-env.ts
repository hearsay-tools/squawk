import { automationsEnabled } from './enabled.ts';
export function automationsToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean { return automationsEnabled(env); }
