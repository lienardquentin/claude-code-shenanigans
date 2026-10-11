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
    }
  }
}
