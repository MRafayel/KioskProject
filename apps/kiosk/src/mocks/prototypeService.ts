import type { PrototypeFile, PrototypeSession } from "../features/session/model.js";

export async function createPrototypeSession(): Promise<PrototypeSession> {
  const uploadOrigin = import.meta.env.VITE_PUBLIC_UPLOAD_ORIGIN ?? "http://localhost:5174";

  return Promise.resolve({
    id: "prototype-session-01",
    shortCode: "482 913",
    uploadUrl: `${uploadOrigin}/#/upload/prototype-session-01?token=prototype-only`,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });
}

export async function simulatePhoneUpload(): Promise<PrototypeFile> {
  return Promise.resolve({
    id: "prototype-file-01",
    name: "sample-document.pdf",
    mimeType: "application/pdf",
    pageCount: 8,
    sizeBytes: 2_400_000
  });
}
