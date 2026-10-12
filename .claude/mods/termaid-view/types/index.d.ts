declare module 'claude-code' {
  interface PluginState {
    'termaid-view': {
      /** The Mermaid source of each diagram of the main conversation, in the order written. Per session. */
      diagrams: string[]
      /** Index in `diagrams` of the one the pane shows. Per session. */
      shown: number
      /** What is known of each diagram at each width (key: width, NUL, source): being drawn, drawn, or failed. */
      results: Record<string, { status: 'rendering' } | { status: 'drawn'; text: string } | { status: 'failed'; reason: string }>
    }
  }
}
