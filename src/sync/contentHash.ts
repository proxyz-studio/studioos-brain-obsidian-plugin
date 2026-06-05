/** SHA-256 hex digest of a UTF-8 string. Browser-friendly (uses crypto.subtle). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const subtle = (globalThis as { crypto?: { subtle?: { digest: (a: string, d: Uint8Array) => Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (!subtle) throw new Error('crypto.subtle unavailable');
  const buf = await subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
