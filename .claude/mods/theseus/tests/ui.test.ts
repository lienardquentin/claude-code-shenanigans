import { describe, expect, test } from 'claude-code/testing'

import { reportPage } from '../hooks/ui'

describe("a run's report", () => {
  test("is the web view's page with the run written in before its own script, no text of the run able to close it", () => {
    const page = '<!doctype html><head><title>Theseus</title></head><body><div id="root"></div><script type="module">app()</script></body>'
    const made = reportPage(page, 'github-o-r-54', { views: [{ title: 'a </script><script>alert(1)</script>' }], events: [] })

    expect(made.indexOf('window.__THESEUS_REPORT__')).toBeLessThan(made.indexOf('<script type="module">'))
    expect(made).not.toContain('</script><script>alert(1)')
    expect(made).toContain('\\u003c/script>')
    expect(() => reportPage('<p>no script</p>', 'x', { views: [], events: [] })).toThrow(/holds no script/)
  })
})
