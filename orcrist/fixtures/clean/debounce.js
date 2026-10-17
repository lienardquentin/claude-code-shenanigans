// Waits until the calls stop for `delay` milliseconds, then runs `run` once with the last arguments
export function debounce(run, delay) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => run(...args), delay)
  }
}

export const once = (run) => {
  let called = false
  let result
  return (...args) => {
    if (!called) {
      called = true
      result = run(...args)
    }
    return result
  }
}
