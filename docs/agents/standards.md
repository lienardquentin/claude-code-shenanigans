# What a change must not hold

Theseus's reviewers judge every settled change by this file (`standards=` in `.claude/verify`), and a builder
writes to it. Each entry is about what the change does, not about code it leaves as it was.

## Blocking

- **An error swallowed or hidden.** A `catch` that drops the failure, a fallback or default that answers as if nothing
  went wrong, where the caller or the person needed to know.
- **A test that passes with the behaviour broken.** It asserts on its own mocks, asserts nothing that the change
  decides, or was loosened until it passed.
- **A claim the code does not back.** A comment, doc, commit message or answer that says the change does something it
  does not, or that it was checked when it was not.
- **A change the task did not ask for.** Reformatting, renaming, or rewriting code beyond what the purpose needs.

## Minor

- **A comment that restates the code**, or tells the story of the change ("now uses", "changed from", "new helper").
- **An abstraction with one user**: a factory, interface, option or parameter no caller needs yet.
- **Defence against what cannot happen**: checks, `try` blocks and fallbacks for states the code never reaches.
- **A helper that duplicates one the project already has.**
- **Code that does not read like its neighbours**: other naming, idiom or comment density than the code around it.
- **Filler in prose**: hedges, summaries of what was just said, headings and bullets on what is a sentence.
