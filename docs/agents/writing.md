# How Theseus writes to people

Every word a person reads from Theseus (toasts, command answers, pane text, the help) follows these rules. Text
written for Claude or for an agent (tool descriptions, prompts, prompt sections) follows the first three.

1. **Lead with what happened**, then why, then what to do: `Build stopped on task 3: the proof failed (mypy). Fix it
   in the worktree, then /theseus build commit.`
2. **Name the next step as the command that does it**, spelled as typed: `/theseus doctor`, never "the doctor says".
3. **Plain words, present tense, active voice.** Started, waiting, stopped, done, failed. No metaphor, no story.
4. **Speak to the reader as "you".** "The person" is for text Claude reads about the person.
5. **One prefix per part**, the same everywhere: `Theseus:`, `Plan:`, `Build:`, `Tests first:`, `Verify:`,
   `Follow-up:`, `Cleanup:`, `Issues:`.
6. **Say where to look only when there is something to see**: "See the build pane" when the pane holds more than the
   message, not after every command.
7. **An error says what failed and how to fix it**, without apology: `gh is not signed in to github.com: run gh auth
   login --hostname github.com.`

Words to avoid in what a person reads: "is said", "stumbled", "sets out", "makes ready", "how it went", "the person",
"behold", "sail", "quest".
