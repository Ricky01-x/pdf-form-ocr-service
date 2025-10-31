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
  
  // Step 3: 溫和過濾
  const filteredLines = filterLinesBalanced(lines, width, height);
  
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
 * 平衡過濾（不要太嚴格）
 */
function filterLinesBalanced(lines, imageWidth, imageHeight) {
  console.log(`  Starting balanced filtering...`);
  
  // Step 1: 只過濾明顯不合理的線
  let filtered = lines.filter(line => {
    // 過濾超短線（< 40 像素）
    if (line.length < 40) return false;
    
    // 過濾超長線（> 90% 頁寬，明顯是表格邊框）
    if (line.length > imageWidth * 0.9) return false;
    
    // 過濾頁面最頂端（前 8%，Logo 主要區域）
    if (line.y < imageHeight * 0.08) return false;
    
    // 過濾頁面最底端（後 3%）
    if (line.y > imageHeight * 0.97) return false;
    
    return true;
  });
  
  console.log(`  After basic filtering: ${filtered.length} lines`);
  
  // Step 2: 智能檢測 Logo 密集區域
  const densityMap = calculateLineDensity(filtered, imageHeight);
  const logoRegions = findDenseRegions(densityMap, imageHeight);
  
  if (logoRegions.length > 0) {
    console.log(`  Found ${logoRegions.length} dense regions (likely logos)`);
    logoRegions.forEach((region, i) => {
      console.log(`    Region ${i + 1}: Y ${region.startY.toFixed(0)} to ${region.endY.toFixed(0)}, density: ${region.density}`);
    });
    
    // 只移除密度極高的區域（> 15 條線/區塊）
    filtered = filtered.filter(line => {
      for (const region of logoRegions) {
        if (line.y >= region.startY && line.y <= region.endY && region.density > 15) {
          return false;
        }
      }
      return true;
    });
    
    console.log(`  After logo removal: ${filtered.length} lines`);
  }
  
  // Step 3: 去除重複（Y 座標非常接近的線）
  filtered.sort((a, b) => a.y - b.y);
  
  const deduplicated = [];
  let lastY = -1000;
  const minYDistance = 15; // 減少到 15 像素
  
  for (const line of filtered) {
    if (Math.abs(line.y - lastY) > minYDistance) {
      deduplicated.push(line);
      lastY = line.y;
    }
  }
  
  console.log(`  After deduplication: ${deduplicated.length} lines`);
  
  // Step 4: 移除明顯的異常值（長度異常短）
  if (deduplicated.length > 0) {
    const lengths = deduplicated.map(l => l.length).sort((a, b) => a - b);
    const medianLength = lengths[Math.floor(lengths.length / 2)];
    const minAcceptableLength = medianLength * 0.3; // 至少是中位數的 30%
    
    const final = deduplicated.filter(line => line.length >= minAcceptableLength);
    
    console.log(`  Median line length: ${medianLength.toFixed(0)}px`);
    console.log(`  Min acceptable: ${minAcceptableLength.toFixed(0)}px`);
    console.log(`  Final lines: ${final.length}`);
    
    return final;
  }
  
  return deduplicated;
}

/**
 * 計算線條密度分布
 */
function calculateLineDensity(lines, imageHeight) {
  const numBins = 20;
  const binHeight = imageHeight / numBins;
  const bins = new Array(numBins).fill(0);
  
  for (const line of lines) {
    const binIndex = Math.floor(line.y / binHeight);
    if (binIndex >= 0 && binIndex < numBins) {
      bins[binIndex]++;
    }
  }
  
  return bins.map((count, index) => ({
    binIndex: index,
    startY: index * binHeight,
    endY: (index + 1) * binHeight,
    density: count
  }));
}

/**
 * 找出密集區域
 */
function findDenseRegions(densityMap, imageHeight) {
  const regions = [];
  const threshold = 8; // 降低閾值：8 條線以上算密集
  
  for (let i = 0; i < Math.min(5, densityMap.length); i++) { // 只檢查前 25%
    const bin = densityMap[i];
    if (bin.density >= threshold) {
      // 合併相鄰的密集區塊
      let endBin = i;
      while (endBin < densityMap.length - 1 && densityMap[endBin + 1].density >= threshold / 2) {
        endBin++;
      }
      
      regions.push({
        startY: bin.startY,
        endY: densityMap[endBin].endY,
        density: bin.density
      });
      
      i = endBin; // 跳過已處理的區塊
    }
  }
  
  return regions;
}

module.exports = {
  detectHorizontalLines
};