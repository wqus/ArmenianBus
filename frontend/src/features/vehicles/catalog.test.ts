import { expect, it } from 'vitest'
import { findLayout, layouts, vehicleModels } from './catalog'

it('each versioned layout places exactly its capacity of unique consecutive seats', () => {
  for (const layout of layouts) {
    const numbers = layout.rows.flat().filter((n) => n !== null)
    expect(numbers).toHaveLength(layout.capacity)
    expect(new Set(numbers).size).toBe(layout.capacity)
    expect([...numbers].sort((a, b) => a - b)).toEqual(
      Array.from({ length: layout.capacity }, (_, i) => i + 1),
    )
    expect(layout.rows.every((row) => row.length === layout.columns)).toBe(true)
  }
  for (const model of vehicleModels) {
    if (model.recommended_layout_id) expect(findLayout(model.recommended_layout_id)).toBeDefined()
  }
})
