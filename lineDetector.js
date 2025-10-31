const sharp = require('sharp');

/**
 * 在指定區域檢測水平線（關鍵函數！）
 */
async function detectHorizontalLinesInRegion(imageBuffer, region, options = {}) {
  const minLength = options.minLength || 20;
  const maxThickness = options.maxThickness || 3;
  const threshold = options.threshold || 50;
  
  const [x1, y1, x2, y2] = region;
  const regionWidth = Math.floor(x2 - x1);
  const regionHeight = Math.floor(y2 - y1);
  
  // 裁切圖片到指定區域
  const croppedBuffer = await sharp(imageBuffer)
    .extract({
      left: Math.floor(x1),
      top: Math.floor(y1),
      width: regionWidth,
      height: regionHeight
    })
    .greyscale()
    .threshold(threshold)
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const { data, info } = croppedBuffer;
  const { width, height } = info;
  
  // 在裁切圖片中檢測線條
  const lines = [];
  const processedRows = new Set();
  
  for (let y = 0; y < height; y++) {
    if (processedRows.has(y)) continue;
    
    let lineStart = null;
    let lineLength = 0;
    let gapCount = 0;
    const maxGap = 3;
    
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const pixelValue = data[pixelIndex];
      const isBlack = pixelValue < 50;
      
      if (isBlack) {
        if (lineStart === null) {
          lineStart = x;
        }
        lineLength++;
        gapCount = 0;
      } else {
        if (lineLength > 0) {
          gapCount++;
          
          if (gapCount > maxGap) {
            if (lineLength >= minLength) {
              const thickness = measureLineThickness(data, width, height, lineStart, y, lineLength);
              
              if (thickness <= maxThickness) {
                // 將裁切圖片的座標轉回完整圖片座標
                lines.push({
                  startX: x1 + lineStart,
                  endX: x1 + lineStart + lineLength,
                  y: y1 + y,
                  length: lineLength,
                  thickness: thickness
                });
                
                for (let ty = y; ty < Math.min(y + thickness, height); ty++) {
                  processedRows.add(ty);
                }
              }
            }
            
            lineStart = null;
            lineLength = 0;
            gapCount = 0;
          } else {
            lineLength++;
          }
        }
      }
    }
    
    // 處理行尾
    if (lineLength >= minLength) {
      const thickness = measureLineThickness(data, width, height, lineStart, y, lineLength);
      
      if (thickness <= maxThickness) {
        lines.push({
          startX: x1 + lineStart,
          endX: x1 + lineStart + lineLength,
          y: y1 + y,
          length: lineLength,
          thickness: thickness
        });
      }
    }
  }
  
  return lines;
}

/**
 * 測量線條厚度
 */
function measureLineThickness(data, width, height, startX, startY, length) {
  let thickness = 1;
  
  for (let dy = 1; dy < 10; dy++) {
    const checkY = startY + dy;
    if (checkY >= height) break;
    
    let blackPixelCount = 0;
    const samplePoints = Math.min(5, length);
    
    for (let i = 0; i < samplePoints; i++) {
      const checkX = startX + Math.floor((length / samplePoints) * i);
      if (checkX >= width) continue;
      
      const pixelIndex = checkY * width + checkX;
      if (data[pixelIndex] < 50) {
        blackPixelCount++;
      }
    }
    
    if (blackPixelCount / samplePoints > 0.6) {
      thickness++;
    } else {
      break;
    }
  }
  
  return thickness;
}

module.exports = {
  detectHorizontalLinesInRegion
};