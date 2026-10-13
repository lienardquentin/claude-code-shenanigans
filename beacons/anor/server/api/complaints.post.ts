type Complaint = { message?: unknown; stack?: unknown; where?: unknown }

// What goes wrong in the browser is said here, so it is in the log with the rest: the error, then its stack in
// plain lines under it.
export default defineEventHandler(async event => {
  const { message, stack, where } = (await readBody<Complaint>(event)) ?? {}
  const frames = String(stack ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('at ') || line.includes('@'))
    .slice(0, 12)
    .map(frame => frame.slice(0, 200))

  herald('error', `the page faltered: ${String(message ?? 'unknown error').slice(0, 300)}`, { where: String(where ?? '').slice(0, 80) }, frames)

  setResponseStatus(event, 204)

  return null
})
