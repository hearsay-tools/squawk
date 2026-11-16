import { getRepoInfo } from '../server/git.ts';
import { githubRepository } from './github-repository.ts';
import { GithubPoller } from './github-poller.ts';

/** Use the same canonical origin discovery as the cockpit's manual preview route. */
export async function automationToolGithub(root: string) {
  const repository = githubRepository(root, (await getRepoInfo(root))?.remote);
  return repository ? { ...repository, poller: new GithubPoller() } : undefined;
}
