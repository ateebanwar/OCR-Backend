# Security Policy

## Supported Versions

Security updates are provided for the latest maintained version available on the `main` branch.

Older versions may not receive security fixes.

## Reporting a Vulnerability

If you discover a security vulnerability in OCR-Backend, please report it responsibly.

**Do not disclose security vulnerabilities through public GitHub Issues or Pull Requests.**

Instead:

1. Visit the repository's GitHub Security tab.
2. If Private Vulnerability Reporting is enabled, use it to submit your report.
3. Otherwise, contact the repository maintainer privately through GitHub.

Repository: https://github.com/ateebanwar/OCR-Backend

## What to Include

Please provide:

- A clear description of the vulnerability.
- Steps to reproduce the issue.
- Potential security impact.
- Relevant logs or screenshots, with sensitive information removed.
- Suggested mitigation, if available.

## Security Scope

The following areas are particularly important:

- PDF upload and file validation.
- API authentication and rate limiting.
- Gemini API key protection.
- Prompt injection and untrusted document content.
- Excel formula injection.
- Sensitive information and log redaction.
- Request limits and resource exhaustion.
- CORS and HTTP security headers.

## Responsible Disclosure

Please allow the maintainer reasonable time to investigate and address reported vulnerabilities before publicly disclosing them.

Do not exploit vulnerabilities to access other users' documents, credentials, or private information.

## Important

Never include real API keys, passwords, financial documents, personal information, or other confidential data in vulnerability reports or public discussions.
