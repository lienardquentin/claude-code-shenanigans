declare module 'claude-code' {
  interface PluginState {
    'termaid-view': {
      /** The Mermaid source of each diagram of the main conversation, in the order written. Per session. */
      diagrams: string[]
      /** Index in `diagrams` of the one the pane shows. Per session. */
      shown: number
      /** Whether the Mermaid source is shown in place of the drawing. Per session. */
      isSource: boolean
      /** The termaid theme the drawings are painted in, or `none` for termaid's plain drawing. Per session. */
      theme: string
      /** Whether a reply's diagrams are drawn in the transcript too, in place of their Mermaid block. Per session. */
      isInline: boolean
      /**
       * What is known of each diagram at each width in each theme (key: width, NUL, theme, NUL, source): drawn
       * (in a theme, with its lines run by run and the colors termaid gave them), or failed.
       */
      results: Record<
        string,
        | {
            status: 'drawn'
            text: string
            lines?: { text: string; color?: string; background?: string; bold?: boolean; italic?: boolean; dim?: boolean }[][]
          }
        | { status: 'failed'; reason: string }
      >
    }
  }
}
