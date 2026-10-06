import zlib from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { extractText } from "unpdf";
import { getDocument } from "unpdf/pdfjs";

const require = createRequire(import.meta.url);
const unzipper = require("unzipper") as {
  Open: {
    file: (filePath: string) => Promise<{
      files: Array<{
        path: string;
        uncompressedSize: number;
        stream: () => NodeJS.ReadableStream & AsyncIterable<Buffer>;
      }>;
    }>;
  };
};

export interface ParsedChunk {
  chunkIndex: number;
  title: string | null;
  content: string;
  tokenCount: number;
  metadata: {
    section?: string;
    charStart: number;
    charEnd: number;
    embeddingSpace?: string | null;
    embeddingBackend?: string | null;
  };
  embedding?: number[];
}

export type DocumentExtractionQuality = {
  extractor: "pdfjs" | "docx_xml";
  pageCount?: number;
  textLayerPageCount?: number;
  scannedPageCount?: number;
  ocrPageCount?: number;
  unreadablePageCount?: number;
  skippedOcrPageCount?: number;
  ocrStatus?: "not_needed" | "complete" | "partial" | "unavailable" | "disabled";
  ocrFailure?: string;
};

type PdfOcrRunner = (filePath: string, pageNumber: number, temporaryDirectory: string, signal?: AbortSignal) => Promise<string>;

const MAX_PDF_PAGES = 10_000;
const PDF_OCR_MIN_TEXT_CHARS = 24;
const DEFAULT_PDF_OCR_PAGE_LIMIT = 200;
const DEFAULT_PDF_OCR_TIMEOUT_MS = 30_000;
const MAX_PDF_OCR_OUTPUT_BYTES = 4 * 1024 * 1024;

function positiveIntegerSetting(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return Math.min(value, maximum);
}

function runLocalPdfOcrCommand(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  const timeoutMs = positiveIntegerSetting("RAG_PDF_OCR_PAGE_TIMEOUT_MS", DEFAULT_PDF_OCR_TIMEOUT_MS, 120_000);
  if (signal?.aborted) return Promise.reject(new Error("Datasource document ingestion was cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;
    let terminalError: Error | undefined;
    let killTimeout: NodeJS.Timeout | undefined;
    const finish = (error?: Error, output = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(output);
    };
    const terminate = (error: Error) => {
      if (terminalError || settled) return;
      terminalError = error;
      child.kill("SIGTERM");
      killTimeout = setTimeout(() => child.kill("SIGKILL"), 1_000);
      killTimeout.unref?.();
    };
    const abort = () => terminate(new Error("Datasource document ingestion was cancelled"));
    const timeout = setTimeout(() => {
      terminate(new Error("PDF OCR command exceeded its per-page time limit"));
    }, timeoutMs);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PDF_OCR_OUTPUT_BYTES) {
        terminate(new Error("PDF OCR output exceeded its per-page size limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes < 16 * 1024) {
        stderr.push(chunk.subarray(0, 16 * 1024 - errorBytes));
        errorBytes += chunk.length;
      }
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (terminalError) finish(terminalError);
      else if (code === 0) finish(undefined, Buffer.concat(stdout).toString("utf8"));
      else finish(new Error(`${command} exited with code ${String(code)}${stderr.length ? `: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}` : ""}`));
    });
  });
}

export class KnowledgeIngestionService {
  private static readonly MAX_DOCX_XML_BYTES = 256 * 1024 * 1024;
  private static readonly MAX_DOCX_XML_TOKEN_CHARS = 64 * 1024;

  static isStreamableTextDocument(fileName: string): boolean {
    return /\.(?:txt|text|md|markdown|json|log|csv|tsv)$/i.test(fileName);
  }

  static isStreamableBinaryDocument(fileName: string): boolean {
    return /\.(?:pdf|docx)$/i.test(fileName);
  }

