const sharp = require('sharp');

/**
 * 檢測圖片中的水平線
 * @param {Buffer} imageBuffer - 圖片 Buffer
 * @param {Object} options - 檢測選項
 * @returns {Promise<Array>} 檢測到的線條
 */
async function detectHorizontalLines(imageBuffer, options = {}) {
  const minLength = options.minLength || 30;
  const maxThickness = options.maxThickness || 3;
  const threshold = options.threshold || 50;
  
  // Step 1: 圖像預處理（灰度化 + 二值化）
  const { data, info } = await sharp(imageBuffer)
    .greyscale()
    .threshold(threshold)
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const { width, height } = info;
  
  // Step 2: 逐行掃描檢測水平線
  const lines = [];
  const processedRows = new Set(); // 避免重複檢測同一條線
  
  for (let y = 0; y < height; y++) {
    // 跳過已處理的行（厚線條）
    if (processedRows.has(y)) continue;
    
    let lineStart = null;
    let lineLength = 0;
    let gapCount = 0;
    const maxGap = 5; // 允許的最大間隔
    
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const pixelValue = data[pixelIndex];
      
      // 黑色像素（值接近 0）
      const isBlack = pixelValue < 50;
      
      if (isBlack) {
        if (lineStart === null) {
          lineStart = x;
        }
        lineLength++;
        gapCount = 0;
      } else {
        // 白色像素
        if (lineLength > 0) {
          gapCount++;
          
          // 間隔太大，結束這條線
          if (gapCount > maxGap) {
            if (lineLength >= minLength) {
              // 檢測線條厚度
              const thickness = measureLineThickness(data, width, height, lineStart, y, lineLength);
              
              if (thickness <= maxThickness) {
                lines.push({
                  startX: lineStart,
                  endX: lineStart + lineLength,
                  y: y,
                  length: lineLength,
                  thickness: thickness
                });
                
                // 標記已處理的行
                for (let ty = y; ty < Math.min(y + thickness, height); ty++) {
                  processedRows.add(ty);
                }
              }
            }
            
            lineStart = null;
            lineLength = 0;
            gapCount = 0;
          } else {
            // 小間隔，計入線長
            lineLength++;
          }
        }
      }
    }
    
    // 處理行尾的線
    if (lineLength >= minLength) {
      const thickness = measureLineThickness(data, width, height, lineStart, y, lineLength);
      
      if (thickness <= maxThickness) {
        lines.push({
          startX: lineStart,
          endX: lineStart + lineLength,
          y: y,
          length: lineLength,
          thickness: thickness
        });
      }
    }
  }
  
  // Step 3: 過濾和清理
  const filteredLines = filterLines(lines, width, height);
  
  return filteredLines;
}

/**
 * 測量線條厚度
 */
function measureLineThickness(data, width, height, startX, startY, length) {
  let thickness = 1;
  
  // 向下檢查連續的黑色行
  for (let dy = 1; dy < 10; dy++) {
    const checkY = startY + dy;
    if (checkY >= height) break;
    
    let blackPixelCount = 0;
    const samplePoints = Math.min(10, length);
    
    for (let i = 0; i < samplePoints; i++) {
      const checkX = startX + Math.floor((length / samplePoints) * i);
      if (checkX >= width) continue;
      
      const pixelIndex = checkY * width + checkX;
      if (data[pixelIndex] < 50) {
        blackPixelCount++;
      }
    }
    
    // 如果大部分採樣點都是黑色，認為是同一條線
    if (blackPixelCount / samplePoints > 0.7) {
      thickness++;
    } else {
      break;
    }
  }
  
  return thickness;
}

/**
 * 過濾和清理檢測到的線條
 */
function filterLines(lines, imageWidth, imageHeight) {
  return lines.filter(line => {
    // 過濾太短的線
    if (line.length < 30) return false;
    
    // 過濾太長的線（可能是表格邊框）
    if (line.length > imageWidth * 0.85) return false;
    
    // 過濾太接近頁面邊緣的線
    if (line.y < 50 || line.y > imageHeight - 50) return false;
    
    return true;
  });
}

module.exports = {
  detectHorizontalLines
};