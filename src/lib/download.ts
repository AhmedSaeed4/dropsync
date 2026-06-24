// Fetch a public R2 fileUrl as a Blob (binary-safe) and trigger a same-origin download via a
// blob: URL. Used for binary (fileFormat='binary') drops, where the legacy data-URI download path
// would corrupt real bytes. The fileUrl is public (no auth) and CORS already allows the app
// origin (the app fetches R2 client-side elsewhere). A blob: URL is same-origin, so the
// `download` attribute (and thus the filename) is honored — avoids the cross-origin download
// problem of linking the remote URL directly.
export async function downloadBinaryFromUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
