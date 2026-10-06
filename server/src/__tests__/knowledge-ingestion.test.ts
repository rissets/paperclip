import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { KnowledgeIngestionService } from "../services/knowledge-ingestion.js";

function createMockDocx(paragraphs: string[]): Buffer {
  const xml = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join("");
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${xml}</w:body></w:document>`;
  const comp = zlib.deflateRawSync(Buffer.from(documentXml, "utf8"));
  const name = "word/document.xml";
  const nameBuf = Buffer.from(name, "utf8");

  // Local file header
  const lh = Buffer.alloc(30 + nameBuf.length);
  lh.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0, 6);
  lh.writeUInt16LE(8, 8); // deflate
  lh.writeUInt32LE(0, 10);
  lh.writeUInt32LE(0, 14);
  lh.writeUInt32LE(comp.length, 18);
  lh.writeUInt32LE(Buffer.byteLength(documentXml, "utf8"), 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);
  nameBuf.copy(lh, 30);

  // Central Directory header
  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(0, 12);
  cd.writeUInt32LE(0, 16);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(Buffer.byteLength(documentXml, "utf8"), 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42); // offset 0
  nameBuf.copy(cd, 46);

  // End of Central Directory
  const cdOffset = lh.length + comp.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lh, comp, cd, eocd]);
}

describe("KnowledgeIngestionService", () => {
  it("processes docx file and extracts clean text paragraphs", async () => {
    const docxBuf = createMockDocx([
      "Panduan Dashboard Mahasiswa FK MILMED",
      "Universitas Pertahanan Republik Indonesia",
      "Dokumen ini berisi panduan penggunaan sistem LMS militer dan kedokteran.",
    ]);

    const result = await KnowledgeIngestionService.processDocument(
      "Panduan_Dashboard_Mahasiswa_FK_MILMED.docx",
      docxBuf,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.totalWords).toBeGreaterThan(5);
    expect(result.chunks[0].content).toContain("Panduan Dashboard Mahasiswa FK MILMED");
    expect(result.chunks[0].content).toContain("Universitas Pertahanan Republik Indonesia");
    expect(result.chunks[0].embedding).toBeUndefined();
  });

  it("processes pdf file and extracts readable text", async () => {
    const minimalPdf =
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 712 Td (Danang Haris Setiawan CV) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \n0000000212 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n307\n%%EOF";

    const result = await KnowledgeIngestionService.processDocument(
      "Danang Haris Setiawan CV.pdf",
      Buffer.from(minimalPdf),
      "application/pdf",
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks[0].content).toContain("Danang Haris Setiawan CV");
  });

  it("streams text files into bounded chunk batches while preserving section order", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-rag-stream-"));
    const filePath = path.join(directory, "large-policy.md");
    const sectionCount = 180;
    const text = Array.from({ length: sectionCount }, (_, index) => `## Section ${index + 1}\n\nThis policy section describes the service obligation and customer support process for region ${index + 1}.`).join("\n\n");
    await writeFile(filePath, text, "utf8");
    try {
      const batches: Array<Array<{ chunkIndex: number; title: string | null; content: string }>> = [];
      const streamed = await KnowledgeIngestionService.processTextFile(filePath, async (batch) => {
        batches.push(batch);
      });

      expect(streamed.chunkCount).toBe(sectionCount);
      expect(streamed.totalWords).toBe(text.split(/\s+/).filter(Boolean).length);
      expect(batches.map((batch) => batch.length)).toEqual([32, 32, 32, 32, 32, 20]);
      expect(batches.flat().map((chunk) => chunk.chunkIndex)).toEqual(Array.from({ length: sectionCount }, (_, index) => index));
      expect(batches.flat()[0]).toMatchObject({ title: "Section 1", content: expect.stringContaining("service obligation") });
      expect(streamed.sampleChunks[39]?.title).toBe("Section 40");
      expect(streamed.sampleChunks).toHaveLength(100);
      expect(streamed.sampleChunks.at(-1)?.title).toBe("Section 100");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("streams DOCX XML into bounded chunk batches and decodes XML entities", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-rag-docx-stream-"));
    const filePath = path.join(directory, "large-policy.docx");
    const paragraphs = Array.from({ length: 80 }, (_, index) => [
      `## Section ${index + 1}`,
      `Customer service &amp; network operations region ${index + 1}.`,
    ]).flat();
    await writeFile(filePath, createMockDocx(paragraphs), { mode: 0o600 });
    try {
      const batches: Array<Array<{ chunkIndex: number; title: string | null; content: string }>> = [];
      const streamed = await KnowledgeIngestionService.processDocumentFile(filePath, "large-policy.docx", async (batch) => {
        batches.push(batch);
      });
      const chunks = batches.flat();

      expect(streamed.chunkCount).toBe(80);
      expect(batches.map((batch) => batch.length)).toEqual([32, 32, 16]);
      expect(chunks[0]).toMatchObject({ title: "Section 1", content: expect.stringContaining("Customer service & network operations") });
      expect(chunks.at(-1)?.title).toBe("Section 80");
      expect(streamed.sampleChunks).toHaveLength(80);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("streams PDF pages into the same bounded RAG chunk pipeline", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-rag-pdf-stream-"));
    const filePath = path.join(directory, "policy.pdf");
    const minimalPdf =
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 712 Td (Danang Haris Setiawan Curriculum Vitae 2026) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \n0000000212 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n307\n%%EOF";
    await writeFile(filePath, minimalPdf, { mode: 0o600 });
    try {
      const batches: Array<Array<{ content: string }>> = [];
      const streamed = await KnowledgeIngestionService.processDocumentFile(filePath, "policy.pdf", async (batch) => {
        batches.push(batch);
      });

      expect(streamed.chunkCount).toBeGreaterThan(0);
      expect(batches.flat().map((chunk) => chunk.content).join("\n")).toContain("Danang Haris Setiawan Curriculum Vitae 2026");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("detects sparse PDF text and exposes bounded local OCR quality", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-rag-pdf-ocr-"));
    const filePath = path.join(directory, "scanned.pdf");
    const scannedPdf = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 712 Td (Scan) Tj ET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000056 00000 n \n0000000111 00000 n \n0000000212 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n307\n%%EOF";
    await writeFile(filePath, scannedPdf, { mode: 0o600 });
    try {
      const batches: Array<Array<{ content: string }>> = [];
      const streamed = await KnowledgeIngestionService.processDocumentFile(
        filePath,
        "scanned.pdf",
        async (batch) => { batches.push(batch); },
        { pdfOcrPage: async (_source, pageNumber) => `OCR recognized page ${pageNumber}: maintenance work order` },
      );

      expect(streamed.extractionQuality).toMatchObject({
        extractor: "pdfjs",
        pageCount: 1,
        textLayerPageCount: 0,
        scannedPageCount: 1,
        ocrPageCount: 1,
        unreadablePageCount: 0,
        ocrStatus: "complete",
      });
      expect(batches.flat().map((chunk) => chunk.content).join("\n")).toContain("OCR recognized page 1");
      await expect(KnowledgeIngestionService.processDocumentFile(
        filePath,
        "unreadable-scan.pdf",
        async () => {},
        { pdfOcrPage: async () => "" },
      )).rejects.toThrow("PDF OCR did not produce text");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("splits a single extremely long text line into bounded chunks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paperclip-rag-long-line-"));
    const filePath = path.join(directory, "long-line.txt");
    await writeFile(filePath, "customer ".repeat(20_000), "utf8");
    try {
      const batches: Array<Array<{ content: string }>> = [];
      const streamed = await KnowledgeIngestionService.processTextFile(filePath, async (batch) => { batches.push(batch); });
      const chunks = batches.flat();
      expect(streamed.chunkCount).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.content.length <= 64 * 1024)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
