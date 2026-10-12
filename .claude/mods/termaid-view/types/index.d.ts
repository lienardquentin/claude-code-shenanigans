declare module 'claude-code' {
  interface PluginState {
    'termaid-view': {
      /** The Mermaid source of each diagram of the main conversation, in the order written. Per session. */
      diagrams: string[]
      /** Index in `diagrams` of the one the pane shows. Per session. */
      shown: number
      /** Whether the Mermaid source is shown in place of the drawing. Per session. */
      isSource: boolean
      /** What is known of each diagram at each width (key: width, NUL, source): drawn, or failed. */
      results: Record<string, { status: 'drawn'; text: string } | { status: 'failed'; reason: string }>
    }
  }
}
