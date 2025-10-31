/**
 * 將像素座標轉換為 PDF 座標
 * @param {number} pixelX - 像素 X 座標
 * @param {number} pixelY - 像素 Y 座標
 * @param {number} imageWidth - 圖片寬度
 * @param {number} imageHeight - 圖片高度
 * @param {number} pdfPageWidth - PDF 頁面寬度
 * @param {number} pdfPageHeight - PDF 頁面高度
 * @returns {Object} PDF 座標 { x, y }
 */
function pixelToPDFCoordinates(
  pixelX, 
  pixelY, 
  imageWidth, 
  imageHeight, 
  pdfPageWidth, 
  pdfPageHeight
) {
  // 計算縮放比例
  const scaleX = pdfPageWidth / imageWidth;
  const scaleY = pdfPageHeight / imageHeight;
  
  // 轉換 X 座標（左對齊）
  const pdfX = pixelX * scaleX;
  
  // 轉換 Y 座標（翻轉 Y 軸，因為 PDF 原點在左下角，圖片在左上角）
  const pdfY = pdfPageHeight - (pixelY * scaleY);
  
  return {
    x: pdfX,
    y: pdfY
  };
}

/**
 * 將 PDF 座標轉換回像素座標（用於調試）
 */
function pdfToPixelCoordinates(
  pdfX,
  pdfY,
  imageWidth,
  imageHeight,
  pdfPageWidth,
  pdfPageHeight
) {
  const scaleX = imageWidth / pdfPageWidth;
  const scaleY = imageHeight / pdfPageHeight;
  
  const pixelX = pdfX * scaleX;
  const pixelY = (pdfPageHeight - pdfY) * scaleY;
  
  return {
    x: pixelX,
    y: pixelY
  };
}

module.exports = {
  pixelToPDFCoordinates,
  pdfToPixelCoordinates
};