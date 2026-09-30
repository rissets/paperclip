import zlib from "node:zlib";
import { extractText } from "unpdf";

export interface ParsedChunk {
  chunkIndex: number;
  title: string | null;
  content: string;
  tokenCount: number;
  metadata: {
    section?: string;
    charStart: number;
    charEnd: number;
  };
  embedding?: number[];
}

export class KnowledgeIngestionService {
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

      const embedding = this.generateEmbedding(chunkContent);

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
        embedding,
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
   * Lightweight in-memory semantic embedding generator (128 dimensions)
   * Uses hashing + n-gram term frequencies for fast cosine-similarity scoring
   */
  static generateEmbedding(text: string): number[] {
    const dim = 128;
    const vec = new Float64Array(dim);
    const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    const words = normalized.split(/\s+/).filter(Boolean);

    const stopWords = new Set(["dan", "di", "ke", "dari", "yang", "untuk", "pada", "dengan", "ini", "itu", "the", "and", "to", "of", "in", "is", "a"]);

    // Unigrams, Bigrams, and Subword Trigrams
    for (let i = 0; i < words.length; i++) {
      const w1 = words[i];
      if (w1.length < 2) continue;

      const weight = stopWords.has(w1) ? 0.1 : 1.0;

      let hash = 0;
      for (let j = 0; j < w1.length; j++) {
        hash = (hash << 5) - hash + w1.charCodeAt(j);
        hash |= 0;
      }
      const idx = Math.abs(hash) % dim;
      vec[idx] += 1.0 * weight;

      // Subword character trigrams for semantic/morphological robustness
      if (!stopWords.has(w1) && w1.length >= 3) {
        for (let k = 0; k <= w1.length - 3; k++) {
          const tri = w1.slice(k, k + 3);
          let triHash = 0;
          for (let m = 0; m < tri.length; m++) {
            triHash = (triHash << 5) - triHash + tri.charCodeAt(m);
            triHash |= 0;
          }
          vec[Math.abs(triHash) % dim] += 0.4;
        }
      }

      if (i < words.length - 1) {
        const w2 = words[i + 1];
        const bigram = `${w1}_${w2}`;
        let bhash = 0;
        for (let j = 0; j < bigram.length; j++) {
          bhash = (bhash << 5) - bhash + bigram.charCodeAt(j);
          bhash |= 0;
        }
        const bidx = Math.abs(bhash) % dim;
        vec[bidx] += 1.5 * weight;
      }
    }

    // Normalize vector (L2 norm)
    let sumSq = 0;
    for (let i = 0; i < dim; i++) {
      sumSq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(sumSq) || 1.0;
    const result: number[] = [];
    for (let i = 0; i < dim; i++) {
      result.push(Number((vec[i] / norm).toFixed(6)));
    }
    return result;
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

