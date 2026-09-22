import { DocumentCoverageMetadata } from '../domain/financial';

export class CoverageTracker {
  private totalPages: number;
  private processedPages: Set<number> = new Set();
  private failedPages: Set<number> = new Set();
  private skippedPages: Set<number> = new Set();

  constructor(totalPages: number) {
    this.totalPages = Math.max(1, totalPages);
  }

  public markPageProcessed(pageNumber: number): void {
    this.processedPages.add(pageNumber);
    this.failedPages.delete(pageNumber);
    this.skippedPages.delete(pageNumber);
  }

  public markPageFailed(pageNumber: number): void {
    this.failedPages.add(pageNumber);
    this.processedPages.delete(pageNumber);
  }

  public markPageSkipped(pageNumber: number): void {
    this.skippedPages.add(pageNumber);
    this.processedPages.delete(pageNumber);
  }

  public markAllProcessed(): void {
    for (let i = 1; i <= this.totalPages; i++) {
      this.processedPages.add(i);
    }
  }

  public getCoverage(): DocumentCoverageMetadata {
    const extractedPages = Array.from(this.processedPages).sort((a, b) => a - b);
    const failedPages = Array.from(this.failedPages).sort((a, b) => a - b);
    const skippedPages = Array.from(this.skippedPages).sort((a, b) => a - b);

    const extractionCompleteness =
      this.totalPages > 0 ? extractedPages.length / this.totalPages : 1;

    const isFullyCovered =
      extractedPages.length === this.totalPages &&
      failedPages.length === 0 &&
      skippedPages.length === 0;

    return {
      totalPages: this.totalPages,
      processedPages: extractedPages.length,
      extractedPages,
      failedPages,
      skippedPages,
      extractionCompleteness: Number(extractionCompleteness.toFixed(3)),
      isFullyCovered,
    };
  }
}
