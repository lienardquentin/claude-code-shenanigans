/** A diagram the session has seen: its Mermaid source, and the words that tell it apart in the list. */
export type HistoryEntry = {
  source: string
  title: string
}

declare module 'claude-code' {
  interface PluginState {
    'mermaid-view': {
      /** The Mermaid source of the diagram the pane shows; empty shows none. Per session. */
      source: string
      /** Id of the selected node; empty when none is. Per session. */
      selected: string
      /** The diagrams seen this session, oldest first. Per session; nothing is stored beyond it. */
      history: HistoryEntry[]
      /** How many cells a drawing wider than the pane is moved to the left. Per session. */
      scrollX: number
      /** How many rows a drawing taller than the pane's room is moved up. Per session. */
      scrollY: number
      /** Whether a drawing is closed up so that it is as narrow as it can be. Per session. */
      fit: boolean
      /** Whether the pane shows the terminal guide in place of the diagram. Per session. */
      guide: boolean
      /** The picture of the drawing: on where the terminal is known to draw pixels, tried in any terminal, or off. Per session. */
      pictureMode: 'auto' | 'on' | 'off'
    }
  }
}
