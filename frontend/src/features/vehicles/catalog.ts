import data from './layouts.json'

export type VehicleLayout = {
  id: string
  title: string
  kind: string
  capacity: number
  columns: number
  rows: (number | null)[][]
}
export const layouts: VehicleLayout[] = data.layouts
export const vehicleModels = data.models
export const findLayout = (id: unknown) => layouts.find((layout) => layout.id === id)
export const findVehicleModel = (id: unknown) => vehicleModels.find((model) => model.id === id)
