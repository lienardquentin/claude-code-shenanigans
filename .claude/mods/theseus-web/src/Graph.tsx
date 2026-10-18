import { Background, Handle, Position, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import type { Edge, Node, NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { motion } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'

import { STEPS } from '../../theseus/core/view'
import type { TaskView } from '../../theseus/core/view'
import type { Snapshot } from './api'
import { durationOf } from './format'
import { END, TASK, layOut, linksOf } from './layout'
import type { Placed } from './layout'

// The run as a graph: the issue, each task as a card with its five steps, and the pull request. The layout is ELK's,
// redone only when the tasks or their order change; a step that moves animates where it is.

const STANDING_CLASS: Record<TaskView['standing'], string> = { queued: 'queued', ready: 'ready', running: 'running', waiting: 'waiting', stopped: 'stopped', done: 'done', 'handed back': 'handed' }

type TaskData = { task: TaskView; isSelected: boolean; now: number }
type EndData = { label: string; title: string; standing: 'done' | 'running' | 'queued'; foot: string; isSelected: boolean }

function TaskNode({ data }: NodeProps<Node<TaskData>>) {
  const { task, isSelected, now } = data
  const kind = STANDING_CLASS[task.standing]
  const foot = task.sha !== '' ? `Committed ${task.sha}` : task.why !== '' ? task.why : task.standing === 'running' ? `${task.builder}${task.sentAt > 0 ? ` · ${durationOf(now - task.sentAt)}` : ''}` : task.standing

  return (
    <motion.div layout className={`node ${kind}${isSelected ? ' sel' : ''}`} data-task={task.id} initial={false} animate={{ opacity: 1 }}>
      <Handle type="target" position={Position.Left} />
      <div className="n-head">
        <motion.span key={kind} className={`glyph ${kind}`} initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 18 }} />
        <span className="id">{`T${task.id}`}</span>
        {task.isLane && <span className="chip">lane</span>}
        <span className="chip">{task.weight}</span>
        <span className="spacer" />
        {task.attempt > 1 && <span className="attempt">{`try ${task.attempt}`}</span>}
      </div>
      <div className="n-title">{task.title}</div>
      <div className="strip">
        {STEPS.map(step => (
          <div key={step} className={`seg ${task.steps[step]}`} data-step={step} data-state={task.steps[step]}>
            <div className="bar" />
            <div className="lab">{step}</div>
          </div>
        ))}
      </div>
      <div className={`n-foot${task.standing === 'stopped' ? ' fail' : task.standing === 'waiting' || task.standing === 'handed back' ? ' wait' : ''}`}>{foot}</div>
      <Handle type="source" position={Position.Right} />
    </motion.div>
  )
}

function EndNode({ data }: NodeProps<Node<EndData>>) {
  return (
    <div className={`node end ${data.standing}${data.isSelected ? ' sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="n-head">
        <span className={`glyph ${data.standing}`} />
        <span className="id">{data.label}</span>
      </div>
      <div className="n-title">{data.title}</div>
      <div className="n-foot">{data.foot}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const NODE_TYPES = { task: TaskNode, end: EndNode }

function Flow({ view, selected, onSelect, now }: { view: Snapshot; selected: number | null; onSelect: (id: number | null) => void; now: number }) {
  const [placed, setPlaced] = useState<Placed[]>([])
  const shape = view.tasks.map(task => `${task.id}:${task.dependsOn.join(',')}`).join('|')

  useEffect(() => {
    let isCurrent = true

    void layOut(view).then(found => {
      if (isCurrent) setPlaced(found)
    })

    return () => {
      isCurrent = false
    }
    // The layout follows the graph's shape alone, not each step's state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape])

  const nodes = useMemo((): Node[] => {
    const at = (id: string) => placed.find(one => one.id === id) ?? { x: 0, y: 0 }
    const allDone = view.tasks.length > 0 && view.tasks.every(task => task.standing === 'done')

    return [
      { id: 'issue', type: 'end', position: at('issue'), data: { label: 'Issue', title: view.title, standing: 'done', foot: view.ref, isSelected: false } satisfies EndData, style: { width: END.width } },
      ...view.tasks.map((task): Node => ({ id: `task-${task.id}`, type: 'task', position: at(`task-${task.id}`), data: { task, isSelected: selected === task.id, now } satisfies TaskData, style: { width: TASK.width } })),
      {
        id: 'pr',
        type: 'end',
        position: at('pr'),
        data: { label: 'Pull request', title: view.pr !== '' ? view.pr.replace(/^https?:\/\//, '') : view.branch, standing: view.pr !== '' ? 'done' : allDone ? 'running' : 'queued', foot: view.pr !== '' ? 'Opened' : allDone ? 'Ready to submit' : `${view.done}/${view.total} tasks done`, isSelected: false } satisfies EndData,
        style: { width: END.width },
      },
    ]
  }, [placed, view, selected, now])

  const edges = useMemo((): Edge[] => {
    const standing = (id: string) => (id === 'issue' ? 'done' : id === 'pr' ? (view.pr !== '' ? 'done' : 'queued') : (view.tasks.find(task => `task-${task.id}` === id)?.standing ?? 'queued'))

    return linksOf(view).map(link => {
      const from = standing(link.source)
      const to = standing(link.target)
      const className = from === 'done' && to === 'done' ? 'done' : from === 'done' && to === 'running' ? 'flow' : from === 'done' && to === 'waiting' ? 'wait' : ''

      return { ...link, type: 'smoothstep', animated: className === 'flow' || className === 'wait', className }
    })
  }, [view])

  // The graph is drawn once laid out, and drawn afresh when its shape changes: React Flow fits it to the pane as it
  // first measures it, never past the nodes' own size
  if (placed.length === 0) return null

  return (
    <ReactFlow
      key={shape}
      fitView
      fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelect(node.id.startsWith('task-') ? Number(node.id.slice(5)) : null)}
      onPaneClick={() => onSelect(null)}
      minZoom={0.3}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} size={1} />
    </ReactFlow>
  )
}

export function Graph(props: { view: Snapshot; selected: number | null; onSelect: (id: number | null) => void; now: number }) {
  return (
    <div className="panel graph" aria-label="Run graph">
      <ReactFlowProvider>
        <Flow {...props} />
      </ReactFlowProvider>
    </div>
  )
}
