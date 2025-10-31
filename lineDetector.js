const sharp = require('sharp');

/**
 * 檢測圖片中的水平線
 */
async function detectHorizontalLines(imageBuffer, options = {}) {
  const minLength = options.minLength || 30;
  const maxThickness = options.maxThickness || 3;
  const threshold = options.threshold || 50;
  
  // Step 1: 圖像預處理
  const { data, info } = await sharp(imageBuffer)
    .greyscale()
    .threshold(threshold)
    .raw()
    .toBuffer({ resolveWithObject: true });
  
  const { width, height } = info;
  
  console.log(`  Image size: ${width}x${height}px`);
  
  // Step 2: 逐行掃描檢測水平線
  const lines = [];
  const processedRows = new Set();
  
  for (let y = 0; y < height; y++) {
    if (processedRows.has(y)) continue;
    
    let lineStart = null;
    let lineLength = 0;
    let gapCount = 0;
    const maxGap = 5;
    
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
                lines.push({
                  startX: lineStart,
                  endX: lineStart + lineLength,
                  y: y,
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
  
  console.log(`  Raw lines detected: ${lines.length}`);
  
  // Step 3: 智能過濾
  const filteredLines = filterLinesIntelligent(lines, width, height);
  
  return filteredLines;
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
    const samplePoints = Math.min(10, length);
    
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

/**
 * 智能過濾線條（新版 - 專門處理 Logo 問題）
 */
function filterLinesIntelligent(lines, imageWidth, imageHeight) {
  console.log(`  Starting intelligent filtering...`);
  
  // Step 1: 基本過濾
  let filtered = lines.filter(line => {
    // 過濾太短的線（至少 60 像素）
    if (line.length < 60) return false;
    
    // 過濾太長的線（表格邊框，超過頁面 80%）
    if (line.length > imageWidth * 0.8) return false;
    
    // 過濾太接近頂部的線（前 15%，通常是 Logo 區域）
    if (line.y < imageHeight * 0.15) return false;
    
    // 過濾太接近底部的線（後 5%）
    if (line.y > imageHeight * 0.95) return false;
    
    // 過濾太靠左邊的線（前 10%）
    if (line.startX < imageWidth * 0.1) return false;
    
    // 過濾太靠右邊的線（後 10%）
    if (line.startX > imageWidth * 0.9) return false;
    
    return true;
  });
  
  console.log(`  After basic filtering: ${filtered.length} lines`);
  
  // Step 2: 檢測並移除 Logo 區域的密集線條
  const logoRegion = detectLogoRegion(filtered, imageHeight);
  
  if (logoRegion) {
    console.log(`  Detected logo region: Y ${logoRegion.startY} to ${logoRegion.endY}`);
    filtered = filtered.filter(line => {
      return line.y < logoRegion.startY || line.y > logoRegion.endY;
    });
    console.log(`  After logo removal: ${filtered.length} lines`);
  }
  
  // Step 3: 去除重複線條（Y 座標太接近）
  filtered.sort((a, b) => a.y - b.y);
  
  const deduplicated = [];
  let lastY = -1000;
  const minYDistance = 25; // 線條間最小距離（增加到 25 像素）
  
  for (const line of filtered) {
    if (Math.abs(line.y - lastY) > minYDistance) {
      deduplicated.push(line);
      lastY = line.y;
    }
  }
  
  console.log(`  After deduplication: ${deduplicated.length} lines`);
  
  // Step 4: 過濾異常短的線（相對長度）
  const avgLength = deduplicated.reduce((sum, line) => sum + line.length, 0) / deduplicated.length;
  const minRelativeLength = avgLength * 0.4; // 至少要平均長度的 40%
  
  const final = deduplicated.filter(line => line.length >= minRelativeLength);
  
  console.log(`  After relative length filtering: ${final.length} lines`);
  console.log(`  Average line length: ${avgLength.toFixed(0)}px, min threshold: ${minRelativeLength.toFixed(0)}px`);
  
  return final;
}

/**
 * 檢測 Logo 區域（線條密集的區域）
 */
function detectLogoRegion(lines, imageHeight) {
  // 將頁面分成 20 個區塊
  const numBins = 20;
  const binHeight = imageHeight / numBins;
  const bins = new Array(numBins).fill(0);
  
  // 計算每個區塊的線條密度
  for (const line of lines) {
    const binIndex = Math.floor(line.y / binHeight);
    if (binIndex >= 0 && binIndex < numBins) {
      bins[binIndex]++;
    }
  }
  
  // 找出密度最高的區塊
  let maxDensity = 0;
  let maxBinIndex = -1;
  
  for (let i = 0; i < Math.min(5, numBins); i++) { // 只檢查前 25%
    if (bins[i] > maxDensity) {
      maxDensity = bins[i];
      maxBinIndex = i;
    }
  }
  
  // 如果密度超過 10 條線，認為是 Logo 區域
  if (maxDensity > 10) {
    return {
      startY: maxBinIndex * binHeight,
      endY: (maxBinIndex + 2) * binHeight, // 包含相鄰區塊
      density: maxDensity
    };
  }
  
  return null;
}

module.exports = {
  detectHorizontalLines
};