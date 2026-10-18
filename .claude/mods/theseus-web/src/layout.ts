import ELK from 'elkjs/lib/elk.bundled.js'

import type { Snapshot } from './api'

// Where each node of a run's graph sits: the issue, each task after those it depends on, and the pull request after
// every task nothing depends on, laid out left to right by ELK's layered algorithm.

export type Placed = { id: string; x: number; y: number; width: number; height: number }
export type Link = { id: string; source: string; target: string }

const elk = new ELK()
export const TASK = { width: 272, height: 128 }
export const END = { width: 196, height: 84 }

/** The edges of a run's graph. */
export const linksOf = (view: Pick<Snapshot, 'tasks'>): Link[] => {
  const ids = new Set(view.tasks.map(task => task.id))
  const depended = new Set(view.tasks.flatMap(task => task.dependsOn))
  const link = (source: string, target: string): Link => ({ id: `${source}->${target}`, source, target })

  return [
    ...view.tasks.flatMap(task => {
      const before = task.dependsOn.filter(id => ids.has(id))

      return before.length === 0 ? [link('issue', `task-${task.id}`)] : before.map(id => link(`task-${id}`, `task-${task.id}`))
    }),
    ...view.tasks.filter(task => !depended.has(task.id)).map(task => link(`task-${task.id}`, 'pr')),
    ...(view.tasks.length === 0 ? [link('issue', 'pr')] : []),
  ]
}

/** Lays a run's graph out: where each node sits. */
export const layOut = async (view: Pick<Snapshot, 'tasks'>): Promise<Placed[]> => {
  const children = [{ id: 'issue', ...END }, ...view.tasks.map(task => ({ id: `task-${task.id}`, ...TASK })), { id: 'pr', ...END }]
  const laid = await elk.layout({
    id: 'run',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT', 'elk.layered.spacing.nodeNodeBetweenLayers': '64', 'elk.spacing.nodeNode': '28', 'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF' },
    children,
    edges: linksOf(view).map(one => ({ id: one.id, sources: [one.source], targets: [one.target] })),
  })

  return (laid.children ?? []).map(child => ({ id: child.id, x: child.x ?? 0, y: child.y ?? 0, width: child.width ?? 0, height: child.height ?? 0 }))
}
