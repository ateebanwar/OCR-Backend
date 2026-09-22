# Financial Document Intelligence Backend

A production-grade, provider-agnostic document intelligence system engineered for high-precision financial PDF extraction, multi-layered validation, deterministic financial reconciliation, formula injection defense, and verified Excel (`.xlsx`) generation.

Built on **Node.js 24**, **TypeScript (Strict)**, **Fastify**, **Zod**, **Google Gemini**, and **ExcelJS**, with native serverless readiness for **Vercel**.

---

## Table of Contents
1. [Core Capabilities](#1-core-capabilities)
2. [Security Architecture & Controls](#2-security-architecture--controls)
3. [Processing Pipeline](#3-processing-pipeline)
4. [Architecture & Folder Structure](#4-architecture--folder-structure)
5. [Provider-Agnostic AI Design](#5-provider-agnostic-ai-design)
6. [Deterministic Financial Reconciliation](#6-deterministic-financial-reconciliation)
7. [API Endpoints](#7-api-endpoints)
8. [Environment Configuration & Keys](#8-environment-configuration--keys)
9. [Local Development](#9-local-development)
10. [Running Automated Tests](#10-running-automated-tests)
11. [Production Build & Deployment to Vercel](#11-production-build--deployment-to-vercel)
12. [Adding Another AI Provider (e.g., Anthropic Claude)](#12-adding-another-ai-provider-eg-anthropic-claude)
13. [Security Threat Model & Defenses](#13-security-threat-model--defenses)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Core Capabilities

- **Financial Document Specialization**: Invoices, receipts, purchase orders, bills, tax documents, account statements.
- **Provider-Agnostic Core**: Internal `AIProvider` contract decouples business logic from SDK specifics.
- **Google Gemini Engine**: Multi-tier extraction with models configurable via environment variables (e.g. `gemini-2.5-flash`, `gemini-2.5-pro`).
- **Deterministic Math & Reconciliation**: High-precision decimal arithmetic avoiding IEEE-754 floating-point errors (`Decimal` class with 6 fixed decimal digits). Reconciles gross and net subtotals, line items, taxes, discounts, shipping, and grand totals.
- **AI Correction & Model Escalation Loop**: Automatically isolates mathematical or structural discrepancies, generates structured audit feedback prompts, and re-evaluates conflicting regions before escalating to complex models.
- **Independent Second-Pass Verification**: An automated auditor stage independently inspects the document to verify that no line items, taxes, or numbers were omitted or hallucinated.
- **Real Excel (.xlsx) Generation**: Multi-sheet workbook (`Document Summary`, `Line Items`, `Reconciliation & Audit`) with native Excel formulas and cell formatting.
- **Formula Injection Defense (CWE-1236)**: Preemptively neutralizes spreadsheet formula injection in user/document text fields (`=`, `+`, `-`, `@`, `\t`, `\r`).
- **Round-Trip XLSX Verification**: Automatically re-parses and validates generated `.xlsx` buffers before responding.
- **Vercel Serverless Ready**: Stateless, in-memory execution via `api/index.ts` and `vercel.json`.
- **Conversational Chat & Document Q&A**: Endpoints for both general financial assistance (with SSE streaming) and contextual Q&A on extracted documents.

---

## 2. Security Architecture & Controls

| Threat Category | Mechanism | Implementation |
| :--- | :--- | :--- |
| **Formula Injection (CWE-1236)** | Value Sanitization | Leading triggers (`=`, `+`, `-`, `@`, `\t`, `\r`) are escaped with a single quote `'` in `xlsxGenerator.ts`. |
| **Indirect Prompt Injection (CWE-1021)** | Untrusted Data Boundary | Explicit system prompt boundaries treating all document text as inert data; filename sanitization. |
| **PDF Decompression Bombs & Resource Exhaustion** | Ingestion Limits | Size guard (`MAX_UPLOAD_SIZE_MB`), page limit (`MAX_PDF_PAGES`), and magic bytes (`%PDF-`). |
| **Encrypted / Password-Locked PDFs** | Early Detection | Immediate rejection of `/Encrypt` dictionaries with 422 before invoking AI providers. |
| **Request Flooding & DoS** | Rate Limiting | `@fastify/rate-limit` enforces sliding-window rate limits returning 429 envelopes. |
| **Concurrency Exhaustion** | Active Request Guard | Bounded concurrency (`MAX_CONCURRENT_PROCESSING`) returning 503 `SERVER_TOO_BUSY` with `Retry-After: 5`. |
| **HTTP Security Headers** | Header Hardening | `@fastify/helmet` enforces CSP (`default-src 'none'`), frameguard (`DENY`), HSTS, and nosniff. |
| **Chat Context Flooding** | Input Bounds | Max 4,000 chars per message, max 30 messages in history, max 50,000 chars document context. |
| **Secret Leakage** | Deep Log Scrubber | Recursive redaction of API keys, bearer tokens, passwords, and raw document buffers. |

---

## 3. Processing Pipeline

```
Client (React Frontend / API Consumer)
   │
   ▼
[1. Concurrency & Rate Guard] ─► Rate limit check & active processing semaphore
   │
   ▼
[2. File Security Validation] ─► %PDF- Magic Bytes, MIME, Extension, Size, Encrypt check, Page limit
   │
   ▼
[3. SHA-256 Hashing] ──────────► Cryptographic document fingerprinting
   │
   ▼
[4. Complexity Analysis] ──────► Level 1 (Simple), Level 2 (Complex), Level 3 (Ambiguous)
   │
   ▼
[5. AI Provider] ──────────────► Gemini Structured JSON Extraction (with prompt injection defense)
   │
   ▼
[6. Layer 1 Validation] ───────► Strict Zod Schema parsing
   │
   ▼
[7. Layer 2 Validation] ───────► Semantic & date logic validation
   │
   ▼
[8. Layer 3 Reconciliation] ───► Deterministic Decimal Line & Totals Math (Gross & Net support)
   │
   ├── [Discrepancy Detected?] ────► AI Correction Feedback Loop (up to MAX_EXTRACTION_RETRIES)
   │                                 └── Model Escalation (up to MAX_ESCALATION_LEVELS)
   ▼
[9. Second-Pass Audit] ────────► Independent AI Verification against Source PDF
   │
   ▼
[10. ExcelJS Generation] ──────► Formula-injection sanitized multi-sheet .xlsx with formulas
   │
   ▼
[11. XLSX Verification] ───────► Programmatic round-trip parse check (sheets, rows, formulas)
   │
   ▼
Verified Result & .xlsx Download Response
```

---

## 4. Architecture & Folder Structure

```
OCR-Backend/
├── api/
│   └── index.ts                 # Vercel serverless function entry point
├── src/
│   ├── app/
│   │   ├── buildApp.ts          # Fastify factory with Helmet, RateLimit, CORS, and Multipart
│   │   └── server.ts            # Local/standalone server entry point
│   ├── config/
│   │   ├── env.ts               # Zod-validated environment config with fail-fast startup
│   │   └── models.ts            # Model hierarchy & complexity routing
│   ├── domain/
│   │   ├── financial.ts         # Canonical financial document models & types
│   │   ├── processing.ts        # Processing stages, reconciliation reports, audit trail
│   │   └── chat.ts              # Chat messages & token contracts
│   ├── errors/
│   │   └── AppError.ts          # Centralized typed errors (ValidationError, ReconciliationError, etc.)
│   ├── security/
│   │   ├── fileValidator.ts     # %PDF- check, encryption check, page limits, filename sanitizer
│   │   ├── cors.ts              # Configurable CORS policy
│   │   └── scrubber.ts          # Redacts secrets, keys, and raw buffers from logs
│   ├── middleware/
│   │   ├── requestId.ts         # Request ID tagging (X-Request-ID)
│   │   ├── concurrencyGuard.ts  # Active processing concurrency protection
│   │   └── errorHandler.ts      # Standardized API error envelopes (no leaked stack traces)
│   ├── providers/
│   │   └── ai/
│   │       ├── AIProvider.ts    # Provider-agnostic interface
│   │       ├── GeminiProvider.ts# Google Gemini adapter with timeouts and retries
│   │       └── providerFactory.ts# Factory resolver supporting Gemini, Mock, Claude
│   ├── documents/
│   │   ├── documentHasher.ts    # SHA-256 document hashing
│   │   ├── complexityAnalyzer.ts# Level 1/2/3 document complexity heuristics
│   │   └── coverageTracker.ts   # Multi-page coverage and extraction completeness
│   ├── extraction/
│   │   ├── schemas/
│   │   │   └── financialSchema.ts# Strict Zod schema for canonical extraction
│   │   └── promptTemplates.ts   # Zero-tolerance prompts with prompt-injection isolation
│   ├── reconciliation/
│   │   ├── decimal.ts           # Fixed-point 6-decimal BigInt monetary math
│   │   └── reconciliationEngine.ts# Deterministic line item, subtotal, tax, and total checks
│   ├── spreadsheet/
│   │   ├── xlsxGenerator.ts     # Formula-injection hardened ExcelJS workbook generator
│   │   └── xlsxVerifier.ts      # Programmatic XLSX integrity verification
│   ├── services/
│   │   ├── DocumentProcessingService.ts # Master pipeline orchestrator
│   │   ├── ExtractionService.ts # Extraction & AI correction loop with model escalation
│   │   ├── VerificationService.ts# Second-pass independent AI auditor
│   │   └── ChatService.ts       # Conversational AI & Document Q&A
│   ├── api/
│   │   └── response.ts          # Unified { success, data, error, requestId } envelopes
│   ├── routes/
│   │   ├── v1/
│   │   │   ├── health.ts        # GET /api/v1/health
│   │   │   ├── documents.ts     # POST /process, POST /download, POST /chat
│   │   │   └── chat.ts          # POST /api/v1/chat (JSON & SSE streaming)
│   │   └── router.ts            # Route registrar
│   └── index.ts                 # Main export
├── tests/
│   ├── unit/                    # Decimal math, reconciliation, schemas, XLSX
│   ├── integration/             # Health, full document pipeline, chat, streaming
│   ├── security/                # Formula injection, prompt injection, PDF security, rate limit, concurrency
│   └── mocks/
│       └── MockAIProvider.ts    # Isolated mock provider for automated tests
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── vercel.json
└── README.md
```

---

## 5. Provider-Agnostic AI Design

The core business logic never references the `@google/generative-ai` SDK directly. All AI interactions go through the `AIProvider` contract:

```typescript
export interface AIProvider {
  readonly providerName: string;
  analyzeDocument(doc: DocumentInput, options?: ProviderOptions): Promise<DocumentAnalysisResult>;
  extractStructuredData<T>(doc: DocumentInput, promptContext: ExtractionPromptContext, options?: ProviderOptions): Promise<T>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk>;
  healthCheck(): Promise<ProviderHealth>;
}
```

The provider instance is resolved dynamically via `providerFactory.ts` according to `AI_PROVIDER`:
- `AI_PROVIDER=gemini`: Instantiates `GeminiProvider`
- `AI_PROVIDER=mock`: Instantiates `MockAIProvider` (used in test suites)
- Future: `AI_PROVIDER=claude`: Instantiates `ClaudeProvider` without changing any service code.

---

## 6. Deterministic Financial Reconciliation

Rather than trusting an LLM's own self-reported mathematical accuracy, the backend computes all calculations in code using high-precision decimal math (`Decimal` class using scaled 64-bit BigInt with 6 fixed decimal digits).

Reconciliation steps:
1. **Per-Line Item**: `(quantity × unitPrice) - discount + tax` vs `extractedLineTotal`.
2. **Subtotal Summation**: Supports both **Gross** (`sum(qty * price)`) and **Net** (`sum(qty * price - discount)`) subtotal conventions to prevent double-discount subtraction.
3. **Grand Total Verification**: `baseSubtotal - discount + tax + shipping + additional + rounding` vs `extractedGrandTotal`.
4. **Balance Due**: `grandTotal - paidAmount` vs `extractedBalanceDue`.
5. **Tolerance Engine**: Configurable rounding tolerance (default `0.02`). Classifies document as:
   - `EXACT_MATCH`: 0.00 variance.
   - `ACCEPTABLE_ROUNDING`: Discrepancy within tolerance (e.g. ±$0.02).
   - `DISCREPANCY`: Unresolvable difference exceeding tolerance.
   - `MISSING_DATA`: Critical totals or items missing.

If a discrepancy occurs, the AI Correction Loop is triggered to re-inspect the conflicting fields.

---

## 7. API Endpoints

All routes are versioned under `/api/v1`.

### 1. Health Check
- **Endpoint**: `GET /api/v1/health`
- **Description**: Returns service health status, uptime, environment, and AI provider name. Does not expose keys. O(1) response without AI latency.

### 2. Process Financial Document
- **Endpoint**: `POST /api/v1/documents/process`
- **Content-Type**: `multipart/form-data`
- **Form Field**: `file` (PDF file)
- **Protected by**: Concurrency guard, magic bytes check, encryption detection, page limits.
- **Response**:
```json
{
  "success": true,
  "data": {
    "documentId": "4a76d8b9-...",
    "sourceFilename": "invoice.pdf",
    "documentHash": "e3b0c442...",
    "isVerified": true,
    "document": { ...canonical financial document... },
    "reconciliation": {
      "overallStatus": "EXACT_MATCH",
      "isVerified": true,
      "lineItems": [...],
      "totals": {
        "calculatedSubtotal": 3450.0,
        "extractedSubtotal": 3450.0,
        "calculatedGrandTotal": 3795.0,
        "extractedGrandTotal": 3795.0,
        "grandTotalVariance": 0.0
      }
    },
    "auditTrail": {
      "stages": [
        { "stage": "VALIDATING_FILE", "durationMs": 4 },
        { "stage": "EXTRACTING", "durationMs": 1200 },
        { "stage": "RECONCILING", "durationMs": 3 },
        { "stage": "GENERATING_XLSX", "durationMs": 35 }
      ],
      "totalProcessingTimeMs": 1320
    },
    "xlsxBase64": "UEsDBBQA...",
    "xlsxVerification": {
      "isValid": true,
      "sheetNames": ["Document Summary", "Line Items", "Reconciliation & Audit"],
      "totalRows": 26,
      "formulaCount": 3
    }
  },
  "requestId": "9a12c8..."
}
```

### 3. Download Verified Excel Workbook
- **Endpoint**: `POST /api/v1/documents/download`
- **Content-Type**: `application/json`
- **Body**: `{ "xlsxBase64": "<base64 string>", "filename": "report.xlsx" }`
- **Response**: Binary `.xlsx` file stream with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.

### 4. Chat with Document Context
- **Endpoint**: `POST /api/v1/documents/chat`
- **Content-Type**: `application/json`
- **Protected by**: Max context length (50,000 chars), max 30 messages, max 4,000 chars per message.
- **Body**:
```json
{
  "documentContext": "Vendor Acme Cloud, Invoice #100, Total $3,795.00",
  "messages": [
    { "role": "user", "content": "What is the payment due date and total?" }
  ]
}
```

### 5. General AI Chat (with SSE Streaming)
- **Endpoint**: `POST /api/v1/chat`
- **Content-Type**: `application/json`
- **Protected by**: Max 4,000 chars per message, max 30 conversation messages.
- **Body**:
```json
{
  "messages": [
    { "role": "user", "content": "What is the formula for calculating Quick Ratio?" }
  ],
  "stream": false
}
```
*Set `"stream": true` to receive a `text/event-stream` Server-Sent Events stream.*

---

## 8. Environment Configuration & Keys

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### Key Configuration Directives:
```env
# Server
NODE_ENV=development
PORT=3001
HOST=0.0.0.0
LOG_LEVEL=info

# AI Provider Configuration
AI_PROVIDER=gemini
GEMINI_API_KEY=PASTE_YOUR_GEMINI_API_KEY_HERE
GEMINI_EXTRACTION_MODEL=gemini-2.5-flash
GEMINI_COMPLEX_EXTRACTION_MODEL=gemini-2.5-pro
GEMINI_CHAT_MODEL=gemini-2.5-flash

# Security & CORS
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
MAX_UPLOAD_SIZE_MB=15
MAX_PDF_PAGES=50
REQUEST_TIMEOUT_MS=60000
AI_TIMEOUT_MS=60000

# Rate Limiting & Concurrency
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW_MS=60000
MAX_CONCURRENT_PROCESSING=5
MAX_OUTPUT_SIZE_MB=20

# Pipeline Policies
MAX_EXTRACTION_RETRIES=2
MAX_ESCALATION_LEVELS=2
```

---

## 9. Local Development

### Prerequisites:
- Node.js 20+ (tested on Node.js 24)
- npm 10+

### Setup & Run:
```bash
# 1. Install dependencies
npm install

# 2. Run local development server (with live reload)
npm run dev

# 3. Check health
curl http://localhost:3001/api/v1/health
```

---

## 10. Running Automated Tests

The repository includes a comprehensive test suite with 100% isolated mocks and security checks:

```bash
# Run all tests
npm test

# Run tests with watch mode
npm run test:watch

# Run TypeScript typecheck with zero errors
npm run typecheck
```

### Test Coverage (58 tests across 14 suites):
- **Spreadsheet Security**: Formula injection triggers (`=`, `+`, `-`, `@`, `\t`, `\r`) neutralized across summary, line items, and audit sheets.
- **PDF Security**: Encryption detection, page limit enforcement, Unicode Bidi sanitization.
- **Prompt Injection Defense**: Adversarial document content treated strictly as untrusted data without modifying schema or totals.
- **Rate Limiting & Headers**: Helmet security headers (`nosniff`, `DENY`, `CSP`) and 429 rate limit enforcement.
- **Concurrency Guard**: 503 `SERVER_TOO_BUSY` when concurrent processing limits are exceeded.
- **Chat Security**: Message length (> 4000 chars), history length (> 30 msgs), and context length (> 50,000 chars) bounds.
- **Financial Reconciliation**: 15 test cases covering exact totals, decimals, taxes, discounts, negative lines, rounding, multiple rates, missing subtotal/tax, duplicate items, large values.
- **Integration**: Full multipart PDF upload pipeline, base64 download, chat, and SSE streaming.

---

## 11. Production Build & Deployment to Vercel

### Production Build:
```bash
npm run build
```

### Deploying to Vercel:
The project contains `vercel.json` and a serverless entry point at `api/index.ts`.

1. Push your repository to GitHub / GitLab / Bitbucket.
2. Import the project into your [Vercel Dashboard](https://vercel.com).
3. Set the Environment Variables in Vercel:
   - `NODE_ENV`: `production`
   - `AI_PROVIDER`: `gemini`
   - `GEMINI_API_KEY`: `[Your real Gemini API key]`
   - `GEMINI_EXTRACTION_MODEL`: `gemini-2.5-flash`
   - `GEMINI_COMPLEX_EXTRACTION_MODEL`: `gemini-2.5-pro`
   - `GEMINI_CHAT_MODEL`: `gemini-2.5-flash`
   - `ALLOWED_ORIGINS`: `https://your-react-frontend.vercel.app`
4. Click **Deploy**.

The Vercel Serverless Function will handle all requests under `/api/v1/*`.

---

## 12. Adding Another AI Provider (e.g., Anthropic Claude)

The architecture is provider-agnostic. To add Claude:

1. Create `src/providers/ai/ClaudeProvider.ts` implementing `AIProvider`:
```typescript
import { AIProvider, DocumentInput, ExtractionPromptContext, ... } from './AIProvider';

export class ClaudeProvider implements AIProvider {
  public readonly providerName = 'claude';
  // Implement analyzeDocument, extractStructuredData, chat, streamChat, healthCheck
}
```
2. Register it in `src/providers/ai/providerFactory.ts`:
```typescript
registerAIProvider('claude', (config) => new ClaudeProvider(config));
```
3. Set `AI_PROVIDER=claude` in your `.env`.

---

## 13. Security Threat Model & Defenses

- **No Key Exposure**: The browser never sees `GEMINI_API_KEY`.
- **Magic Bytes Validation**: File extensions and client MIME types are never trusted; the first 4 bytes are strictly checked for `%PDF-` (`0x25, 0x50, 0x44, 0x46`).
- **Encrypted Document Rejection**: Encrypted PDFs are rejected early before calling AI models.
- **Formula Injection Defense**: Escapes leading dangerous characters with single quotes `'` to prevent DDE/code execution in Excel.
- **Secret Scrubbing**: Logs and error responses automatically scrub tokens, keys, passwords, and raw binary buffers.
- **Safe Memory Handling**: PDF buffers and Excel generation happen entirely in memory; no temporary files remain on disk.
- **Zero Hallucination Policy**: If a field is not present in the document, it is preserved as `null`. Numbers and decimals are never fabricated.

---

## 14. Troubleshooting

- **415 Unsupported Document Type**:
  Ensure the uploaded file is a valid PDF starting with `%PDF-`. Files created by simply renaming `.txt` to `.pdf` will be rejected.
- **422 File Validation Error (Password-Protected)**:
  The PDF is encrypted. Remove password protection before uploading.
- **422 Document Processing Failed**:
  The document was extracted, but financial reconciliation identified contradictory totals that could not be resolved within the retry limit. Inspect `details.discrepancies` in the response envelope for line-by-line mismatch details.
- **429 Rate Limit Exceeded**:
  Wait for the cooldown window before making additional requests.
- **503 Server Too Busy**:
  Maximum concurrent document processing capacity reached. Retry in a few seconds.
- **502 AI Provider Error**:
  Check that `GEMINI_API_KEY` is set correctly in `.env` and that your quota has not been exceeded.
