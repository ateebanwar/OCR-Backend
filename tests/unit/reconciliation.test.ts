import { describe, it, expect } from 'vitest';
import { reconcileFinancialDocument } from '../../src/reconciliation/reconciliationEngine';
import { RawFinancialExtraction } from '../../src/extraction/schemas/financialSchema';

describe('Financial Reconciliation Engine', () => {
  const createBaseDocument = (): RawFinancialExtraction => ({
    documentType: 'invoice',
    invoiceNumber: 'INV-100',
    documentNumber: null,
    invoiceDate: '2024-01-01',
    dueDate: '2024-01-31',
    purchaseOrderNumber: null,
    referenceNumbers: [],
    currency: 'USD',
    language: 'en',
    pageCount: 1,
    vendor: { name: 'Vendor Inc', address: null, taxId: null, email: null, phone: null, contactPerson: null },
    customer: { name: 'Client LLC', address: null, taxId: null, email: null, phone: null, contactPerson: null },
    lineItems: [
      {
        lineNumber: 1,
        description: 'Item A',
        sku: 'A1',
        quantity: 2,
        unit: 'ea',
        unitPrice: 50.0,
        discount: 0,
        taxRate: 0.1,
        taxAmount: 10.0,
        lineSubtotal: 100.0,
        lineTotal: 110.0,
      },
    ],
    totals: {
      subtotal: 100.0,
      discountTotal: 0,
      taxTotal: 10.0,
      taxesBreakdown: [{ name: 'Standard Tax', rate: 0.1, amount: 10.0 }],
      shippingCharges: 0,
      additionalCharges: 0,
      rounding: 0,
      grandTotal: 110.0,
      paidAmount: 0,
      balanceDue: 110.0,
    },
    payment: null,
  });

  it('1. exact totals: matches clean numbers perfectly', () => {
    const doc = createBaseDocument();
    const report = reconcileFinancialDocument(doc);

    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.discrepancies.length).toBe(0);
    expect(report.totals.grandTotalVariance).toBe(0);
  });

  it('2. decimal values: preserves precision without float inaccuracy', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Decimal Service',
        sku: null,
        quantity: 3.333,
        unit: 'hrs',
        unitPrice: 125.55,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: 418.45815,
        lineTotal: 418.46,
      },
    ];
    doc.totals.subtotal = 418.46;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = 418.46;
    doc.totals.balanceDue = 418.46;

    const report = reconcileFinancialDocument(doc, { tolerance: 0.02 });
    expect(report.isVerified).toBe(true);
  });

  it('3. tax calculations: validates tax breakdown against calculated taxes', () => {
    const doc = createBaseDocument();
    doc.lineItems[0]!.quantity = 1;
    doc.lineItems[0]!.unitPrice = 200.0;
    doc.lineItems[0]!.taxRate = 0.2;
    doc.lineItems[0]!.taxAmount = 40.0;
    doc.lineItems[0]!.lineTotal = 240.0;

    doc.totals.subtotal = 200.0;
    doc.totals.taxTotal = 40.0;
    doc.totals.taxesBreakdown = [{ name: 'VAT 20%', rate: 0.2, amount: 40.0 }];
    doc.totals.grandTotal = 240.0;
    doc.totals.balanceDue = 240.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.totals.calculatedTaxTotal).toBe(40.0);
  });

  it('4. discounts: properly subtracts discounts from line items and grand totals', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Software License',
        sku: 'SW-1',
        quantity: 1,
        unit: 'license',
        unitPrice: 1000.0,
        discount: 200.0, // $200 discount
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: 800.0,
        lineTotal: 800.0,
      },
    ];
    doc.totals.subtotal = 1000.0;
    doc.totals.discountTotal = 200.0;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = 800.0;
    doc.totals.balanceDue = 800.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
  });

  it('5. negative values: handles negative numbers such as returns or credit memos', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Returned Hardware',
        sku: 'RET-01',
        quantity: 1,
        unit: 'ea',
        unitPrice: -150.0,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: -150.0,
        lineTotal: -150.0,
      },
    ];
    doc.totals.subtotal = -150.0;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = -150.0;
    doc.totals.balanceDue = -150.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
  });

  it('6. rounding: accepts variance within configured tolerance (+/- 0.02)', () => {
    const doc = createBaseDocument();
    // 100.00 + 10.00 = 110.00, but document says 110.01 due to rounding
    doc.totals.grandTotal = 110.01;

    const report = reconcileFinancialDocument(doc, { tolerance: 0.02 });
    expect(report.overallStatus).toBe('ACCEPTABLE_ROUNDING');
    expect(report.isVerified).toBe(true);
  });

  it('7. multiple tax rates: handles different items with different tax rates', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Food Item (Zero-rated)',
        sku: 'FOOD',
        quantity: 1,
        unit: 'ea',
        unitPrice: 50.0,
        discount: 0,
        taxRate: 0.0,
        taxAmount: 0.0,
        lineSubtotal: 50.0,
        lineTotal: 50.0,
      },
      {
        lineNumber: 2,
        description: 'Standard Item (20% VAT)',
        sku: 'STD',
        quantity: 1,
        unit: 'ea',
        unitPrice: 100.0,
        discount: 0,
        taxRate: 0.2,
        taxAmount: 20.0,
        lineSubtotal: 100.0,
        lineTotal: 120.0,
      },
    ];
    doc.totals.subtotal = 150.0;
    doc.totals.taxTotal = 20.0;
    doc.totals.grandTotal = 170.0;
    doc.totals.balanceDue = 170.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
  });

  it('8. multiple line items: accurately sums across many items', () => {
    const doc = createBaseDocument();
    doc.lineItems = Array.from({ length: 10 }, (_, i) => ({
      lineNumber: i + 1,
      description: `Item ${i + 1}`,
      sku: `SKU-${i + 1}`,
      quantity: 2,
      unit: 'ea',
      unitPrice: 10.0,
      discount: 0,
      taxRate: 0,
      taxAmount: 0,
      lineSubtotal: 20.0,
      lineTotal: 20.0,
    }));
    doc.totals.subtotal = 200.0;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = 200.0;
    doc.totals.balanceDue = 200.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.totals.calculatedSubtotal).toBe(200.0);
  });

  it('9. missing subtotal: derives subtotal from line items when document lacks explicit subtotal', () => {
    const doc = createBaseDocument();
    doc.totals.subtotal = null;

    const report = reconcileFinancialDocument(doc);
    expect(report.totals.calculatedSubtotal).toBe(100.0);
    expect(report.isVerified).toBe(true);
    expect(report.auditNotes.some(n => n.includes('Subtotal was not explicitly provided'))).toBe(true);
  });

  it('10. missing tax: handles documents without tax fields (tax exempt or zero)', () => {
    const doc = createBaseDocument();
    doc.lineItems[0]!.taxRate = null;
    doc.lineItems[0]!.taxAmount = null;
    doc.lineItems[0]!.lineTotal = 100.0;
    doc.totals.taxTotal = null;
    doc.totals.taxesBreakdown = null;
    doc.totals.grandTotal = 100.0;
    doc.totals.balanceDue = 100.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.totals.calculatedTaxTotal).toBe(0);
  });

  it('11. inconsistent grand total: flags discrepancy when numbers do not reconcile', () => {
    const doc = createBaseDocument();
    doc.totals.grandTotal = 999.99; // completely arbitrary hallucination or misread

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.discrepancies.length).toBeGreaterThan(0);
    expect(report.discrepancies[0]).toContain('Grand total discrepancy');
  });

  it('12. duplicate line items: correctly accounts for items with identical descriptions', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Consulting Hour',
        sku: 'CON-01',
        quantity: 1,
        unit: 'hr',
        unitPrice: 150.0,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: 150.0,
        lineTotal: 150.0,
      },
      {
        lineNumber: 2,
        description: 'Consulting Hour',
        sku: 'CON-01',
        quantity: 1,
        unit: 'hr',
        unitPrice: 150.0,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: 150.0,
        lineTotal: 150.0,
      },
    ];
    doc.totals.subtotal = 300.0;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = 300.0;
    doc.totals.balanceDue = 300.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.lineItems.length).toBe(2);
  });

  it('13. currency differences: respects currency across metadata without changing values', () => {
    const doc = createBaseDocument();
    doc.currency = 'EUR';

    const report = reconcileFinancialDocument(doc);
    expect(report.isVerified).toBe(true);
  });

  it('14. zero-value line items: allows promotional or 100% discounted lines safely', () => {
    const doc = createBaseDocument();
    doc.lineItems.push({
      lineNumber: 2,
      description: 'Free Promotional Gift',
      sku: 'GIFT-01',
      quantity: 1,
      unit: 'ea',
      unitPrice: 0.0,
      discount: 0,
      taxRate: 0,
      taxAmount: 0,
      lineSubtotal: 0.0,
      lineTotal: 0.0,
    });
    // Totals remain unchanged
    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
  });

  it('15. large monetary values: handles high-value corporate invoices without overflow', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Enterprise Data Center Acquisition',
        sku: 'DC-ACQ',
        quantity: 1,
        unit: 'unit',
        unitPrice: 125000000.50,
        discount: 0,
        taxRate: 0.05,
        taxAmount: 6250000.025,
        lineSubtotal: 125000000.50,
        lineTotal: 131250000.525,
      },
    ];
    doc.totals.subtotal = 125000000.50;
    doc.totals.taxTotal = 6250000.03;
    doc.totals.grandTotal = 131250000.53;
    doc.totals.balanceDue = 131250000.53;

    const report = reconcileFinancialDocument(doc, { tolerance: 0.05 });
    expect(report.isVerified).toBe(true);
  });
});
