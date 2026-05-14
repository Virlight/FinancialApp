export function formatPrice(price, currency = "EUR") {
  const amount = Number(price);

  if (!Number.isFinite(amount)) {
    return null;
  }

  return `${amount.toFixed(2)} ${currency}`;
}
