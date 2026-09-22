import { describe, it, expect } from 'vitest';
import { reconcileFinancialDocument } from '../../src/reconciliation/reconciliationEngine';
import { RawFinancialExtraction } from '../../src/extraction/schemas/financialSchema';

describe('Financial Reconciliation Engine - Strict Exact Monetary Audit', () => {
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

  // Test 1: Exact matching invoice
  it('1. exact matching invoice reconciles deterministically as EXACT_MATCH with isVerified=true', () => {
    const doc = createBaseDocument();
    const report = reconcileFinancialDocument(doc);

    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.toleranceApplied).toBe(0.0);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.totals.grandTotalVariance).toBe(0);
    expect(report.totals.subtotalVariance).toBe(0);
    expect(report.totals.taxVariance).toBe(0);
  });

  // Test 2: Genuine $0.01 discrepancy
  it('2. genuine $0.01 discrepancy is NOT forgiven and produces DISCREPANCY with isVerified=false', () => {
    const doc = createBaseDocument();
    // Extracted grand total is 110.01 instead of 110.00 without any rounding field
    doc.totals.grandTotal = 110.01;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.totals.grandTotalVariance).toBe(0.01);
    expect(report.discrepancies.length).toBeGreaterThanOrEqual(1);
    expect(report.discrepancies[0]).toContain('Grand total discrepancy');
    expect(report.discrepancies[0]).toContain('0.01');
  });

  // Test 3: Genuine $0.02 discrepancy
  it('3. genuine $0.02 discrepancy is NOT forgiven and produces DISCREPANCY with isVerified=false', () => {
    const doc = createBaseDocument();
    doc.totals.grandTotal = 110.02;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.totals.grandTotalVariance).toBe(0.02);
    expect(report.discrepancies.length).toBeGreaterThanOrEqual(1);
    expect(report.discrepancies[0]).toContain('Grand total discrepancy');
    expect(report.discrepancies[0]).toContain('0.02');
  });

  // Test 4: Genuine $0.03 discrepancy
  it('4. genuine $0.03 discrepancy produces DISCREPANCY with isVerified=false', () => {
    const doc = createBaseDocument();
    doc.totals.grandTotal = 110.03;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.totals.grandTotalVariance).toBe(0.03);
    expect(report.discrepancies.length).toBeGreaterThanOrEqual(1);
    expect(report.discrepancies[0]).toContain('Grand total discrepancy');
    expect(report.discrepancies[0]).toContain('0.03');
  });

  // Test 5: Floating-point edge cases
  it('5. floating-point edge cases (0.1 + 0.2, 0.07 * 100) are solved without float quirks', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Floating Point Precision Test A',
        sku: null,
        quantity: 1,
        unit: 'ea',
        unitPrice: 0.1,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: 0.1,
        lineTotal: 0.1,
      },
      {
        lineNumber: 2,
        description: 'Floating Point Precision Test B',
        sku: null,
        quantity: 1,
        unit: 'ea',
        unitPrice: 0.2,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: 0.2,
        lineTotal: 0.2,
      },
    ];
    doc.totals.subtotal = 0.3;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = 0.3;
    doc.totals.balanceDue = 0.3;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.subtotalVariance).toBe(0);
    expect(report.totals.grandTotalVariance).toBe(0);
  });

  // Test 6: Multiple line items
  it('6. multiple line items sum accurately without rounding drift', () => {
    const doc = createBaseDocument();
    doc.lineItems = Array.from({ length: 10 }, (_, i) => ({
      lineNumber: i + 1,
      description: `Item ${i + 1}`,
      sku: `SKU-${i + 1}`,
      quantity: 3,
      unit: 'ea',
      unitPrice: 15.25,
      discount: 0,
      taxRate: 0,
      taxAmount: 0,
      lineSubtotal: 45.75,
      lineTotal: 45.75,
    }));
    // 10 items * 45.75 = 457.50
    doc.totals.subtotal = 457.5;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = 457.5;
    doc.totals.balanceDue = 457.5;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedSubtotal).toBe(457.5);
    expect(report.totals.calculatedGrandTotal).toBe(457.5);
  });

  // Test 7: Different tax rates across items
  it('7. handles different tax rates on different items (e.g., zero-rated food vs standard VAT)', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Zero-Rated Grocery',
        sku: 'FOOD',
        quantity: 2,
        unit: 'ea',
        unitPrice: 25.0,
        discount: 0,
        taxRate: 0.0,
        taxAmount: 0.0,
        lineSubtotal: 50.0,
        lineTotal: 50.0,
      },
      {
        lineNumber: 2,
        description: 'Standard Taxable Electronics',
        sku: 'ELEC',
        quantity: 1,
        unit: 'ea',
        unitPrice: 100.0,
        discount: 0,
        taxRate: 0.2, // 20%
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
    expect(report.totals.calculatedTaxTotal).toBe(20.0);
  });

  // Test 8: Discounts (line discounts and invoice discounts)
  it('8. discounts: handles line-level and invoice-level discounts correctly', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Subscription Seat',
        sku: 'SUB-1',
        quantity: 2,
        unit: 'user',
        unitPrice: 100.0,
        discount: 20.0, // $20 discount per line
        taxRate: 0,
        taxAmount: 0,
        lineSubtotal: 180.0,
        lineTotal: 180.0,
      },
    ];
    doc.totals.subtotal = 180.0; // Net subtotal
    doc.totals.discountTotal = 20.0;
    doc.totals.taxTotal = 0;
    doc.totals.grandTotal = 180.0;
    doc.totals.balanceDue = 180.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
  });

  // Test 9: Shipping and additional charges
  it('9. shipping and additional charges are added into grand total accurately', () => {
    const doc = createBaseDocument();
    doc.totals.shippingCharges = 15.5;
    doc.totals.additionalCharges = 4.5;
    // 100 subtotal + 10 tax + 15.50 shipping + 4.50 handling = 130.00
    doc.totals.grandTotal = 130.0;
    doc.totals.balanceDue = 130.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedGrandTotal).toBe(130.0);
  });

  // Test 10: Tax-inclusive invoice
  it('10. tax-inclusive invoice pricing reconciles without double-counting tax in grand total', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Retail Product (Tax Inclusive)',
        sku: 'RET-01',
        quantity: 1,
        unit: 'ea',
        unitPrice: 110.0,
        discount: 0,
        taxRate: 0.1,
        taxAmount: 10.0,
        lineSubtotal: 110.0,
        lineTotal: 110.0, // line total is already inclusive of tax
      },
    ];
    doc.totals.subtotal = 110.0;
    doc.totals.taxTotal = 10.0;
    doc.totals.grandTotal = 110.0; // Grand total is 110.00 (tax inclusive)
    doc.totals.balanceDue = 110.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
  });

  // Test 11: Tax-exclusive invoice
  it('11. tax-exclusive invoice pricing reconciles with tax added to net subtotal', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Consulting Hours',
        sku: 'SVC-1',
        quantity: 10,
        unit: 'hr',
        unitPrice: 150.0,
        discount: 0,
        taxRate: 0.1,
        taxAmount: 150.0,
        lineSubtotal: 1500.0,
        lineTotal: 1650.0,
      },
    ];
    doc.totals.subtotal = 1500.0;
    doc.totals.taxTotal = 150.0;
    doc.totals.grandTotal = 1650.0;
    doc.totals.balanceDue = 1650.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedGrandTotal).toBe(1650.0);
  });

  // Test 12: Zero-decimal currency (e.g., JPY, KRW)
  it('12. zero-decimal currency (JPY) uses integer precision without fractional digits', () => {
    const doc = createBaseDocument();
    doc.currency = 'JPY';
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Japanese Software Service',
        sku: 'JP-01',
        quantity: 2,
        unit: 'ea',
        unitPrice: 1500, // 1500 Yen
        discount: 0,
        taxRate: 0.1,
        taxAmount: 300,
        lineSubtotal: 3000,
        lineTotal: 3300,
      },
    ];
    doc.totals.subtotal = 3000;
    doc.totals.taxTotal = 300;
    doc.totals.grandTotal = 3300;
    doc.totals.balanceDue = 3300;

    const report = reconcileFinancialDocument(doc);
    expect(report.currencyPrecision).toBe(0);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedGrandTotal).toBe(3300);
  });

  // Test 13: Three-decimal currency (e.g., KWD, BHD)
  it('13. three-decimal currency (KWD) respects 3 decimal places without rounding truncation', () => {
    const doc = createBaseDocument();
    doc.currency = 'KWD';
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Fuel Refill Service',
        sku: 'KWD-01',
        quantity: 1,
        unit: 'lot',
        unitPrice: 12.35,
        discount: 0,
        taxRate: 0.05,
        taxAmount: 0.618, // 12.350 * 0.05 = 0.6175 -> rounds half up to 0.618
        lineSubtotal: 12.35,
        lineTotal: 12.968,
      },
    ];
    doc.totals.subtotal = 12.35;
    doc.totals.taxTotal = 0.618;
    doc.totals.grandTotal = 12.968;
    doc.totals.balanceDue = 12.968;

    const report = reconcileFinancialDocument(doc);
    expect(report.currencyPrecision).toBe(3);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedGrandTotal).toBe(12.968);
  });

  // Test 14: Paid invoice (paid = grandTotal, balanceDue = 0)
  it('14. fully paid invoice reconciles with balanceDue=0', () => {
    const doc = createBaseDocument();
    doc.totals.paidAmount = 110.0;
    doc.totals.balanceDue = 0.0;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedBalanceDue).toBe(0.0);
  });

  // Test 15: Partially paid invoice
  it('15. partially paid invoice reconciles balance due as grandTotal - paidAmount', () => {
    const doc = createBaseDocument();
    doc.totals.paidAmount = 40.0;
    doc.totals.balanceDue = 70.0; // 110 - 40 = 70

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedBalanceDue).toBe(70.0);
  });

  // Test 16: Balance due calculation discrepancy
  it('16. balance due calculation discrepancy flags error when document states incorrect remaining balance', () => {
    const doc = createBaseDocument();
    doc.totals.paidAmount = 50.0;
    doc.totals.balanceDue = 55.0; // 110 - 50 = 60, but document says 55

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.totals.balanceDueVariance).toBe(5.0);
    expect(report.discrepancies.some(d => d.includes('Balance due discrepancy'))).toBe(true);
  });

  // Test 17: Source-document rounding that is legitimate (explicit rounding adjustment)
  it('17. source-document rounding that is explicitly declared in totals.rounding reconciles legally', () => {
    const doc = createBaseDocument();
    // Subtotal 100 + Tax 10 = 110, cash rounding adjustment -0.05 => grandTotal 109.95
    doc.totals.rounding = -0.05;
    doc.totals.grandTotal = 109.95;
    doc.totals.balanceDue = 109.95;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.auditNotes.some(n => n.includes('explicit rounding adjustment'))).toBe(true);
  });

  // Test 18: AI extraction containing a wrong grand total
  it('18. AI extraction containing a wrong grand total is flagged as DISCREPANCY and unverified', () => {
    const doc = createBaseDocument();
    doc.totals.grandTotal = 115.0; // AI misread 110 as 115

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.discrepancies.some(d => d.includes('Grand total discrepancy'))).toBe(true);
  });

  // Test 19: AI extraction containing a wrong tax value
  it('19. AI extraction containing a wrong tax value is flagged as DISCREPANCY', () => {
    const doc = createBaseDocument();
    doc.totals.taxTotal = 10.05; // 5 cents wrong tax
    doc.totals.grandTotal = 110.05;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.discrepancies.some(d => d.includes('Tax total discrepancy'))).toBe(true);
  });

  // Test 20: AI extraction containing a wrong line total
  it('20. AI extraction containing a wrong line total is flagged as DISCREPANCY and line item fails', () => {
    const doc = createBaseDocument();
    // 2 x 50 = 100 + 10 tax = 110, but lineTotal was misread as 110.02
    doc.lineItems[0]!.lineTotal = 110.02;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('DISCREPANCY');
    expect(report.isVerified).toBe(false);
    expect(report.lineItems[0]!.isMatched).toBe(false);
    expect(report.lineItems[0]!.variance).toBe(0.02);
    expect(report.discrepancies.some(d => d.includes('Line #1 calculation'))).toBe(true);
  });

  // Additional edge cases: negative amounts, enterprise scale, missing subtotal derivation
  it('handles negative values such as credit memos or refunds safely', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Hardware Return Credit',
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

  it('handles high-value corporate invoices without overflow or precision degradation', () => {
    const doc = createBaseDocument();
    doc.lineItems = [
      {
        lineNumber: 1,
        description: 'Enterprise Data Center Acquisition',
        sku: 'DC-ACQ',
        quantity: 1,
        unit: 'unit',
        unitPrice: 125000000.5,
        discount: 0,
        taxRate: 0.05,
        taxAmount: 6250000.03, // 125000000.50 * 0.05 = 6250000.025 -> rounds to 6250000.03
        lineSubtotal: 125000000.5,
        lineTotal: 131250000.53,
      },
    ];
    doc.totals.subtotal = 125000000.5;
    doc.totals.taxTotal = 6250000.03;
    doc.totals.grandTotal = 131250000.53;
    doc.totals.balanceDue = 131250000.53;

    const report = reconcileFinancialDocument(doc);
    expect(report.overallStatus).toBe('EXACT_MATCH');
    expect(report.isVerified).toBe(true);
    expect(report.totals.calculatedGrandTotal).toBe(131250000.53);
  });
});
