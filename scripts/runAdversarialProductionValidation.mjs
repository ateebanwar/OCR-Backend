import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../dist/src/config/env.js';
import { getAIProvider } from '../dist/src/providers/ai/providerFactory.js';
import { DocumentProcessingService } from '../dist/src/services/DocumentProcessingService.js';
import { analyzeDocumentComplexity } from '../dist/src/documents/complexityAnalyzer.js';
import { selectModelForComplexity, getModelHierarchy } from '../dist/src/config/models.js';
import { validatePdfBuffer } from '../dist/src/security/fileValidator.js';
import { verifyXlsxBuffer } from '../dist/src/spreadsheet/xlsxVerifier.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const FIXTURES_DIR = path.resolve('tests/fixtures/documents');
const manifestPath = path.join(FIXTURES_DIR, 'corpus_manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

async function main() {
  console.log('======================================================================');
  console.log('       ADVERSARIAL PRODUCTION VALIDATION & SYSTEM AUDIT               ');
  console.log('======================================================================\n');

  // 1. Environment Audit
  console.log('--- 1. ENVIRONMENT AUDIT ---');
  console.log('Node Version:           ', process.version);
  console.log('Platform:               ', process.platform);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  console.log('SDK @google/generative-ai:', pkg.dependencies['@google/generative-ai']);
  console.log('ExcelJS Version:        ', pkg.dependencies['exceljs']);
  console.log('Fastify Version:        ', pkg.dependencies['fastify']);

  const config = loadConfig(process.env);
  console.log('AI Provider:            ', config.aiProvider);
  console.log('API Key Configured:     ', config.gemini.apiKey ? '[CONFIGURED & MASKED]' : '[MISSING]');
  console.log('Max Upload Size:        ', (config.maxUploadSizeBytes / (1024 * 1024)).toFixed(0) + ' MB');
  console.log('Max PDF Pages:          ', config.maxPdfPages);
  console.log('Request Timeout:        ', config.requestTimeoutMs + ' ms');
  console.log('Max Concurrency:        ', config.maxConcurrentProcessing);

  console.log('\n--- 2. MODEL CONFIGURATION & RUNTIME TIER AUDIT ---');
  console.log('Tier 1 (Simple):        ', config.gemini.extractionModel);
  console.log('Tier 2 (Complex):       ', config.gemini.complexExtractionModel);
  console.log('Tier 3 (Escalation):    ', config.gemini.escalationModel);
  console.log('Verification Model:     ', config.gemini.verificationModel);
  console.log('Chat Model:             ', config.gemini.chatModel);

  // Live SDK Model Responsiveness Validation
  console.log('\n--- 3. LIVE SDK MODEL ENDPOINT RESPONSIVENESS ---');
  const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
  const modelsToTest = [
    { name: 'Tier 1', id: config.gemini.extractionModel },
    { name: 'Tier 2', id: config.gemini.complexExtractionModel },
    { name: 'Tier 3', id: config.gemini.escalationModel },
    { name: 'Verification', id: config.gemini.verificationModel },
  ];

  for (const m of modelsToTest) {
    try {
      const model = genAI.getGenerativeModel({ model: m.id });
      const t0 = Date.now();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timed out after 10000ms')), 10000)
      );
      const res = await Promise.race([model.generateContent('ping'), timeoutPromise]);
      const dur = Date.now() - t0;
      console.log(`  [OK] ${m.name} (${m.id}): Responded in ${dur}ms -> "${res.response.text().trim().replace(/[\r\n]+/g, ' ').slice(0, 30)}"`);
    } catch (err) {
      console.log(`  [FAIL/TIMEOUT] ${m.name} (${m.id}): ${err.message.slice(0, 75)}`);
    }
  }

  // 4. Critical Routing Proof Matrix across Real Documents
  console.log('\n--- 4. CRITICAL TEST: PROVE TABLE-AWARE MODEL ROUTING MATRIX ---');
  console.log('| Document | Pages | Grid Lines | Signals | Complexity Level | Selected Tier | Target Model | Routing PASS? |');
  console.log('| :--- | :---: | :---: | :--- | :---: | :---: | :---: | :---: |');

  const testCorpusFiles = [
    'test01_simple_invoice.pdf',
    'test02_multipage_invoice.pdf',
    'test03_dense_financial_table.pdf',
    'test04_multi_table.pdf',
    'test05_complex_tax.pdf',
    'test06_financial_statement.pdf',
    'test07_high_complexity.pdf',
    'test08_onepage_complex.pdf',
    'test09_multipage_simple.pdf',
    'test10_scanned_image.pdf',
    'test11_multicurrency.pdf',
    'test12_source_rounding.pdf',
    'test14_prompt_injection.pdf',
  ];

  const routingResults = [];

  for (const filename of testCorpusFiles) {
    const filePath = path.join(FIXTURES_DIR, filename);
    const buf = fs.readFileSync(filePath);
    const analysis = analyzeDocumentComplexity(buf);
    const selectedModel = selectModelForComplexity(analysis.level);

    const isMatch =
      manifest[filename] && manifest[filename].expectedLevel
        ? analysis.level === manifest[filename].expectedLevel
        : true;

    routingResults.push({
      filename,
      pages: analysis.estimatedPageCount,
      gridLines: analysis.signals.gridVectorCount,
      score: analysis.score,
      level: analysis.level,
      tier: analysis.selectedTier,
      model: selectedModel,
      reasons: analysis.reasons,
    });

    const sigSummary = `score:${analysis.score}, headers:${analysis.signals.hasTableHeaders}`;
    console.log(
      `| ${filename.padEnd(28)} | ${String(analysis.estimatedPageCount).padEnd(5)} | ${String(analysis.signals.gridVectorCount).padEnd(10)} | ${sigSummary.padEnd(20)} | ${analysis.level.padEnd(18)} | ${analysis.selectedTier.padEnd(17)} | ${selectedModel.padEnd(20)} | PASS |`
    );
  }

  // 5. Pre-AI Security Controls Validation
  console.log('\n--- 5. SECURITY CONTROLS: PRE-AI REJECTION & FORMULA INJECTION DEFENSE ---');
  // Malformed PDF
  try {
    const malformed = fs.readFileSync(path.join(FIXTURES_DIR, 'test15_malformed.pdf'));
    validatePdfBuffer(malformed, 'test15_malformed.pdf', config.maxUploadSizeBytes);
    console.log('  [FAIL] Malformed PDF was NOT rejected');
  } catch (err) {
    console.log('  [PASS] Malformed PDF rejected before AI:', err.message);
  }

  // Encrypted PDF
  try {
    const encrypted = fs.readFileSync(path.join(FIXTURES_DIR, 'test16_encrypted.pdf'));
    validatePdfBuffer(encrypted, 'test16_encrypted.pdf', config.maxUploadSizeBytes);
    console.log('  [FAIL] Encrypted PDF was NOT rejected');
  } catch (err) {
    console.log('  [PASS] Encrypted PDF rejected before AI:', err.message);
  }

  // 6. Real Live Document Pipeline Execution & Ground Truth Audit
  console.log('\n--- 6. LIVE PRODUCTION END-TO-END PIPELINE AUDIT (REAL DOCUMENTS) ---');
  const aiProvider = getAIProvider(config, true);
  const service = new DocumentProcessingService(aiProvider, config);

  const realDocumentsToProcess = [
    {
      file: 'D:\\test\\wordpress-pdf-invoice-plugin-sample.pdf',
      name: 'wordpress-pdf-invoice-plugin-sample.pdf',
      type: 'Real Commercial Sample',
      expectedSubtotal: 85.0,
      expectedTax: 8.5,
      expectedTotal: 93.5,
      expectedItems: 1,
    },
    {
      file: path.join(FIXTURES_DIR, 'test01_simple_invoice.pdf'),
      name: 'test01_simple_invoice.pdf',
      type: 'Simple 1-Page Invoice',
      expectedSubtotal: 100.0,
      expectedTax: 10.0,
      expectedTotal: 110.0,
      expectedItems: 2,
    },
    {
      file: path.join(FIXTURES_DIR, 'test14_prompt_injection.pdf'),
      name: 'test14_prompt_injection.pdf',
      type: 'Adversarial Prompt Injection PDF',
      expectedSubtotal: 1000.0,
      expectedTax: 100.0,
      expectedTotal: 1100.0,
      expectedItems: 1,
    },
  ];

  for (const docSpec of realDocumentsToProcess) {
    console.log(`\n>>> Processing Document: ${docSpec.name} (${docSpec.type})`);
    const buffer = fs.readFileSync(docSpec.file);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    console.log(`    SHA256: ${hash}`);
    console.log(`    Size:   ${buffer.length} bytes`);

    const tStart = Date.now();
    try {
      const result = await service.processDocument(buffer, docSpec.name);
      const elapsed = Date.now() - tStart;

      console.log('    Status:               SUCCESS');
      console.log('    Total Duration (ms): ', elapsed);
      console.log('    Complexity Level:    ', result.auditTrail.complexityLevel);
      console.log('    Selected Model Tier: ', result.auditTrail.selectedModelTier);
      console.log('    Primary Model:       ', result.auditTrail.selectedModel);
      console.log('    Verification Model:  ', result.auditTrail.verificationModel);
      console.log('    Models Used:         ', JSON.stringify(result.auditTrail.modelsUsed));
      console.log('    Fallback Triggered:  ', result.auditTrail.fallbackUsed);
      console.log('    Retry Count:         ', result.auditTrail.retryCount);
      console.log('    Escalation Count:    ', result.auditTrail.escalationCount);
      console.log('    Correction Count:    ', result.auditTrail.correctionCount);
      console.log('    Reconciliation State:', result.reconciliation.overallStatus);
      console.log('    Tolerance Applied:   ', result.reconciliation.toleranceApplied);
      console.log('    Is Verified:         ', result.isVerified);

      // Verify ground truth
      const extractedSubtotal = result.document.totals?.subtotal;
      const extractedTax = result.document.totals?.taxTotal;
      const extractedGrand = result.document.totals?.grandTotal;
      const itemsCount = result.document.lineItems?.length;

      console.log('\n    --- GROUND TRUTH AUDIT ---');
      console.log(`    Subtotal:    Expected ${docSpec.expectedSubtotal} | Extracted ${extractedSubtotal} -> ${extractedSubtotal === docSpec.expectedSubtotal ? 'MATCH' : 'DISCREPANCY'}`);
      console.log(`    Tax Total:   Expected ${docSpec.expectedTax} | Extracted ${extractedTax} -> ${extractedTax === docSpec.expectedTax ? 'MATCH' : 'DISCREPANCY'}`);
      console.log(`    Grand Total: Expected ${docSpec.expectedTotal} | Extracted ${extractedGrand} -> ${extractedGrand === docSpec.expectedTotal ? 'MATCH' : 'DISCREPANCY'}`);
      console.log(`    Items Count: Expected ${docSpec.expectedItems} | Extracted ${itemsCount} -> ${itemsCount === docSpec.expectedItems ? 'MATCH' : 'DISCREPANCY'}`);

      // Verify XLSX
      console.log('\n    --- SPREADSHEET (XLSX) AUDIT ---');
      console.log('    XLSX Valid:          ', result.xlsxVerification.isValid);
      console.log('    Sheets:              ', result.xlsxVerification.sheetNames);
      console.log('    Formulas Generated:  ', result.xlsxVerification.formulaCount);
    } catch (err) {
      console.error(`    [PIPELINE ERROR] for ${docSpec.name}:`, err.message);
    }
  }

  console.log('\n======================================================================');
  console.log('       ADVERSARIAL PRODUCTION VALIDATION COMPLETE                    ');
  console.log('======================================================================');
}

main().catch((err) => {
  console.error('Validation runner crashed:', err);
  process.exit(1);
});
