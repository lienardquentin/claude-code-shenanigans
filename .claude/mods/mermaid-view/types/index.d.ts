declare module 'claude-code' {
  interface PluginState {
    'mermaid-view': {
      /** The Mermaid source of the diagram the pane shows; empty shows none. Per session. */
      source: string
      /** Id of the selected node; empty when none is. Per session. */
      selected: string
    }
  }
}
