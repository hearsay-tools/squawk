# Reviewing task files

File links in task messages open the Files tab at the selected file, rather than
navigating to a host path under the cockpit URL. The selection stays in the URL,
so bookmarks and browser Back work. This works with local and remote cockpits.

For a deliverable outside the project, an agent must explicitly publish a snapshot:

```sh
hsq artifact publish /tmp/decision.md
```

An agent starts a long command, such as a benchmark or a full test run, with `hsq job start`:

```sh
hsq job start bench -- npm run benchmark
hsq job status bench
```

The command keeps running after the agent's shell call, turn and session end. It prints the
paths of its log file and its exit-code file, which are in the task's temp directory unless
`--dir` names another one. Squawk keeps the task's temp directory across a Squawk restart and a
host reboot while the task is live. When the task ends while the job runs, Squawk keeps that
directory, so the log and exit code are still there after the job ends; it removes the directory
at the next end once no job in it runs. Two cases lose it: the task ends with no job running, and
a checkout so deep that the temp directory falls back to a `cez-agent-…` directory under the
system temp directory, which a reboot can clear. For files that must outlive either, pass `--dir`
with a directory you keep, for example a git-ignored directory under the project's
`.ai/squawk/runs/`. The agent waits for the job with a process wait, which accepts the printed
`exitFile` in any `--dir`. A second start of a name that still runs is refused.

Squawk supplies the bundled command and task context to agent sessions automatically
(`HSQ_TASK_ID` (`CEZ_TASK_ID` fallback) and `HSQ_ARTIFACTS_DIR` (`CEZ_ARTIFACTS_DIR` fallback); do not configure these yourself). The command
returns JSON with a Markdown link for the agent to share. When the owning project
is registered, the link keeps that project when copied or opened from another
project. If ownership cannot be discovered, publication keeps the legacy task link.
The Files tab also lists published artifacts. It previews text, Markdown and raster
images; other formats can be downloaded. Published HTML links in assistant replies also
show report cards. **Read report** opens the sandboxed reader beside the conversation
on wide screens, in the main area on medium screens, and full screen on phones.
Back returns to the source card. Unopened cards fetch metadata only.
Report scripts never execute, and embedded images in Markdown documents do not load
automatically.

Snapshots do not change when the original file changes. They survive worktree
removal and are removed with task history, including normal history retention.
Publication is limited to 10 MiB per file, 64 snapshots and 64 MiB per task; reaching
a limit refuses the new publication without evicting earlier files. There is no
arbitrary host-file reader or automatic collection of mentioned paths. Publish
only intended review material, never credentials or unrelated private files.
