const { getDocument } = require('pdfjs-dist/legacy/build/pdf');
const { createCanvas } = require('canvas');
const sharp = require('sharp');

/**
 * 將 PDF 轉換為圖片（使用 pdfjs-dist + canvas）
 */
async function convertPDFToImages(pdfBuffer, options = {}) {
  const dpi = options.dpi || 300;
  const scale = dpi / 72; // PDF 默認 72 DPI
  
  try {
    console.log(`Loading PDF (${pdfBuffer.length} bytes)...`);
    
    // 加載 PDF - 重要：不要設置 worker
    const loadingTask = getDocument({
      data: new Uint8Array(pdfBuffer),
      verbosity: 0,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true
    });
    
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    
    console.log(`PDF loaded successfully: ${numPages} pages`);
    
    if (numPages === 0) {
      throw new Error('PDF has no pages');
    }
    
    const images = [];
    
    // 逐頁轉換
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      console.log(`  Converting page ${pageNum}/${numPages}...`);
      
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale });
      
      console.log(`    Viewport: ${viewport.width.toFixed(0)}x${viewport.height.toFixed(0)}`);
      
      // 創建 canvas
      const canvas = createCanvas(viewport.width, viewport.height);
      const context = canvas.getContext('2d');
      
      // 設置白色背景
      context.fillStyle = 'white';
      context.fillRect(0, 0, viewport.width, viewport.height);
      
      // 渲染 PDF 頁面到 canvas
      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };
      
      await page.render(renderContext).promise;
      
      console.log(`    Rendered successfully`);
      
      // 轉換 canvas 為 PNG buffer
      const imageBuffer = canvas.toBuffer('image/png');
      
      // 使用 Sharp 獲取元數據
      const metadata = await sharp(imageBuffer).metadata();
      
      console.log(`    Image: ${metadata.width}x${metadata.height}px, ${(imageBuffer.length / 1024).toFixed(2)} KB`);
      
      images.push({
        page: pageNum - 1,
        buffer: imageBuffer,
        width: metadata.width,
        height: metadata.height,
        format: 'png'
      });
    }
    
    console.log(`✓ Successfully converted ${images.length} pages`);
    return images;
    
  } catch (error) {
    console.error('[ERROR] PDF conversion failed:', error);
    console.error('Error stack:', error.stack);
    throw new Error(`PDF conversion failed: ${error.message}`);
  }
}

module.exports = {
  convertPDFToImages
};