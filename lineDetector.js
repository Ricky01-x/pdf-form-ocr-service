const sharp = require('sharp');

/**
 * 在圖片的特定區域檢測水平線
 * @param {Buffer} imageBuffer - 完整圖片 Buffer
 * @param {number} fullImageWidth - 完整圖片寬度
 * @param {number} fullImageHeight - 完整圖片高度
 * @param {Object} region - 要掃描的區域 {x, y, width, height}
 * @param {Object} options - 檢測選項
 */
async function detectHorizontalLinesInRegion(imageBuffer, fullImageWidth, fullImageHeight, region, options = {}) {
  const minLength = options.minLength || 20;
  const maxThickness = options.maxThickness || 3;
  const threshold = options.threshold || 50;
  
  try {
    // 驗證區域參數
    if (!region || typeof region !== 'object') {
      console.error('Invalid region parameter:', region);
      return [];
    }
    
    const { x, y, width, height } = region;
    
    // 驗證座標
    if (x < 0 || y < 0 || width <= 0 || height <= 0) {
      console.error('Invalid region coordinates:', region);
      return [];
    }
    
    if (x + width > fullImageWidth || y + height > fullImageHeight) {
      console.error('Region exceeds image boundaries:', {
        region,
        imageSize: { width: fullImageWidth, height: fullImageHeight }
      });
      // 調整到安全範圍內
      const safeWidth = Math.min(width, fullImageWidth - x);
      const safeHeight = Math.min(height, fullImageHeight - y);
      
      if (safeWidth <= 0 || safeHeight <= 0) {
        return [];
      }
      
      console.log('Adjusted to safe region:', { x, y, width: safeWidth, height: safeHeight });
    }
    
    // Step 1: 裁切區域
    const croppedImage = await sharp(imageBuffer)
      .extract({
        left: Math.floor(x),
        top: Math.floor(y),
        width: Math.floor(width),
        height: Math.floor(height)
      })
      .greyscale()
      .threshold(threshold)
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const { data, info } = croppedImage;
    const cropWidth = info.width;
    const cropHeight = info.height;
    
    // Step 2: 在裁切後的小圖中檢測橫線
    const lines = [];
    const processedRows = new Set();
    
    for (let cy = 0; cy < cropHeight; cy++) {
      if (processedRows.has(cy)) continue;
      
      let lineStart = null;
      let lineLength = 0;
      let gapCount = 0;
      const maxGap = 3;
      
      for (let cx = 0; cx < cropWidth; cx++) {
        const pixelIndex = cy * cropWidth + cx;
        const pixelValue = data[pixelIndex];
        const isBlack = pixelValue < 50;
        
        if (isBlack) {
          if (lineStart === null) {
            lineStart = cx;
          }
          lineLength++;
          gapCount = 0;
        } else {
          if (lineLength > 0) {
            gapCount++;
            
            if (gapCount > maxGap) {
              if (lineLength >= minLength) {
                const thickness = measureLineThickness(data, cropWidth, cropHeight, lineStart, cy, lineLength);
                
                if (thickness <= maxThickness) {
                  lines.push({
                    startX: lineStart,
                    endX: lineStart + lineLength,
                    y: cy,
                    length: lineLength,
                    thickness: thickness
                  });
                  
                  // 標記已處理的行
                  for (let ty = cy; ty < Math.min(cy + thickness, cropHeight); ty++) {
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
      
      // 處理行尾的線
      if (lineLength >= minLength) {
        const thickness = measureLineThickness(data, cropWidth, cropHeight, lineStart, cy, lineLength);
        
        if (thickness <= maxThickness) {
          lines.push({
            startX: lineStart,
            endX: lineStart + lineLength,
            y: cy,
            length: lineLength,
            thickness: thickness
          });
        }
      }
    }
    
    // Step 3: 去重（區域內可能有重複）
    const deduplicated = [];
    let lastY = -1000;
    const minYDistance = 5;
    
    lines.sort((a, b) => a.y - b.y);
    
    for (const line of lines) {
      if (Math.abs(line.y - lastY) > minYDistance) {
        deduplicated.push(line);
        lastY = line.y;
      }
    }
    
    return deduplicated;
    
  } catch (error) {
    console.error('Error detecting lines in region:', error);
    console.error('Region:', region);
    console.error('Error stack:', error.stack);
    return [];
  }
}

/**
 * 測量線條厚度
 */
function measureLineThickness(data, width, height, startX, startY, length) {
  let thickness = 1;
  
  for (let dy = 1; dy < 8; dy++) {
    const checkY = startY + dy;
    if (checkY >= height) break;
    
    let blackPixelCount = 0;
    const samplePoints = Math.min(8, length);
    
    for (let i = 0; i < samplePoints; i++) {
      const checkX = startX + Math.floor((length / samplePoints) * i);
      if (checkX >= width) continue;
      
      const pixelIndex = checkY * width + checkX;
      if (data[pixelIndex] < 50) {
        blackPixelCount++;
      }
    }
    
    if (blackPixelCount / samplePoints > 0.7) {
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