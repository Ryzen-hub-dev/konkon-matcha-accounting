"use client";
import { useEffect, useState } from "react";
import { cartQuantity } from "@/lib/scan-codes";
export function CartQuantityInput({ quantity, stock, name, onCommit }: { quantity: number; stock: number; name: string; onCommit: (quantity: number) => void }) {
  const [text, setText] = useState(String(quantity));
  const [error, setError] = useState(false);
  useEffect(() => { setText(String(quantity)); setError(false); }, [quantity]);
  function commit() { const next = cartQuantity(text, stock); if (next === null) { setError(true); setText(String(quantity)); return; } setError(false); onCommit(next); }
  return <input className="cart-quantity-input" aria-label={`${name} quantity`} aria-invalid={error} title={`Enter a whole quantity from 1 to ${Math.min(999, stock)}`} inputMode="numeric" value={text} onFocus={event => event.currentTarget.select()} onChange={event => { setText(event.target.value); setError(false); }} onBlur={commit} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } if (event.key === "Escape") { setText(String(quantity)); setError(false); } }} />;
}
