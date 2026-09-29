/**
 * PDF to image conversion utility.
 * Uses dynamic import so pdfjs-dist doesn't crash module loading if unavailable.
 */

/**
 * Checks if a data URL represents a PDF file.
 */
export function isPdfDataUrl(dataUrl: string): boolean {
  return dataUrl.startsWith("data:application/pdf");
}

/**
 * Converts a PDF data URL to a PNG data URL by rendering the first page.
 * Uses dynamic import to avoid crashing if pdfjs-dist has issues loading.
 */
export async function pdfToImageDataUrl(
  pdfDataUrl: string,
  targetWidth = 1200,
  targetHeight = 800
): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist");

    // Set worker source
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.mjs",
      import.meta.url
    ).toString();

    // Extract base64 data from the data URL
    const base64 = pdfDataUrl.split(",")[1];
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Load the PDF document
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const page = await pdf.getPage(1);

    // Calculate scale to fit within target dimensions
    const viewport = page.getViewport({ scale: 1 });
    const scaleX = targetWidth / viewport.width;
    const scaleY = targetHeight / viewport.height;
    const scale = Math.min(scaleX, scaleY);

    const scaledViewport = page.getViewport({ scale });

    // Create an offscreen canvas and render the page
    const canvas = document.createElement("canvas");
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;
    const context = canvas.getContext("2d")!;

    await page.render({
      canvasContext: context,
      viewport: scaledViewport,
    } as any).promise;

    return canvas.toDataURL("image/png");
  } catch (error) {
    console.warn("PDF rendering failed:", error);
    throw new Error("Could not render PDF. Please convert to PNG/JPG first.");
  }
}