  /**
   * Extract supported binary documents page/entry by page/entry to a private
   * temporary text file, then feed the existing bounded text chunker. PDF.js
   * reads file URLs through its Node range stream; DOCX reads only the main
   * document XML entry from the ZIP archive.
   */
  static async processDocumentFile(
    filePath: string,
    fileName: string,
    onChunkBatch: (chunks: ParsedChunk[]) => Promise<void>,
    options: { signal?: AbortSignal; batchSize?: number; sampleLimit?: number; pdfOcrPage?: PdfOcrRunner } = {},
  ): Promise<{ chunkCount: number; totalWords: number; sampleChunks: ParsedChunk[]; extractionQuality: DocumentExtractionQuality }> {
    const lowerName = fileName.toLowerCase();
    if (!this.isStreamableBinaryDocument(fileName)) throw new Error(`Unsupported streamed RAG document: ${fileName}`);
    if (options.signal?.aborted) throw new Error("Datasource document ingestion was cancelled");

    const extractionDir = await mkdtemp(path.join(tmpdir(), "paperclip-rag-extract-"));
    const textPath = path.join(extractionDir, "extracted.txt");
    const extractionQuality: DocumentExtractionQuality = lowerName.endsWith(".pdf")
      ? { extractor: "pdfjs", pageCount: 0, textLayerPageCount: 0, scannedPageCount: 0, ocrPageCount: 0, unreadablePageCount: 0, skippedOcrPageCount: 0, ocrStatus: "not_needed" }
      : { extractor: "docx_xml" };
    try {
      const textSource = lowerName.endsWith(".pdf")
        ? this.extractPdfPageText(filePath, extractionDir, extractionQuality, options.signal, options.pdfOcrPage)
        : this.extractDocxXmlText(filePath, options.signal);
      await pipeline(
        Readable.from(textSource),
        createWriteStream(textPath, { flags: "wx", mode: 0o600 }),
        ...(options.signal ? [{ signal: options.signal }] : []),
      );
      const extracted = await stat(textPath);
      if (lowerName.endsWith(".pdf")
        && (extractionQuality.scannedPageCount || 0) > 0
        && (extractionQuality.textLayerPageCount || 0) === 0
        && (extractionQuality.ocrPageCount || 0) === 0
        && (extractionQuality.unreadablePageCount || 0) > 0) {
        throw new Error(`PDF OCR did not produce text for ${extractionQuality.unreadablePageCount} scanned page(s); extraction quality is ${extractionQuality.ocrStatus}`);
      }
      if (extracted.size === 0) {
        await writeFile(textPath, `Document: ${fileName}\n(Empty or unparseable document content)`, { mode: 0o600 });
      }
      const result = await this.processTextFile(textPath, onChunkBatch, options);
      return { ...result, extractionQuality };
    } finally {
      await rm(extractionDir, { recursive: true, force: true });
    }
  }

