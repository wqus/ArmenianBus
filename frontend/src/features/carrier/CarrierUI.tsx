import { Button, Notice } from '../../shared/ui'
export function Pager({
  offset,
  next,
  change,
}: {
  offset: number
  next: boolean
  change: (offset: number) => void
}) {
  return (
    <nav className="search-pagination" aria-label="Страницы списка">
      {offset > 0 && (
        <Button type="button" variant="secondary" onClick={() => change(offset - 20)}>
          Предыдущая страница
        </Button>
      )}
      {(offset > 0 || next) && <span>Страница {offset / 20 + 1}</span>}
      {next && offset < 10000 && (
        <Button type="button" variant="secondary" onClick={() => change(offset + 20)}>
          Следующая страница
        </Button>
      )}
    </nav>
  )
}
export function WriteResult({ message }: { message: string }) {
  return message ? (
    <Notice title="Результат операции" error>
      {message}
    </Notice>
  ) : null
}
