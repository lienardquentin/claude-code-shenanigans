export type { ChangedRun, Database, LiveStage, Outcome, ProofState, Radius, RunState, Target, TargetKind, TestResult } from '../types'
// What a project builds and how each is tested, which target an edit is of, what a handler said changed, which test
// is marked on which run, and how a test ended on each side. Text in, text out: nothing here touches the machine.

export * from './proofs/project'
export * from './proofs/changes'
export * from './proofs/answers'
export * from './proofs/marks'
export * from './proofs/verdict'
