import { z } from 'zod';

export const documentTypeSchema = z.enum([
  'invoice',
  'bill',
  'purchase_order',
  'receipt',
  'statement',
  'tax_document',
  'accounting_document',
  'financial_report',
  'other',
]);

export const documentPartySchema = z.object({
  name: z.string().min(1, 'Party name cannot be empty'),
  address: z.string().nullable().optional().default(null),
  taxId: z.string().nullable().optional().default(null),
  email: z.string().nullable().optional().default(null),
  phone: z.string().nullable().optional().default(null),
  contactPerson: z.string().nullable().optional().default(null),
});

export const lineItemSchema = z.object({
  lineNumber: z.number().int().nonnegative().default(1),
  description: z.string().min(1, 'Line item description is required'),
  sku: z.string().nullable().optional().default(null),
  quantity: z.number().positive('Quantity must be greater than zero').default(1),
  unit: z.string().nullable().optional().default(null),
  unitPrice: z.number().nonnegative('Unit price cannot be negative').default(0),
  discount: z.number().nonnegative().nullable().optional().default(null),
  taxRate: z.number().nonnegative().nullable().optional().default(null),
  taxAmount: z.number().nonnegative().nullable().optional().default(null),
  lineSubtotal: z.number().nullable().optional().default(null),
  lineTotal: z.number().default(0),
});

export const taxBreakdownSchema = z.object({
  name: z.string().default('Tax'),
  rate: z.number().nullable().optional().default(null),
  amount: z.number().default(0),
});

export const financialTotalsSchema = z.object({
  subtotal: z.number().nullable().optional().default(null),
  discountTotal: z.number().nullable().optional().default(null),
  taxTotal: z.number().nullable().optional().default(null),
  taxesBreakdown: z.array(taxBreakdownSchema).nullable().optional().default(null),
  shippingCharges: z.number().nullable().optional().default(null),
  additionalCharges: z.number().nullable().optional().default(null),
  rounding: z.number().nullable().optional().default(null),
  grandTotal: z.number(),
  paidAmount: z.number().nullable().optional().default(null),
  balanceDue: z.number().nullable().optional().default(null),
});

export const bankDetailsSchema = z.object({
  bankName: z.string().nullable().optional().default(null),
  accountNumber: z.string().nullable().optional().default(null),
  routingNumber: z.string().nullable().optional().default(null),
  iban: z.string().nullable().optional().default(null),
  swiftBic: z.string().nullable().optional().default(null),
});

export const paymentInfoSchema = z.object({
  paymentTerms: z.string().nullable().optional().default(null),
  dueDate: z.string().nullable().optional().default(null),
  paymentMethod: z.string().nullable().optional().default(null),
  bankDetails: bankDetailsSchema.nullable().optional().default(null),
  paymentReference: z.string().nullable().optional().default(null),
});

export const rawFinancialExtractionSchema = z.object({
  documentType: documentTypeSchema.default('invoice'),
  invoiceNumber: z.string().nullable().optional().default(null),
  documentNumber: z.string().nullable().optional().default(null),
  invoiceDate: z.string().nullable().optional().default(null),
  dueDate: z.string().nullable().optional().default(null),
  purchaseOrderNumber: z.string().nullable().optional().default(null),
  referenceNumbers: z.array(z.string()).default([]),
  currency: z.string().default('USD'),
  language: z.string().nullable().optional().default(null),
  pageCount: z.number().int().positive().optional().default(1),

  vendor: documentPartySchema.nullable().optional().default(null),
  customer: documentPartySchema.nullable().optional().default(null),
  lineItems: z.array(lineItemSchema).default([]),
  totals: financialTotalsSchema,
  payment: paymentInfoSchema.nullable().optional().default(null),
});

export type RawFinancialExtraction = z.infer<typeof rawFinancialExtractionSchema>;
