// The build's loop: a run set out in a worktree, each task's tests written first, a builder sent, the change proved,
// judged and committed, lanes landed, the branch judged whole and the pull request opened. It never touches the engine:
// it stands on the ports below, which the mod makes of `$`, and a test of plain fakes.

export * from './loop/ports'
export * from './loop/start'
export * from './loop/send'
export * from './loop/prove'
export * from './loop/review'
export * from './loop/commit'
export * from './loop/submit'
