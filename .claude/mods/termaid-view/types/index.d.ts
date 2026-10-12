declare module 'claude-code' {
  interface PluginState {
    'termaid-view': {
      /** The Mermaid source of each diagram of the main conversation, in the order written. Per session. */
      diagrams: string[]
      /** Index in `diagrams` of the one the pane shows. Per session. */
      shown: number
    }
  }
}
