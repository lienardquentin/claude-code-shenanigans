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
      /** Whether a drawing is closed up so that it is as narrow as it can be. Per session. */
      fit: boolean
      /** Whether the pane shows the terminal guide in place of the diagram. Per session. */
      guide: boolean
      /** Whether the diagram is drawn as a picture where the terminal can show one; the viewer's choice. Per session. */
      pictureOn: boolean
    }
  }
}
