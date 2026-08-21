import { InvoiceDocumentView } from "@/components/invoice-document-view";

export const metadata = { title: "Invoice paper" };

export default async function InvoiceDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceDocumentView id={id} />;
}