  private static async *extractPdfPageText(
    filePath: string,
    temporaryDirectory: string,
    quality: DocumentExtractionQuality,
    signal?: AbortSignal,
    ocrRunner?: PdfOcrRunner,
  ): AsyncGenerator<string> {
    const loadingTask = getDocument({
      url: pathToFileURL(filePath).href,
      disableFontFace: true,
      useSystemFonts: true,
    });
    try {
      const pdf = await loadingTask.promise;
      if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`PDF exceeds the ${MAX_PDF_PAGES}-page extraction limit`);
      quality.pageCount = pdf.numPages;
      const ocrEnabled = process.env.RAG_PDF_OCR_ENABLED?.trim().toLowerCase() !== "false";
      const ocrPageLimit = positiveIntegerSetting("RAG_PDF_OCR_MAX_PAGES", DEFAULT_PDF_OCR_PAGE_LIMIT, MAX_PDF_PAGES);
      const languages = process.env.RAG_PDF_OCR_LANGS?.trim() || "eng+ind";
      if (!/^[A-Za-z0-9_+-]{2,64}$/.test(languages)) throw new Error("RAG_PDF_OCR_LANGS contains unsupported characters");
      let ocrFailure: string | undefined;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (signal?.aborted) throw new Error("Datasource document ingestion was cancelled");
        const page = await pdf.getPage(pageNumber);
        const text = await page.getTextContent();
        const pageText: string[] = [];
        for (const item of text.items) {
          if ("str" in item && item.str) pageText.push(item.str);
          if ("hasEOL" in item && item.hasEOL) pageText.push("\n");
        }
        const extractedPageText = pageText.join("");
        page.cleanup();
        const substantiveCharacters = extractedPageText.replace(/[\s\p{P}\p{S}]/gu, "").length;
        if (substantiveCharacters < PDF_OCR_MIN_TEXT_CHARS) {
          quality.scannedPageCount = (quality.scannedPageCount || 0) + 1;
          if (!ocrEnabled) {
            quality.ocrStatus = "disabled";
            quality.unreadablePageCount = (quality.unreadablePageCount || 0) + 1;
          } else if (pageNumber > ocrPageLimit) {
            quality.skippedOcrPageCount = (quality.skippedOcrPageCount || 0) + 1;
            quality.ocrStatus = "partial";
            quality.unreadablePageCount = (quality.unreadablePageCount || 0) + 1;
          } else if (ocrFailure) {
            quality.ocrStatus = "unavailable";
            quality.unreadablePageCount = (quality.unreadablePageCount || 0) + 1;
          } else {
            try {
              const recognized = await (ocrRunner || ((source, number, directory, abortSignal) =>
                this.runLocalPdfOcr(source, number, directory, languages, abortSignal)))(
                filePath, pageNumber, temporaryDirectory, signal,
              );
              if (recognized.trim()) {
                quality.ocrPageCount = (quality.ocrPageCount || 0) + 1;
                yield recognized;
              } else {
                quality.unreadablePageCount = (quality.unreadablePageCount || 0) + 1;
                quality.ocrStatus = "partial";
                if (extractedPageText) yield extractedPageText;
              }
            } catch (error) {
              if (signal?.aborted) throw error;
              ocrFailure = error instanceof Error ? error.message.slice(0, 240) : "OCR command failed";
              quality.ocrFailure = ocrFailure;
              quality.ocrStatus = "unavailable";
              quality.unreadablePageCount = (quality.unreadablePageCount || 0) + 1;
              if (extractedPageText) yield extractedPageText;
            }
          }
        } else {
          quality.textLayerPageCount = (quality.textLayerPageCount || 0) + 1;
          yield extractedPageText;
        }
        if ((quality.scannedPageCount || 0) > 0 && quality.ocrStatus === "not_needed") quality.ocrStatus = "complete";
        yield "\n\n";
      }
      if ((quality.scannedPageCount || 0) > 0 && (quality.unreadablePageCount || 0) > 0 && quality.ocrStatus !== "disabled" && quality.ocrStatus !== "unavailable") {
        quality.ocrStatus = "partial";
      }
    } finally {
      await loadingTask.destroy();
    }
  }

  private static async runLocalPdfOcr(
    filePath: string,
    pageNumber: number,
    temporaryDirectory: string,
    languages: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const imagePrefix = path.join(temporaryDirectory, `page-${pageNumber}`);
    const imagePath = `${imagePrefix}.png`;
    try {
      await runLocalPdfOcrCommand("pdftoppm", [
        "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-scale-to", "1800", "-png", filePath, imagePrefix,
      ], signal);
      return await runLocalPdfOcrCommand("tesseract", [imagePath, "stdout", "-l", languages, "--psm", "3"], signal);
    } finally {
      await rm(imagePath, { force: true });
    }
  }

  private static async *extractDocxXmlText(filePath: string, signal?: AbortSignal): AsyncGenerator<string> {
    const archive = await unzipper.Open.file(filePath);
    const entry = archive.files.find((candidate) => candidate.path === "word/document.xml");
    if (!entry) throw new Error("DOCX file is missing word/document.xml");
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
      || entry.uncompressedSize > this.MAX_DOCX_XML_BYTES) {
      throw new Error(`DOCX main document XML exceeds the ${this.MAX_DOCX_XML_BYTES}-byte extraction limit`);
    }

    const decoder = new StringDecoder("utf8");
    let pending = "";
    let insideText = false;
    const stream = entry.stream();
    for await (const bytes of stream) {
      if (signal?.aborted) {
        (stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy?.();
        throw new Error("Datasource document ingestion was cancelled");
      }
      pending += decoder.write(bytes);
      while (true) {
        const tagStart = pending.indexOf("<");
        if (tagStart < 0) {
          if (insideText && pending.length > 0) {
            const trailingEntity = pending.match(/&(?:#x[0-9a-fA-F]*|#\d*|[A-Za-z]*)?$/)?.[0] || "";
            const safeLength = pending.length - trailingEntity.length;
            if (safeLength > 0) yield this.decodeDocxXmlText(pending.slice(0, safeLength));
            pending = trailingEntity;
          } else {
            pending = "";
          }
          break;
        }
        if (tagStart > 0) {
          if (insideText) yield this.decodeDocxXmlText(pending.slice(0, tagStart));
          pending = pending.slice(tagStart);
        }
        const tagEnd = pending.indexOf(">");
        if (tagEnd < 0) {
          if (pending.length > this.MAX_DOCX_XML_TOKEN_CHARS) throw new Error("DOCX contains an oversized XML tag");
          break;
        }
        const tag = pending.slice(0, tagEnd + 1);
        pending = pending.slice(tagEnd + 1);
        const closing = /^<\s*\//.test(tag);
        const localName = tag.match(/^<\s*\/?\s*[\w.-]+:([\w.-]+)/)?.[1]
          || tag.match(/^<\s*\/?\s*([\w.-]+)/)?.[1]
          || "";
        if (!closing && localName === "t") insideText = true;
        else if (closing && localName === "t") insideText = false;
        else if (!closing && (localName === "br" || localName === "cr")) yield "\n";
        else if (!closing && localName === "tab") yield "\t";
        else if (closing && localName === "tc") yield "\t";
        else if (closing && (localName === "p" || localName === "tr")) yield "\n";
      }
    }
    pending += decoder.end();
    if (insideText && pending) yield this.decodeDocxXmlText(pending);
  }

  private static decodeDocxXmlText(value: string): string {
    return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|apos|quot);/gi, (entity, token: string) => {
      const normalized = token.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "apos") return "'";
      if (normalized === "quot") return '"';
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    });
  }

  /**
   * Process raw document file into structure-aware chunks with embeddings
   */
  static async processDocument(
    fileName: string,
    buffer: Buffer,
    mimeType?: string,
  ): Promise<{ chunks: ParsedChunk[]; totalWords: number }> {
    let rawText = "";

    const lowerName = fileName.toLowerCase();

    // 1. PDF Documents: use unpdf for full stream decompression and font decoding
    if (lowerName.endsWith(".pdf") || mimeType?.includes("pdf")) {
      try {
        const pdfResult = await extractText(new Uint8Array(buffer), { mergePages: true });
        if (pdfResult.text && pdfResult.text.trim().length > 0) {
          rawText = pdfResult.text;
        } else {
          rawText = this.extractPrintableText(buffer);
        }
      } catch (err) {
        console.warn(`[KnowledgeIngestionService] PDF extraction fallback for ${fileName}:`, err);
        rawText = this.extractPrintableText(buffer);
      }
    } else if (lowerName.endsWith(".docx") || mimeType?.includes("wordprocessingml")) {
      // 2. DOCX Documents: unzip word/document.xml and strip XML tags
      const docxText = this.extractDocxText(buffer);
      if (docxText && docxText.trim().length > 0) {
        rawText = docxText;
      } else {
        rawText = this.extractPrintableText(buffer);
      }
    } else if (
      mimeType?.includes("text") ||
      fileName.endsWith(".txt") ||
      fileName.endsWith(".md") ||
      fileName.endsWith(".json") ||
      fileName.endsWith(".csv") ||
      mimeType?.includes("json") ||
      mimeType?.includes("markdown")
    ) {
      // 3. Plain text / Markdown / JSON
      rawText = buffer.toString("utf-8");
    } else {
      // 4. Fallback binary extraction
      rawText = this.extractPrintableText(buffer);
    }

    if (!rawText.trim()) {
      rawText = `Document: ${fileName}\n(Empty or unparseable document content)`;
    }

    const chunks = this.chunkText(rawText);
    const totalWords = rawText.split(/\s+/).filter(Boolean).length;

    return { chunks, totalWords };
  }

  /**
   * Stream plain-text documents into bounded chunk batches. PDF, DOCX and
   * other binary formats continue through processDocument's format parsers.
   */
  static async processTextFile(
    filePath: string,
    onChunkBatch: (chunks: ParsedChunk[]) => Promise<void>,
    options: { signal?: AbortSignal; batchSize?: number; sampleLimit?: number } = {},
  ): Promise<{ chunkCount: number; totalWords: number; sampleChunks: ParsedChunk[] }> {
    const batchSize = Math.max(1, Math.min(64, options.batchSize ?? 32));
    const sampleLimit = Math.max(0, Math.min(500, options.sampleLimit ?? 100));
    const maxLineChars = 64 * 1024;
    const chunks: ParsedChunk[] = [];
    const sampleChunks: ParsedChunk[] = [];
    let currentParagraphs: string[] = [];
    let currentWordCount = 0;
    let currentSection = "General";
    let charOffset = 0;
    let chunkIndex = 0;
    let totalWords = 0;

    const flushBatch = async () => {
      if (chunks.length < batchSize) return;
      const batch = chunks.splice(0, chunks.length);
      await onChunkBatch(batch);
    };
    const flushChunk = async () => {
      if (currentParagraphs.length === 0) return;
      const content = currentParagraphs.join("\n\n").trim();
      if (!content) return;
      const words = content.split(/\s+/).filter(Boolean);
      const chunk: ParsedChunk = {
        chunkIndex: chunkIndex++,
        title: currentSection,
        content,
        tokenCount: Math.ceil(words.length * 1.33),
        metadata: { section: currentSection, charStart: charOffset, charEnd: charOffset + content.length },
      };
      if (sampleChunks.length < sampleLimit) sampleChunks.push(chunk);
      chunks.push(chunk);
      charOffset += content.length;

      if (currentParagraphs.length > 1) {
        const overlap = currentParagraphs[currentParagraphs.length - 1]!;
        currentParagraphs = [overlap];
        currentWordCount = overlap.split(/\s+/).filter(Boolean).length;
      } else {
        currentParagraphs = [];
        currentWordCount = 0;
      }
      await flushBatch();
    };
    const consumeLine = async (line: string) => {
      if (options.signal?.aborted) throw new Error("Datasource document ingestion was cancelled");
      const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
      const trimmed = normalized.trim();
      if (!trimmed) return;
      totalWords += trimmed.split(/\s+/).filter(Boolean).length;
      const isHeader = trimmed.startsWith("#")
        || /^BAB\s+[IVXLCDM0-9]+/i.test(trimmed)
        || /^PASAL\s+[0-9]+/i.test(trimmed)
        || /^SECTION\s+[0-9]+/i.test(trimmed)
        || /^ARTICLE\s+[0-9]+/i.test(trimmed)
        || (trimmed.length >= 4 && trimmed.length < 80 && /[A-Z]/.test(trimmed)
          && trimmed === trimmed.toUpperCase() && /^[A-Z0-9\s:_-]+$/.test(trimmed)
          && !trimmed.includes("."));
      if (isHeader) {
        await flushChunk();
        currentSection = trimmed.replace(/^#+\s*/, "").trim();
        return;
      }
      const lineWords = trimmed.split(/\s+/).filter(Boolean).length;
      currentParagraphs.push(trimmed);
      currentWordCount += lineWords;
      if (currentWordCount >= 350) await flushChunk();
    };

    const stream = createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 64 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let pending = "";
    for await (const part of stream) {
      if (options.signal?.aborted) throw new Error("Datasource document ingestion was cancelled");
      pending += part;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        let line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        while (line.length > maxLineChars) {
          const splitAt = line.lastIndexOf(" ", maxLineChars);
          const safeSplit = splitAt > maxLineChars / 2 ? splitAt : maxLineChars;
          await consumeLine(line.slice(0, safeSplit));
          line = line.slice(safeSplit);
        }
        await consumeLine(line);
        newlineIndex = pending.indexOf("\n");
      }
      while (pending.length > maxLineChars) {
        const splitAt = pending.lastIndexOf(" ", maxLineChars);
        const safeSplit = splitAt > maxLineChars / 2 ? splitAt : maxLineChars;
        await consumeLine(pending.slice(0, safeSplit));
        pending = pending.slice(safeSplit);
      }
    }
    if (pending.length > 0) {
      while (pending.length > maxLineChars) {
        const splitAt = pending.lastIndexOf(" ", maxLineChars);
        const safeSplit = splitAt > maxLineChars / 2 ? splitAt : maxLineChars;
        await consumeLine(pending.slice(0, safeSplit));
        pending = pending.slice(safeSplit);
      }
      await consumeLine(pending);
    }
    await flushChunk();
    if (chunks.length > 0) await onChunkBatch(chunks.splice(0, chunks.length));
    return { chunkCount: chunkIndex, totalWords, sampleChunks };
  }

  /**
   * Structure-Aware Chunker preserving headings and context
   */
  private static chunkText(text: string): ParsedChunk[] {
    const lines = text.split("\n");
    const chunks: ParsedChunk[] = [];

    let currentSection = "General";
    let currentParagraphs: string[] = [];
    let currentWordCount = 0;
    let charOffset = 0;
    let chunkIndex = 0;

    const flushChunk = () => {
      if (currentParagraphs.length === 0) return;

      const chunkContent = currentParagraphs.join("\n\n").trim();
      if (!chunkContent) return;

      const words = chunkContent.split(/\s+/).filter(Boolean);
      const tokenCount = Math.ceil(words.length * 1.33);

      chunks.push({
        chunkIndex: chunkIndex++,
        title: currentSection,
        content: chunkContent,
        tokenCount,
        metadata: {
          section: currentSection,
          charStart: charOffset,
          charEnd: charOffset + chunkContent.length,
        },
      });

      // Keep last paragraph as overlap if multiple paragraphs exist
      if (currentParagraphs.length > 1) {
        const overlap = currentParagraphs[currentParagraphs.length - 1];
        currentParagraphs = [overlap];
        currentWordCount = overlap.split(/\s+/).filter(Boolean).length;
      } else {
        currentParagraphs = [];
        currentWordCount = 0;
      }

      charOffset += chunkContent.length;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Check if line is a header / section
      const isHeader =
        line.startsWith("#") ||
        /^BAB\s+[IVXLCDM0-9]+/i.test(line) ||
        /^PASAL\s+[0-9]+/i.test(line) ||
        /^SECTION\s+[0-9]+/i.test(line) ||
        /^ARTICLE\s+[0-9]+/i.test(line) ||
        (line.length >= 4 &&
         line.length < 80 &&
         /[A-Z]/.test(line) &&
         line === line.toUpperCase() &&
         /^[A-Z0-9\s:_-]+$/.test(line) &&
         !line.includes("."));

      if (isHeader) {
        if (currentParagraphs.length > 0) {
          flushChunk();
        }
        currentSection = line.replace(/^#+\s*/, "").trim();
        continue;
      }

      const lineWords = line.split(/\s+/).filter(Boolean).length;
      currentParagraphs.push(line);
      currentWordCount += lineWords;

      // When word threshold (~350 words) is reached, flush chunk
      if (currentWordCount >= 350) {
        flushChunk();
      }
    }

    if (currentParagraphs.length > 0) {
      flushChunk();
    }

    return chunks;
  }

  /**
   * Cosine similarity between two vector embeddings
   */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Extract readable ASCII/Unicode text streams from binary files
   */
  private static extractPrintableText(buffer: Buffer): string {
    const raw = buffer.toString("latin1");
    // Match sequences of printable characters
    const matches = raw.match(/[\x20-\x7E\t\r\n]{4,}/g);
    if (!matches || matches.length === 0) {
      return buffer.toString("utf-8").replace(/[^\x20-\x7E\t\r\n]/g, " ");
    }
    return matches.join("\n").replace(/[\r\n]{3,}/g, "\n\n");
  }

  /**
   * Extract readable text from DOCX (PKZip containing word/document.xml)
   */
  private static extractDocxText(buffer: Buffer): string | null {
    try {
      // 1. Search for End of Central Directory record: PK\x05\x06 (0x06054b50)
      for (let i = buffer.length - 22; i >= 0; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
          const cdCount = buffer.readUInt16LE(i + 10);
          const cdOffset = buffer.readUInt32LE(i + 16);

          let cur = cdOffset;
          for (let j = 0; j < cdCount; j++) {
            if (cur + 46 > buffer.length) break;
            if (buffer.readUInt32LE(cur) !== 0x02014b50) break;
            const compMethod = buffer.readUInt16LE(cur + 10);
            const compSize = buffer.readUInt32LE(cur + 20);
            const nameLen = buffer.readUInt16LE(cur + 28);
            const extraLen = buffer.readUInt16LE(cur + 30);
            const commentLen = buffer.readUInt16LE(cur + 32);
            const localHeaderOffset = buffer.readUInt32LE(cur + 42);
            const name = buffer.toString("utf8", cur + 46, cur + 46 + nameLen);

            if (name === "word/document.xml") {
              if (localHeaderOffset + 30 > buffer.length) break;
              const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
              const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
              const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;
              if (dataOffset + compSize > buffer.length) break;
              const compressedData = buffer.subarray(dataOffset, dataOffset + compSize);

              let xml = "";
              if (compMethod === 8) {
                xml = zlib.inflateRawSync(compressedData).toString("utf8");
              } else if (compMethod === 0) {
                xml = compressedData.toString("utf8");
              }

              if (xml) {
                return xml
                  .replace(/<w:p[^>]*>/gi, "")
                  .replace(/<\/w:p>/gi, "\n\n")
                  .replace(/<\/w:tr>/gi, "\n")
                  .replace(/<\/w:tc>/gi, "\t")
                  .replace(/<w:br[^>]*>/gi, "\n")
                  .replace(/<w:tab[^>]*>/gi, "\t")
                  .replace(/<[^>]+>/g, "")
                  .replace(/&amp;/g, "&")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">")
                  .replace(/&quot;/g, '"')
                  .replace(/&apos;/g, "'")
                  .trim();
              }
            }
            cur += 46 + nameLen + extraLen + commentLen;
          }
          break;
        }
      }
    } catch {
      // Fallback to extractPrintableText
      return null;
    }
    return null;
  }
}
