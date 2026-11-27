export function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => {
            const result = reader.result;
            if (typeof result !== 'string') {
                reject(new Error('FileReader produced non-string result.'));
                return;
            }
            // result is a data URL of the form `data:<mime>;base64,<payload>`.
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : '');
        });
        reader.addEventListener('error', () => {
            return reject(reader.error ?? new Error('FileReader failed.'));
        });
        reader.readAsDataURL(file);
    });
}

/**
 * Browsers don't agree on whether dragged files land in `dataTransfer.files` or
 * `dataTransfer.items`. The macOS screenshot-thumbnail drag in particular tends to surface the file
 * only through `items` (kind === 'file'). Collect from both, dedupe by reference.
 */
export function collectDroppedFiles(transfer: DataTransfer): File[] {
    const seen = new Set<File>();
    Array.from(transfer.files).forEach((file) => seen.add(file));
    Array.from(transfer.items).forEach((item) => {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) {
                seen.add(file);
            }
        }
    });
    return Array.from(seen);
}

/**
 * The image's center square as a data URL, scaled down to at most `size` pixels wide, like a
 * thumbnail shown with `object-fit: cover`. Small enough to keep in localStorage, unlike the full
 * image. Rejects when the browser can't decode the image.
 */
export async function toImageThumbnailUrl({file, size}: Readonly<{file: File; size: number}>) {
    const bitmap = await createImageBitmap(file);
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(size, side);
    canvas.height = canvas.width;
    canvas
        .getContext('2d')
        ?.drawImage(
            bitmap,
            (bitmap.width - side) / 2,
            (bitmap.height - side) / 2,
            side,
            side,
            0,
            0,
            canvas.width,
            canvas.height,
        );
    bitmap.close();
    return canvas.toDataURL('image/webp');
}
