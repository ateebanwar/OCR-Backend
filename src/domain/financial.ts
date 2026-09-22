/**
 * Canonical Financial Document Domain Models
 * 
 * Defines the strict normalized structure for financial documents (invoices, receipts,
 * bills, purchase orders, statements, tax forms, etc.).
 * Nulls are explicit: we never invent, hallucinate, or assume missing values.
 */

export type DocumentType =
  | 'invoice'
  | 'bill'
  | 'purchase_order'
  | 'receipt'
  | 'statement'
  | 'tax_document'
  | 'accounting_document'
  | 'financial_report'
  | 'other';

export interface DocumentParty {
  name: string;
  address: string | null;
  taxId: string | null; // VAT, GST, EIN, ABN, Tax Registration Number
  email: string | null;
  phone: string | null;
  contactPerson: string | null;
}

export interface LineItem {
  lineNumber: number;
  description: string;
  sku: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  discount: number | null;
  taxRate: number | null; // e.g. 0.20 for 20%
  taxAmount: number | null;
  lineSubtotal: number | null;
  lineTotal: number;
}

export interface TaxBreakdown {
  name: string;
  rate: number | null;
  amount: number;
}

export interface FinancialTotals {
  subtotal: number | null;
  discountTotal: number | null;
  taxTotal: number | null;
  taxesBreakdown: TaxBreakdown[] | null;
  shippingCharges: number | null;
  additionalCharges: number | null;
  rounding: number | null;
  grandTotal: number;
  paidAmount: number | null;
  balanceDue: number | null;
}

export interface BankDetails {
  bankName: string | null;
  accountNumber: string | null;
  routingNumber: string | null;
  iban: string | null;
  swiftBic: string | null;
}

export interface PaymentInformation {
  paymentTerms: string | null;
  dueDate: string | null;
  paymentMethod: string | null;
  bankDetails: BankDetails | null;
  paymentReference: string | null;
}

export interface DocumentCoverageMetadata {
  totalPages: number;
  processedPages: number;
  extractedPages: number[];
  failedPages: number[];
  skippedPages: number[];
  extractionCompleteness: number; // 0.0 to 1.0
  isFullyCovered: boolean;
}

export interface CanonicalFinancialDocument {
  documentId: string;
  sourceFilename: string;
  documentHash: string; // SHA-256
  documentType: DocumentType;
  invoiceNumber: string | null;
  documentNumber: string | null;
  invoiceDate: string | null; // ISO YYYY-MM-DD or source date format
  dueDate: string | null;
  purchaseOrderNumber: string | null;
  referenceNumbers: string[];
  currency: string; // e.g. "USD", "EUR", "GBP"
  language: string | null;
  processingTimestamp: string; // ISO 8601
  
  vendor: DocumentParty | null;
  customer: DocumentParty | null;
  lineItems: LineItem[];
  totals: FinancialTotals;
  payment: PaymentInformation | null;
  coverage: DocumentCoverageMetadata;
}
