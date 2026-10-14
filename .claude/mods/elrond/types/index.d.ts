/** Where an issue lives: the forge that serves it, which says the CLI and the API it is read through. */
export type ElrondForge = 'github' | 'gitlab'

/** One issue, by where it lives. */
export type ElrondRef = {
  forge: ElrondForge
  /** The host that serves it, `github.com`, `gitlab.com` or a self-hosted one. */
  server: string
  /** The repository's path on that host: `owner/repo`, or `group/sub/project` on GitLab. */
  repo: string
  number: number
}

/** Where a task stands. */
export type ElrondTaskState = 'todo' | 'doing' | 'done'

/**
 * How much a task asks of whoever builds it: `light` for docs, config, a rename or a test to adjust; `standard` for
 * one module's change and its test; `heavy` for one that crosses targets or touches what is risky to change.
 */
export type ElrondWeight = 'light' | 'standard' | 'heavy'

/** One step of the quest: something a single change can do and a reviewer can check. */
export type ElrondTask = {
  id: number
  title: string
  /** Why it is needed, in a sentence. */
  why: string
  /** What to do, in order. */
  steps: string[]
  /** The files it touches or adds, from the project's folder. */
  files: string[]
  /** The tasks that must be done first, by id. */
  dependsOn: number[]
  /** How to tell it is done: a test that passes, a behaviour that is seen. */
  acceptance: string
  /** How much it asks of its builder; `standard` in a plan made before weights were. */
  weight: ElrondWeight
  state: ElrondTaskState
}

/** Something the issue leaves open, for the person to decide. */
export type ElrondQuestion = {
  text: string
  /** Short answers the council offers to pick from; the person may write their own. */
  options: string[]
  /** What the person answered; empty while unanswered. */
  answer: string
}

/** How much a risk could hurt the change: what breaks or is lost if it comes true. */
export type ElrondSeverity = 'high' | 'medium' | 'low'

/** Something that could go wrong with the change, and what the person chose to do about it. */
export type ElrondRisk = {
  text: string
  severity: ElrondSeverity
  /** How to make it less likely or less harmful; empty when the council named no way. */
  mitigation: string
  /** The tasks it threatens, by id. */
  tasks: number[]
  /** The person wants the next revision to cover it with a task. */
  wantsTask: boolean
}

/** A question the person answered: decided, and carried into every plan of the issue after it. */
export type ElrondDecision = { text: string; answer: string }

/** The plan the council made of one issue. */
export type ElrondPlan = {
  /** The issue as written short, `github:owner/repo#12`. */
  ref: string
  url: string
  title: string
  /** What the issue asks for, in the council's words. */
  summary: string
  /** How it will be done, in a paragraph. */
  approach: string
  tasks: ElrondTask[]
  /** What the issue leaves open, for the person to answer. */
  questions: ElrondQuestion[]
  /** What the person decided in this plan's revisions before it: handed to the council, and asked no more. */
  decided: ElrondDecision[]
  risks: ElrondRisk[]
  /** Risks the person accepted as they are: carried into every revision, and raised no more. */
  accepted: string[]
  /** When it was made, epoch milliseconds. */
  at: number
}

/** A council in session: the planner subagent studying one issue. */
export type ElrondCouncil = {
  ref: string
  url: string
  title: string
  agentId: string
  /** Who convened it: the person's command, or Claude through the tool, which is woken with the plan. */
  by: 'command' | 'tool'
  at: number
  /** What the person decided of the issue so far: the plan it lays keeps them. */
  decided?: ElrondDecision[]
  /** Risks the person accepted before it: the plan it lays keeps them. */
  accepted?: string[]
  /** The file it writes its plan to. */
  planPath?: string
  /** Whether it has laid its plan: it sits on until its turn ends. */
  isLaid?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    elrond: {
      plan: ElrondPlan | null
      council: ElrondCouncil | null
      note: string
      selected: number
      /** The issue a press asked to convene again on: the clock convenes it, outside the press. */
      wanted: string
    }
  }
}
