import { del, put } from "@vercel/blob";

const allowedExtensions = new Set(["csv", "xlsx", "xls"]);

export async function uploadImport(projectId: string, file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!allowedExtensions.has(extension)) throw new Error("Unsupported import format");

  return put(`imports/${projectId}/${crypto.randomUUID()}-${file.name}`, file, {
    access: "private",
    addRandomSuffix: false,
  });
}

export async function deleteImport(url: string) {
  await del(url);
}
