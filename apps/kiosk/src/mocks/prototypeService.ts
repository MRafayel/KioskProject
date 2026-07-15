import type { PrototypeFile } from "../features/session/model.js";

export async function simulatePhoneUpload(): Promise<PrototypeFile> {
  return Promise.resolve({
    id: "prototype-file-01",
    name: "sample-document.pdf",
    mimeType: "application/pdf",
    pageCount: 8,
    sizeBytes: 2_400_000
  });
}
