export interface LineItem {
  sku: string
  quantity: number
  unitPrice: number
}

export const subtotal = (items: readonly LineItem[]): number =>
  items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)

export const withDiscount = (amount: number, percent: number): number => {
  if (percent < 0 || percent > 100) {
    throw new RangeError(`a discount of ${percent}% is out of range`)
  }
  return amount * (1 - percent / 100)
}

export const formatPrice = (cents: number, currency = 'EUR'): string =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100)

export async function loadCart(fetchCart: () => Promise<Response>): Promise<LineItem[]> {
  const response = await fetchCart()
  if (!response.ok) {
    throw new Error(`the cart could not be loaded: ${response.status}`)
  }
  return (await response.json()) as LineItem[]
}
