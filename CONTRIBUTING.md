# Contributing to OCR-Backend

Thank you for your interest in contributing to OCR-Backend!

We welcome contributions that improve reliability, security, performance, documentation, and functionality.

## Getting Started

1. Fork this repository.
2. Clone your fork locally.
3. Install dependencies:

```bash
npm install
```

4. Configure your local environment using `.env.example`.
5. Run the development server:

```bash
npm run dev
```

## Before Submitting Changes

Please run the following checks:

```bash
npm test
npm run typecheck
npm run build
```

Make sure all checks pass before submitting your changes.

## Contribution Guidelines

- Keep changes focused and easy to review.
- Follow the existing TypeScript coding style.
- Add or update tests for new functionality.
- Never commit API keys, passwords, personal documents, or other secrets.
- Preserve existing security protections.
- Do not introduce breaking API changes without documenting them.

## Pull Request Process

1. Create a feature branch.
2. Make your changes.
3. Run the relevant tests.
4. Push your branch to your fork.
5. Open a Pull Request against the main repository.
6. Clearly describe the changes and their purpose.

## Reporting Bugs

Open a GitHub Issue with:

- A clear description of the problem.
- Steps to reproduce it.
- Expected and actual behaviour.
- Relevant error messages, with secrets removed.

## Security Issues

Do not publish API keys, personal documents, or sensitive vulnerability details in public issues.

For security concerns, contact the repository maintainer privately.

Thank you for helping improve OCR-Backend!
