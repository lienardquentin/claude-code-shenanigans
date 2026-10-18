import { useState } from 'react'

type Todo = { id: number; title: string; done: boolean }

export function TodoList({ initial }: { initial: Todo[] }) {
  const [todos, setTodos] = useState(initial)

  const toggle = (id: number) =>
    setTodos((current) => current.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)))

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id}>
          <label>
            <input type="checkbox" checked={todo.done} onChange={() => toggle(todo.id)} />
            {todo.title}
          </label>
        </li>
      ))}
    </ul>
  )
}
