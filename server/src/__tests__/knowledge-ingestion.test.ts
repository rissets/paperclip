import { describe, expect, it } from "vitest";
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
    expect(result.chunks[0].embedding).toHaveLength(128);
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
});
