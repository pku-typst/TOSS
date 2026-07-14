export function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < data.length; index += chunkSize) {
    const end = Math.min(data.length, index + chunkSize);
    let chunk = "";
    for (let byteIndex = index; byteIndex < end; byteIndex += 1) {
      chunk += String.fromCharCode(data[byteIndex]);
    }
    binary += chunk;
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
