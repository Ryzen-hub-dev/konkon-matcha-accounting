/** Wait for generated QR images so an early print click cannot produce a blank code. */
export async function printReceipt() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const codes = Array.from(document.querySelectorAll("[data-receipt-qr], [data-print-qr]"));
    if (codes.every(code => { const image = code.querySelector("img"); return image?.complete && image.naturalWidth > 0; })) {
      await document.fonts.ready;
      window.print();
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("The receipt QR is still loading. Please try printing again.");
}
