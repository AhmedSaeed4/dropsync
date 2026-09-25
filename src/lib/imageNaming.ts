// Shared helpers for AI naming of PASTED images (classic + editorial dropzones, Order 37).
// The dropzone toggle (default OFF) decides whether a pasted image takes the AI trip at all;
// every path ends in a clean drop name — the old "pasted-image-<timestamp>" junk is gone.

// Asks the in-app naming route (/api/image-name) what the pasted image shows. Returns a short
// sanitized name, or null on ANY failure (network, auth, daily cap, provider) — callers then
// fall back to a plain "Pasted image" name and the upload proceeds regardless. Never throws.
export async function aiNameForImage(file: File, authToken: string): Promise<string | null> {
  try {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/image-name', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: form,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { name?: string };
    const name = (data.name ?? '').trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

// Rebuilds the pasted File under its final drop name: baseName (+ " N" when several images
// were pasted at once, so equal fallback names cannot collide) + the original extension.
export function renamePastedFile(file: File, baseName: string, index: number, total: number): File {
  const ext = file.type.split('/')[1] || 'png';
  const suffix = total > 1 ? ` ${index + 1}` : '';
  return new File([file], `${baseName}${suffix}.${ext}`, { type: file.type });
}
