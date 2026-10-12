declare module 'claude-code' {
  interface PluginState {
    'termaid-view': {
      /** The Mermaid source of each diagram of the main conversation, in the order written. Per session. */
      diagrams: string[]
      /** Index in `diagrams` of the one the pane shows. Per session. */
      shown: number
      /** Whether the Mermaid source is shown in place of the drawing. Per session. */
      isSource: boolean
      /** The termaid theme picked in the pane, `none` for termaid's plain drawing, or empty while none is picked. Per session. */
      theme: string
      /** Whether a reply's diagrams are drawn in the transcript too, in place of their Mermaid block. Per session. */
      isInline: boolean
      /**
       * The way each flowchart is laid out when the person chose one (key: the diagram's source; value: `TD`, `LR`,
       * `BT`, or `as written`). Per session.
       */
      directions: Record<string, string>
      /**
       * What a linked node opened in the pane, in place of the diagrams: lines of a file, the file's uncommitted
       * changes, or why neither can be shown; `null` while the diagrams are shown. Per session.
       */
      opened:
        | { link: string; path: string; kind: 'code'; first: number; total: number; text: string }
        | { link: string; path: string; kind: 'diff'; text: string; isCut: boolean }
        | { link: string; reason: string }
        | null
      /**
       * What is known of each diagram at each width in each theme (key: width, NUL, theme, NUL, source): drawn
       * (in a theme or with linked nodes, with its lines run by run, the colors termaid gave them and the link of
       * the runs of a linked node), or failed.
       */
      results: Record<
        string,
        | {
            status: 'drawn'
            text: string
            lines?: { text: string; color?: string; background?: string; bold?: boolean; italic?: boolean; dim?: boolean; link?: string }[][]
          }
        | { status: 'failed'; reason: string }
      >
    }
  }
}
