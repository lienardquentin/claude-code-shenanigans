declare module 'claude-code' {
  interface PluginState {
    'ship-flow': {
      /** How many times a run of this session wrote a ticket's state or its record: the pane redraws on each. */
      changes: number
    }
  }
}
