const { fromBuffer } = require('pdf2pic');
const sharp = require('sharp');

/**
 * 將 PDF 轉換為圖片
 * @param {Buffer} pdfBuffer - PDF 文件的 Buffer
 * @param {Object} options - 選項
 * @param {number} options.dpi - 解析度 (預設 300)
 * @returns {Promise<Array>} 圖片數組
 */
async function convertPDFToImages(pdfBuffer, options = {}) {
  const dpi = options.dpi || 300;
  
  const converter = fromBuffer(pdfBuffer, {
    density: dpi,
    saveFilename: "page",
    savePath: "./temp",
    format: "png",
    width: Math.floor(8.5 * dpi),  // Letter size width
    height: Math.floor(11 * dpi)   // Letter size height
  });
  
  const images = [];
  let pageNumber = 1;
  
  while (true) {
    try {
      const result = await converter(pageNumber, { responseType: 'buffer' });
      
      // 使用 Sharp 獲取圖片信息
      const metadata = await sharp(result.buffer).metadata();
      
      images.push({
        page: pageNumber - 1,
        buffer: result.buffer,
        width: metadata.width,
        height: metadata.height,
        format: metadata.format
      });
      
      pageNumber++;
    } catch (error) {
      // 沒有更多頁面了
      break;
    }
  }
  
  return images;
}

module.exports = {
  convertPDFToImages
};